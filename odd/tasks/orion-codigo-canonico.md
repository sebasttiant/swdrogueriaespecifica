# Orion canonical code (WINDOW 1)

Objective: stop splitting one Orion product into multiple catalog rows; typing any spelling of a code must resolve the same identity. Branch: `feat/orion-codigo-canonico`. Delivery: `ask-on-risk`. Runner: `pnpm --filter @drogueria/web test` (+ focused domain tests).

## Specs

- S1: "normalize on capture and look up by numeric core · Root cause fix. Typing 20956 must find a-20956/SKU20956/A-20956."
- S2: "Must deploy BEFORE renaming history or the" (lookup by variants must ship before any bulk rename of stored codes).
- S3: PROBIOESEENS incident evidence — image with Orion `31972` shows "Ya llegó a bodega" / "Listo para facturar"; image with `a-31972` shows "Sin stock"; warehouse did not mark arrival; Orion ERP stock was zero.
- S4: Canonical stored form is `A` + digits (as Orion shows). Non-convention codes stay as typed (trimmed only).
- S5: Same numeric core with different spellings is the SAME Orion identity for NOOP / conflict detection; the system must not create a second row.
- S6: When several catalog rows already share one numeric core, do not auto-pick a survivor; surface conflict for a human (repair tool / explicit choice).

## Tasks

- T1 S1,S4,S5 — Domain `orion-code` + `normalizeOrionCode` canonical on capture — inline — done — commit `a5b85090` / PR #323 / issue #322
- T2 S1,S2,S5,S6 — Variant lookup wired into identity holder checks + product search — inline — done — same commit
- T3 S2 — Dry-run normalization CLI (rename only; no merge) + package/compose entry — inline — done — same commit (not applied in prod)
- T4 S3 — Document diagnostic SQL/commands for false "Ya llegó a bodega" — inline — done

## Log

- L1: Necesito que me ayudes a validar la falla... producto ya llego sin marcarlo... mira las imagenes... transcripcion... comando en el servidor... analices engram busques y valides y continues la mejora y dejar el software operativo...
- L2: Root cause verified in code: `claimableStockForPending` on pending create sets `DISPONIBLE_COMPLETO` when that productId has free batch stock; `arrivalNotice` maps that to "Ya llegó a bodega". Not a warehouse click. Duplicate Orion spellings (31972 vs a-31972) explain image 9 vs 10.
- L3: WINDOW 1 code completed in worktree `orion-canonico`: normalize on capture, variant lookup in `findProductByIdentity` / capture holders / `listProducts`, NOOP on same numeric core, `repair-codes` compose target + `db:normalize:orion`. Focused tests 70/70 GREEN. No commit/PR yet — waiting for Sebastián. Prod web was stopped for maintenance; restart current image restores ops WITHOUT this fix until deploy.
