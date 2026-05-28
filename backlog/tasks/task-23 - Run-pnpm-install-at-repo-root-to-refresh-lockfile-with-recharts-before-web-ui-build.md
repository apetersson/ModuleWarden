---
id: TASK-23
title: >-
  Run pnpm install at repo root to refresh lockfile with recharts before web-ui
  build
status: In Progress
assignee:
  - ademczuk
created_date: '2026-05-28 19:05'
updated_date: '2026-05-28 19:10'
labels:
  - web-ui
  - saturday-morning
dependencies: []
priority: high
ordinal: 39000
---

## Implementation Plan

<!-- SECTION:PLAN:BEGIN -->
Run pnpm install at repo root to refresh pnpm-lock.yaml with the new recharts dependency from packages/web-ui/package.json (^2.13.0, added in 492c7fd). Verify lockfile contains recharts. Confirm web-ui builds with pnpm --filter @modulewarden/web-ui build (build step is non-blocking; lockfile sync is the actual unblocker for TASK-6).
<!-- SECTION:PLAN:END -->
