# Audited repair for Laura Osorio's pending

Restore the confirmed original product through an application-level repair. Production execution remains operator-controlled and must never use manual SQL.

## Specs

1. **S1** — "pero corrigamos eso directo dsde aca que no vuelva a pasar ya garantizamos que n ovuelve a salir"
2. **S2** — The repair targets pending `cmw15djdt00ph01qsk9oqssrp`, replacing current product `cmw15hzoy00pt01qs7m2g73b8` with original product `cmtvwdmrw00ce01nxpuzhebl8` (`CITIVITAE 1000 MG X 10 SOBRES`, Orion `A33731`) while preserving quantity `2`.
3. **S3** — The repair is dry-run by default, requires explicit apply confirmation and production host guard, is transactional, row-locked, idempotent, and writes `pending.update` audit as `admin@ilasesorias.com` in the same transaction.
4. **S4** — The repair aborts without mutation when identity, quantity, lifecycle, supply state, actor, or target product differs from the reviewed production state.

## Tasks

- **T1** — S2-S4 — Add RED PostgreSQL and wrapper contract tests. Route: parent inline. Outcome: done (6/6 focused PostgreSQL tests and wrapper contract green). Commit: pending.
- **T2** — S1-S4 — Implement the narrow repair service, CLI, manifest, and guarded wrapper. Route: parent inline. Outcome: done (independent verifier PASS S1-S4). Commit: pending.
- **T3** — S1-S4 — Run focused checks, full suite, independent high-risk verification, and native assessment/review when due. Route: parent + verifier. Outcome: done (all checks green; independent verifier PASS S1-S4; native review unavailable after provider 429 and missing package binary). Commit: pending.
- **T4** — S1-S4 — Publish through issue #330 / PR, merge after green CI, then provide dry-run/apply/replay production commands. Route: parent. Commit: pending.

## Log

- **L1** — "pero corrigamos eso directo dsde aca que no vuelva a pasar ya garantizamos que n ovuelve a salir"
- **L2** — Production evidence: current product is ATODER `cmw15hzoy00pt01qs7m2g73b8`; target is active CITIVITAE `cmtvwdmrw00ce01nxpuzhebl8`, Orion `A33731`; reservations, allocations, originated missing items, and deliveries are all zero.
- **L3** — User selected `admin@ilasesorias.com` as the audited repair actor.
- **L4** — 2026-11-05 production apply of 2bb35960 blocked with "El código Orion del producto actual cambió." Pending stayed ATODER `cmw15hzoy00pt01qs7m2g73b8`, name unchanged, Orion now `A33915` (canonical rename after the manifest was written). Nothing was written. Expected current Orion updated from null to A33915. Target CITIVITAE A33731 was not reported as drifted.
