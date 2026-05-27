export type Verdict = 'allow' | 'block' | 'quarantine';

export type JobType =
  | 'package-review'
  | 'upstream-subscription-poll'
  | 'audit-container-exec'
  | 'model-escalation'
  | 're-audit-campaign'
  | 'evidence-post-process'
  | 'verdaccio-promotion';

export interface PackageIdentity {
  name: string;
  version: string;
  registrySource: string;
  tarballHash: string;
}

export interface AuditContext {
  packageIdentity: PackageIdentity;
  predecessorVersion: string | null;
  predecessorHash: string | null;
  trigger: 'preflight' | 'subscription' | 'manual' | 're-audit';
}

export interface Decision {
  verdict: Verdict;
  reasonSummary: string;
  predecessorVersion: string | null;
  predecessorHash: string | null;
  promptVersions: string[];
  modelProfile: string;
  scores: Record<string, number>;
  evidenceReferences: string[];
  piSessionId: string | null;
  piRunId: string | null;
  actorType: 'agent' | 'admin';
}

export interface Override {
  adminIdentity: string;
  scope: string;
  reason: string;
  timestamp: string;
  supersedesDecisionId: string;
}

export type ProjectGraphState = 'importing' | 'auditing' | 'ready';

export interface JobPayloads {
  'package-review': {
    packageName: string;
    packageVersion: string;
    tarballHash: string;
    auditContext: string;
    idempotencyKey: string;
  };
  'upstream-subscription-poll': {
    packageName: string;
  };
  'audit-container-exec': {
    reviewJobId: string;
    packageName: string;
    packageVersion: string;
    tarballHash: string;
    predecessorHash: string | null;
    auditContext: string;
  };
  'model-escalation': {
    reviewJobId: string;
    evidenceBundleId: string;
  };
  're-audit-campaign': {
    campaignId: string;
    reason: string;
  };
  'evidence-post-process': {
    auditRunId: string;
    evidenceBundleId: string;
  };
  'verdaccio-promotion': {
    decisionId: string;
    packageName: string;
    packageVersion: string;
    tarballHash: string;
  };
}

export interface WorkerConfig {
  concurrency: Record<JobType, number>;
  retryPolicy: {
    maxRetries: number;
    backoffMs: number;
    timeoutMs: number;
  };
}
