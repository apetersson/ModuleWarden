# Ralph Loop: Complete TASK-1.12 (Admin Dashboard)

Build the full admin visibility dashboard. Current iteration: Dashboard API read models + endpoints.

## Plan
1. Define dashboard read model types in shared package
2. Create dashboard API endpoints (GET /admin/dashboard, GET /admin/audit-runs, GET /admin/audit-run/:id, GET /admin/evidence/:id, GET /admin/queue-stats)
3. Wire API tests for dashboard read models
4. Replace stub QueuePage with real API-backed component
5. Replace stub StatusPage with real API-backed component
6. Add evidence viewer + admin override UI
7. Add auth redaction
8. E2E tests

## Checklist
- [ ] Dashboard read model types defined
- [ ] Dashboard API endpoints implemented
- [ ] API tests pass
- [ ] Web UI loads real data from API
- [ ] Full test suite passes

## Verification
- All tests pass
- Typecheck clean
- Dashboard shows real data
