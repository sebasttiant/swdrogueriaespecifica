# Management missing-items pagination

## Intent and scope
Only `/revision-faltantes` management queue: maximum 50 rows, visible range, Anterior/Siguiente above and below, wrapping controls, preserve scope/demora/bulk and clarify page-local headings. Keep other consumers, report inbox, inventory/purchase semantics, exports, schema and global pagination unchanged. Prepare a clean branch from `origin/main` for the user to deploy on the test VPS. No production deployment.

## Tasks
- [x] T1 — Delegated worker implemented isolated qpage pagination and regression tests.
- [x] T2 — Independent verifier completed code inspection, focused tests, full suite, typecheck and production build. No blocking correctness/security finding.
- [ ] T3 — Real PostgreSQL traversal and authenticated HTTP rendering passed; exact visual acceptance at 320px, 375px and desktop will be completed by the user on the test VPS. No visual pass claimed yet.
- [x] T4 — Pagination work separated from mixed commit `631b8e81` onto current-main base `b63276ef`; focused tests, typecheck, full suite and production build passed. Commit and publication evidence are recorded below.

## Acceptance and evidence
Stable mocked 195-record dataset traverses 50/50/50/45 without overlap. Shared predicates match count/list across all three management scopes. Invalid and out-of-range pages normalized/clamped; filters/bulk retained; filter changes reset page. Service identity redaction and attribution retained; non-opt-in consumers retain cursor contract.
`pnpm --filter @drogueria/web test 'app/(dashboard)/revision-faltantes/page.test.ts' server/services/missing-item.service.test.ts server/repositories/missing-item.repository.test.ts features/faltantes/missing-management-pagination.test.ts features/faltantes/missing-queue-board.test.ts features/faltantes/missing-list.test.ts`: 182 tests / 6 files passed on current main.
`pnpm typecheck`: passed on current main.
`pnpm test`: 3177 tests / 198 files passed on current main.
`pnpm --filter @drogueria/web build`: passed on Next.js 16.4.1; `/revision-faltantes` remains dynamic.
A disposable PostgreSQL database with 120 actual shelf-origin `FALTANTE` rows traversed 50/50/20 without overlap. Invalid pages normalized to page 1; page 999 clamped to page 3. Actionable/default scope returned 120; ordered/discarded returned 0. `demora=8h` returned 70 rows as 50/20 without overlap and preserved the filter in pagination links.
Authenticated HTTP requests returned 200 and rendered `Mostrando 1 – 50 de 120`, `51 – 100 de 120`, and `101 – 120 de 120`; invalid/out-of-range pages rendered normalized/clamped ranges. Every checked response rendered two pagination navs, confirming top and bottom controls structurally. Repository and package fingerprints remained unchanged; the temporary server and database container were removed.
Responsive wrapping classes and authenticated markup were inspected, but exact browser layout at 320px, 375px and desktop was not available. Offset pages and separate count/read queries are not snapshots under concurrent edits.

## Routing and delivery
The original branch `feat/missing-management-pagination` is based on old restore work and contains mixed WIP commit `631b8e81`. Delivery was rebuilt in isolated worktree `feat/missing-management-pagination-vps` from local `origin/main` at `b63276ef`; the preliminary fetch failed because GitHub DNS was unavailable, so publication must verify the remote before push. Only pagination code, its tests and this task document belong in the delivery unit.
Work-unit commits: `5e078253` (repository/service page contract), `d2224060` (pagination UI and cursor regressions), and `6ab293ac` (management route wiring and delivery evidence).
RDD native assess/inspect was unavailable during implementation: package-local-binary-missing; no lineage or receipt, no native approval claimed. Independent verifier fallback completed.
Node 22.22.3 warns against required >=24.18.0 <25 despite successful checks. The first T3 setup attempt triggered an automatic dependency refresh, then stopped before tests; Git remained clean. One explicitly authorized bounded retry reused the prepared dependencies without further package mutation and completed the PostgreSQL/HTTP checks.

## Next step
Commit and push `feat/missing-management-pagination-vps`, then deploy that exact full SHA on the test VPS with `BRANCH=feat/missing-management-pagination-vps`, `EXPECTED_SHA=<full SHA>`, the exact test hostname in `DEPLOY_TARGET`, and `SWITCH_BRANCH=1`. Perform visual acceptance at 320px, 375px and desktop there. Do not deploy production.

## Log
- L1 — "monta todo y yo lo despliego en e lvps de pruebas y miramos"
