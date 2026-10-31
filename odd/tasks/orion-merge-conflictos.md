# Orion same-core merge (WINDOW 3)

Objective: merge catalog rows that share one Orion numeric core under different spellings into a single active product with canonical `A{digits}`. Branch: `feat/orion-merge-conflictos`. Delivery: `ask-on-risk`. Runner: `pnpm --filter @drogueria/web test`.

## Specs

- S1: "WINDOW 3 — merge de los 139 (solo dry-run limpio; lo que trabe → mañana)"
- S2: Survivor keeps stock; never move lots. Block when more than one copy has stock > 0.
- S3: Losers release Orion code, open pendings/missing reassign to survivor, losers deactivate with needsReview.
- S4: Dry-run by default; `--apply` writes. Compose target `repair-merges`.
- S5: PROBIO `31972` + `a-31972` is in scope; phantom stock on survivor is #321 after merge.

## Tasks

- T1 S2 — Domain survivor heuristic + tests — inline — done
- T2 S1,S3,S4 — Merge service + CLI + compose/Dockerfile — inline — done
- T3 S1 — Issue + PR + deploy paste-ready — pending
- T4 S5 — After apply: inventory adjust phantom stock (#321) — pending

## Log

- L1: pero entonces arranca y sigue y arregla para que no vuelva a psar y se corriga todos los fallos
- L2: WINDOW 1+2 live; repair:identidad blocks distinct Orion codes so WINDOW 3 needs dedicated merge-by-core.
