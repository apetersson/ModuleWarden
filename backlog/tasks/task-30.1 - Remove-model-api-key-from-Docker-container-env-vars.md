---
id: TASK-30.1
title: 'Remove model API key from Docker container environment variables'
status: To Do
labels:
  - security
  - critical
---

## Finding
S-1 (CRITICAL): `MW_MODEL_ENDPOINT_API_KEY` is passed as a Docker environment variable to every disposable audit container. The container has recorded-open egress, meaning any package under audit or attacker who compromises the container can exfiltrate the API key.

**Fix:** Use an internal proxy/token-broker service on the host that the container calls via the RPC bridge. Generate short-lived, single-run JWTs bound to the audit run ID.

**Files:** `packages/worker/src/services/container-runner.ts`
