---
id: TASK-1.18
title: Implement DAG-linearised audit ordering for dependency-aware reviews
status: Open
assignee:
  - '@agent-k'
created_date: '2026-05-29 09:30'
updated_date: '2026-05-29 09:30'
labels:
  - dag
  - scheduling
  - ordering
  - v1
  - queue
dependencies:
  - TASK-1.3
  - TASK-1.4
  - TASK-1.5
  - TASK-1.16
parent_task_id: TASK-1
priority: high
ordinal: 5400
---

## Description

<!-- SECTION:DESCRIPTION:BEGIN -->
When a package like `vite` is requested for audit, all its transitive dependencies
are currently enqueued in parallel as independent `package-review` jobs. This means
a package may be audited *before* its own dependencies have been reviewed, which
defeats the purpose of dependency-aware security gating.

A package should only enter `RUNNING` audit after **all** its transitive dependencies
have been reviewed and received an `ALLOW` (or have been promoted). This requires:

1. **DAG resolution** — Recursively resolve the full transitive dependency tree from
   upstream npm packuments, handling circular dependencies gracefully (cycle detection
   with deduplication).
2. **Topological sort** — Linearise the DAG so leaf packages (those with no further
   dependencies) are audited first, then their dependents, and finally the root package.
3. **Audit pipeline** — A new database model (`AuditPipeline` + `AuditPipelineStep`)
   that tracks each package's position in the ordered queue and its dependency status.
4. **Eligibility gating** — A package-review job only proceeds to `audit-container-exec`
   when its `AuditPipelineStep` status is `READY` (all deps are `ALLOWED`). Until then
   it remains `PENDING`/`QUEUED`.
5. **Cascade on completion** — When a step completes with `ALLOW`, the scheduler checks
   which downstream steps now have all their deps satisfied and flips them to `READY`,
   enqueuing their reviews.

Circular dependencies (`A ↔ B`) must be detected and handled gracefully — either
treat the strongly connected component as one audit unit, or mark with a clear blocked/
cyclic state and surface it in the queue-status URL messaging.

This eliminates wasted audits on packages whose dependencies are later blocked, and
gives developers a reliable ordering guarantee: *"when my package is audited, all its
dependencies have already been cleared."*
<!-- SECTION:DESCRIPTION:END -->

## Acceptance Criteria
<!-- AC:BEGIN -->
- [ ] #1 A new `AuditPipeline` + `AuditPipelineStep` model is added to the Prisma schema
       with fields: root package identity, linear order, dependency list, and step status
       (`PENDING → READY → RUNNING → ALLOWED/BLOCKED/QUARANTINED/FAILED`).
- [ ] #2 A `resolveDependencyDag(rootPackage, rootVersion)` utility recursively fetches
       upstream packuments, resolves the full transitive tree (with depth limit), detects
       and deduplicates cycles, and returns a topologically sorted list with edge metadata.
- [ ] #3 The packument endpoint, instead of enqueuing raw `package-review` jobs for deps,
       enqueues a new `audit-pipeline-schedule` job that builds the pipeline from the DAG.
- [ ] #4 A new `audit-pipeline-unblock` job, triggered when a step completes ALLOW,
       evaluates downstream steps and flips eligible ones to `READY`, enqueuing their
       `package-review`.
- [ ] #5 The `package-review` handler checks `AuditPipelineStep.status` before enqueuing
       `audit-container-exec` — if the step is not `READY`, the job is deferred (re-queued
       with backoff) instead of starting an audit.
- [ ] #6 Cyclic dependencies are detected during DAG resolution. Cycles are broken by
       removing the back-edge (the edge that would create the cycle), and the audit
       proceeds linearly. A note is recorded on the pipeline step for operator visibility.
- [ ] #7 The `GET /queue/:package` endpoint reflects pipeline progress: which steps are
       pending/ready/running/done, and total/remaining counts.
- [ ] #8 Worker concurrency for `package-review` is adjusted so that at most
       `concurrency` steps are in `RUNNING` state simultaneously, ensuring the topological
       order is faithfully followed under load.
- [ ] #9 A test fixture verifies `A → B → C` ordering (C depends on B depends on A —
       A is audited first, then B, then C).
- [ ] #10 A test fixture verifies `A ↔ B` cyclic dependency is handled without deadlock
        (cycle detected, back-edge broken, both audited linearly).
<!-- AC:END -->

## Technical Design

### Prisma Schema Additions

```prisma
model AuditPipeline {
  id                 String   @id @default(uuid())
  rootPackageName    String
  rootPackageVersion String
  tarballHash        String
  totalSteps         Int
  status             AuditPipelineStatus @default(PENDING)
  createdAt          DateTime @default(now())
  updatedAt          DateTime @updatedAt

  steps AuditPipelineStep[]
}

enum AuditPipelineStatus {
  PENDING
  IN_PROGRESS
  COMPLETED
  FAILED
}

model AuditPipelineStep {
  id              String   @id @default(uuid())
  pipelineId      String
  pipeline        AuditPipeline @relation(fields: [pipelineId], references: [id])
  packageName     String
  packageVersion  String
  tarballHash     String
  depth           Int
  dependsOn       String   @default("")  // comma-separated package@version refs
  linearOrder     Int
  status          AuditStepStatus @default(PENDING)
  reviewJobId     String?
  createdAt       DateTime @default(now())
  updatedAt       DateTime @updatedAt

  @@index([pipelineId, linearOrder])
  @@index([pipelineId, status])
}

enum AuditStepStatus {
  PENDING
  READY
  RUNNING
  ALLOWED
  BLOCKED
  QUARANTINED
  FAILED
}
```

### DAG Resolver

A new utility `packages/shared/src/services/dag-resolver.ts`:

```
function resolveDependencyDag(
  rootPackage: string,
  rootVersion: string,
  upstreamFetch: (name: string) => Promise<NpmPackument | null>
): Promise<{
  steps: Array<{
    packageName: string;
    packageVersion: string;
    tarballHash: string;
    depth: number;
    dependsOn: string[];        // package@version refs
    linearOrder: number;
  }>;
  cycles: Array<{ from: string; to: string }>;  // detected back-edges
}>
```

**Algorithm:**
1. Fetch upstream packument for root package
2. Get latest version's dependencies (dependencies, devDependencies, peerDependencies)
3. For each dependency, recursively fetch its packument
4. Track visited nodes as `packageName@version` to detect cycles
5. If a node is already in the current path → cycle detected → record back-edge, skip
6. Build adjacency list → topological sort (Kahn's algorithm) ignoring back-edges
7. Assign linear order based on position in sorted list
8. Return ordered steps + detected cycles

**Note on version resolution:** For each dependency with a semver range (e.g. `^6.0.0`),
we resolve the exact latest version from the upstream packument's `dist-tags.latest` or
the most recent non-prerelease version. This is intentional — the DAG represents the
specific versions that will be audited, not ranges.

### Job Flow

```
Packument endpoint
  │  (no approved versions for root)
  ▼
enqueue `audit-pipeline-schedule` job
  │
  ▼
audit-pipeline-schedule handler
  │  1. resolveDependencyDag(rootPackage, rootVersion)
  │  2. CREATE AuditPipeline + AuditPipelineStep rows
  │  3. For steps with no deps (depth=0): SET status=READY, enqueue package-review
  │  4. All other steps: status=PENDING
  ▼
package-review handler (for each READY step)
  │  → checks AuditPipelineStep.status (must be READY)
  │  → creates ReviewJob, enqueues audit-container-exec as normal
  ▼
audit-container-exec completes → Decision created
  │  if verdict == ALLOW:
  │    → UPDATE AuditPipelineStep.status = ALLOWED
  │    → enqueue `audit-pipeline-unblock` for this step
  ▼
audit-pipeline-unblock handler
  │  1. Find all steps where dependsOn contains this completed step's package@version
  │  2. For each candidate: check if ALL steps in its dependsOn are ALLOWED
  │  3. If yes: SET status=READY, enqueue package-review
  │  4. If no: remain PENDING
  ▼
  ... cascade continues until root step is READY → audited → ALLOWED
```

### Cycle Handling

When a cycle is detected (`A → B → C → A`), the back-edge (`C → A`) is removed from the
dependency graph. The remaining graph is a DAG and is topologically sorted normally.
The cycle is recorded in the pipeline for operator visibility.

**Graceful degradation:** Since the cycle is broken by removing only the back-edge,
all packages in the cycle still get audited, just not in strict dependency order.
The audit result for packages in the cycle should note the detected circular dependency
so the reviewer can account for potential ordering effects.

### API Changes

**`GET /queue/:package`** — Extended response:
```json
{
  "package": "vite",
  "inQueue": true,
  "status": "in-progress",
  "pipeline": {
    "totalSteps": 12,
    "completedSteps": 5,
    "pendingSteps": 3,
    "readySteps": 1,
    "runningSteps": 1,
    "failedSteps": 0,
    "blockedSteps": 0,
    "cyclesDetected": 0
  },
  "message": "Package vite is in the audit pipeline. 5/12 steps completed..."
}
```

### Worker Concurrency

The `package-review` handler concurrency should be set to a small value (e.g. 2–4)
so steps are processed in order without overwhelming the audit runner. The
`audit-pipeline-unblock` handler should have concurrency 1 (serialise cascade).

## Verification

- **Unit test:** `resolveDependencyDag` with a known package returns correct topological order
- **Unit test:** `resolveDependencyDag` detects and breaks `A → B → A` cycle
- **Unit test:** `resolveDependencyDag` handles package with zero dependencies (returns just root)
- **Integration test:** Enqueue pipeline → verify steps created → leaf deps become READY first
- **E2E test:** `pnpm add -D vite` against local MW → vite should be last step in pipeline
- **Edge case:** Package with 100+ transitive deps → DAG resolves within timeout (10s)
- **Edge case:** Package where dep resolution fails (network error) → step marked FAILED, pipeline continues for other branches
