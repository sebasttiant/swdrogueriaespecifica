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
- [x] **T3** — S2-S3 — Implement the unified runtime reservation model. Route: parent. Commit: pending (full validation running).
- **T4** — S3-S4,S6 — Add RED repair tests and implement audited legacy reconciliation with dry-run/apply/replay. Route: parent. Commit: pending.
- **T5** — S5-S6 — Correct availability/arrival copy and its public-interface tests. Route: parent. Commit: pending.
- **T6** — S1-S6 — Run focused and full verification, LSP diagnostics, differential checks where shared behavior is touched, and independent high-risk verification. Route: parent + verifier. Commit: pending.
- **T7** — S1-S6 — Open PR, pass CI, resolve review threads, and squash merge. Route: parent. Commit: pending.
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
- **L7** — First runtime GREEN: 29/29 focused PostgreSQL tests pass for creation, reception, delivery, cancellation and product correction under the physical-total invariant.
