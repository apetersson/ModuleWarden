# Ralph Loop: Complete TASK-1.12 (Admin Dashboard)

Build the full admin visibility dashboard. Current iteration: Evidence viewer + detail views.

## Progress
- ✅ Dashboard read model types defined
- ✅ Dashboard API endpoints (dashboard, queue-stats, audit-run/:id)
- ✅ Kanban board with real Prisma data
- ✅ Error/loading/empty states
- ✅ Queue stats from real API
- ✅ Auto-refresh
- ACs 1-4, 13-14, 19-20 done (8/20)

## Current Iteration
1. Add evidence API endpoint GET /admin/evidence/:id
2. Add detail view component to web UI
3. Wire evidence viewer with real data
4. Add admin override form in UI

## Checklist
- [ ] Evidence API endpoint
- [ ] Detail view component
- [ ] Evidence inspection panel
- [ ] Admin override form
- [ ] Tests pass

## Verification
- All existing tests pass
- Typecheck clean across all packages
- Dashboard shows real data
