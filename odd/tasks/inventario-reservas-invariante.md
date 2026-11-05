# Inventory reservation invariant

Issue: #332. Branch: `fix/inventario-reservas-invariante`.
Canonicalize physical stock and pending reservations before production resumes.

## Specs

1. **S1** — “Corrección completa ahora”.
2. **S2** — “Unificar creación, recepción, reservas, entregas, cancelaciones y datos históricos antes de volver a operar.”
3. **S3** — The approved #332 contract is authoritative: batch quantity is physical total; reservations are a subset; delivery consumes both; release preserves physical stock; every ready claim has batch-ledger coverage; unsupported legacy claims are reconciled transactionally.
4. **S4** — Historical repair is audited, transactional, idempotent, dry-run by default, host-guarded, explicit-confirmation gated, and replayable as `noop`; production receives no manual SQL updates.
5. **S5** — Availability copy distinguishes a real warehouse-arrival event from stock automatically reserved for a pending registration.
6. **S6** — Verification uses real PostgreSQL and covers creation, reception, cancellation, product correction, delivery, adjustment, concurrency, legacy repair, rollback, and replay.
7. **S7** — “continua hazlo bien no quiero que vuelva a sucede y que se corriga correctamente y me explicas que paso como y porque y como lo corregis”.

## Tasks

- [x] **T1** — S1-S3 — Map every stock/reservation mutation and freeze the canonical invariant. Route: parent + bounded explorer. Commit: pending.
- [x] **T2** — S2-S3,S6 — Add RED PostgreSQL tests for creation, reception, release, correction, delivery, adjustment, and concurrency. Route: parent. Commit: pending.
- [x] **T3** — S2-S3 — Implement the unified runtime reservation model. Route: parent. Commit: bde8c8ab.
- [ ] **T4** — S3-S4,S6 — Add RED repair tests and implement audited legacy reconciliation with dry-run/apply/replay. Route: parent. Commit: c418bec9 (+ follow-up fixes, see L15).
- [x] **T5** — S5-S6 — Correct availability/arrival copy and its public-interface tests. Route: parent. Commit: 992ab623.
- **T6** — S1-S6 — Run focused and full verification, LSP diagnostics, differential checks where shared behavior is touched, and independent high-risk verification. Route: parent + verifier. Commit: pending.
- **T7** — S1-S6 — Open PR, pass CI, resolve review threads, and squash merge. Route: parent. Commit: pending.
- [x] **T9** — S2-S3,S6 — Runtime fixes from Judgment Day: JD-A-002/JD-B-002 (product correction with deliveries), JD-A-008/JD-B-003 (quantity correction must resize the claim), JD-A-003/JD-B-001 (batch lock order), JD-A-004 (adjustment/reconcile locking), JD-A-005 ("Stock vendible" must exclude live reservations). Route: parent (workers failed: provider unavailable). Commit: see L19.
- [x] **T10** — S3-S4,S6 — Repair fixes from Judgment Day: JD-A-001 (legacy cutover so post-deploy receptions are never restored), JD-A-007/JD-B-005 (window and blockers), JD-A-006/JD-B-004 (report legacy units lost by old releases), JD-B-006 (fingerprint covers the full post-state). Route: parent (workers failed: provider unavailable). Commit: 1661830e.
- **T8** — S3-S4,S6 — Deploy, run dry-run → reviewed apply → replay, and verify the four incident pendings plus global invariants. Route: parent/operator. Commit: production evidence.

## Log

- **L1** — “Corrección completa ahora”.
- **L2** — Production evidence supplied on 2026-11-04 showed MINOXITEN pending counters totaling 5, reservation ledger totaling 3, batch quantity 3, and an audited entry of 4 units allocating two missing-item rows.
- **L3** — Issue #332 was created with `type:bug` and `status:approved` after no existing issue covered the complete invariant.
- **L4** — T1 proved the conflict across creation, reception, release, delivery, adjustment, and reconciliation. Canonical transition table: physical batch quantity is unchanged by reserve/release, increased by receipt, decreased by delivery, and replaced only by an audited physical adjustment.
- **L5** — RED observed on 2026-11-04: 4 failures across 24 focused PostgreSQL tests. Creation produced no reservation rows, reception reduced a 6-unit physical batch to 0, and a 2-unit delivery left the physical batch unchanged at 100.
- **L6** — “continua hazlo bien no quiero que vuelva a sucede y que se corriga correctamente y me explicas que paso como y porque y como lo corregis”.
- **L8** — Runtime GREEN: 72/72 focused PostgreSQL tests. Creation reserves per batch; reception no longer subtracts batches (`reserveReceivedBatchQuantity` deleted) and links the entry to its batch; delivery subtracts the physical batch under product→batch→pending lock order; invoicing uses live reservations, not counters; cancel/partial-close/reconcile keep ready = delivered + live reserved.
- **L9** — Legacy repair needs production scope: read-only diagnosis `docs/sql/diagnostico-invariante-reservas.sql` classifies live reservations as RECEPTION (subtracted by legacy code) or SOFT. GLAUCOMED script left no residue (it subtracted, delivered and deleted its rows).
- **L10** — Full validation after T3/T5: typecheck 0, lint 0, unit 3126/3126, PostgreSQL 685/687 (the two `laboratory-*` failures pre-exist on main). Wording RED 7 → GREEN 701/701.
- **L11** — Slice boundary: runtime + wording reached 588 authored lines. Delivery strategy: runtime (bde8c8ab) must not deploy without the T4 legacy repair, so T3+T4+T5 ship as one PR with separate commits; the repair commit stays its own reviewable unit.
- **L12** — Production read-only diagnosis (2026-11-04): live reservations = 10 rows / 14 units, all RECEPTION, all open, no product mismatch; 7 open pendings with 9 uncovered units; 0 post-10-31 deliveries without reception evidence.
- **L13** — T4 built: `inventory-invariant-repair.service.ts` restores RECEPTION reservation units to their batches (audited `inventory.invariant.restore`), rebuilds promises per affected product oldest-first via reconcile (now releases all promises before rebuilding, so a newer pending cannot starve an older one), fails closed on SOFT/terminal/mismatch/adjusted-after rows, dry-run executes and rolls back, apply requires the dry-run fingerprint, marker command makes replays noop. 8/8 PostgreSQL tests; RED not observed before implementation, so a mutation (restore increment 0) was run and the MINOXITEN test failed as expected. Wrapper with host guard + confirmation + fingerprint; contract test OK. Runbook: `docs/runbook-reparacion-invariante-inventario.md` (no deliveries between deploy and apply).
- **L14** — “listo continua de manera correcta yt evita que vuelva a pasar y arregla todo que no falle el ya llego y que lo hagas para evitar los fallos”.
- **L15** — Independent verifier (task mw2u6s0t-2-nbrp) failed at start with a provider error (0 tool calls); not retried per policy. Inline review found and fixed, test-first: (a) product correction left the pending in ESPERANDO with no reservation and no missing item, invisible to reception — now claims like registration (RED 2 → GREEN 3/3, `pending-product-change-claims.pg.test.ts`); (b) delivery derived reservedInventoryQuantity from the stored counter — now from the live locked ledger; (c) reconcile set missing-item quantity to the deficit ignoring partial receipts — now received + deficit (mutation shows 2 vs 4); (d) repair lists open pendings with demand and no missing item (excluding discarded) for human review, never auto-creates them.
- **L16** — Verifier retry (task mw2w52k5-3-icm1) failed the same way (provider error, 0 tool calls). User decision: publish the PR and run the independent review on it before merge.
- **L17** — Delivery: one PR with commit-by-commit review guide instead of chained PRs. Reason: merging the runtime alone would leave main unsafe to deploy (legacy subtracted batches); runtime and repair must ship together. Commit d4b693d9 holds the review follow-ups.
- **L18** — Judgment Day on PR #333 head 87e75935 (judges mw3jy1qc-2-qo7u, mw3jy1cb-1-8x6t). Frozen severe: JD-A-001 (repair restores post-deploy reception reservations a second time: the 5s allocation evidence cannot tell legacy from new rows) and JD-A-002 (product correction ignores deliveredQuantity). Warnings fixed anyway by user instruction (“arregla todo”): JD-A-003=JD-B-001, JD-A-004, JD-A-005, JD-A-006=JD-B-004, JD-A-007=JD-B-005, JD-A-008=JD-B-003, JD-B-006.
- **L19** — JD fixes done inline after both workers failed at start (provider unavailable). Repair (1661830e): cutover migration `20261105120000_inventory_invariant_cutover`, legacy-only restore/blockers, lost-units report, post-state fingerprint, runbook with web stopped; RED 5 → GREEN 14/14. Runtime: one `reclaimPendingStock` for product and quantity corrections (owed = quantity − delivered; one open missing item, received kept); claim released before the new quantity is written (lowering it used to fail on `pendings_quantities_check`); canonical batch lock order everywhere and correction locks product → batches → pending; adjustment locks product FOR UPDATE and reconcile locks batches + open pendings before reading; "Stock vendible" = physical − live reservations. RED 4 → GREEN; deterministic deadlock test fails with the old id order and passes with the fix. Validation: tsc 0, lint 0, unit 3126/3126, PostgreSQL 710/712 (laboratory-* pre-existing).
- **L7** — First runtime GREEN: 29/29 focused PostgreSQL tests pass for creation, reception, delivery, cancellation and product correction under the physical-total invariant.
