# Corrective verification, 26 Oct 2026

All 187 former FAIL rows remain `FIXED-PENDING-REVERIFY`; none was promoted to PASS.
The 324 expected-result cells, 124 existing PASS rows and 13 UNTESTED rows are unchanged.
The circuit, zkey and recorded audit final line are unchanged.

Product fixes:

- Sale 001's displayed audit command now explicitly names its record. All three sales name `SBA_SELLER_UIVK` in the seller-payment instructions.
- The skip link is present in the initial HTML, before React mounts, and `#main` can receive focus. The standalone dashboard's Catalogue points to the landing host; nested builds retain `../`. `VITE_CATALOGUE_URL` can explicitly configure another deployment. Dev still omits the production-only Catalogue link; the test now checks that contract.
- JSON parsing stays inside the running key step, so malformed HTTP 200 content displays its parsing error and every later check says it did not run.
- Sale changes reset the viewing-key disclosure. Obsolete complaint-hash promises cannot replace the selected sale's digest.

Coverage fixes:

`e2e/tests/audit-contract.spec.ts` adds 33 cases per viewport. It checks the previously omitted copy,
assets, animation delays/reload/reduced-motion/fallback states, record details, exact final log line,
keyboard navigation, direct/reloaded/unknown sale routes, timers, busy actions, delayed sale changes,
filter/disclosure isolation, the explicitly labelled browser-only empty catalogue, error recovery and
responsive bounds. Existing saleroom checks now assert filtered LOT numbers, amounts, action suffixes,
canonical commitments, reserve status, privacy wording, empty slots and all three enabled actions.
The automatic health fixture rejects GitHub fetches on load and external verification calls, and
permits only the exact intentionally injected HTTP status at the verification-key path.

Final commands (installed Google Chrome, one worker, no retries, 1280×800 and 375×812):

```sh
pnpm build:site
pnpm --filter @sba/circuits --filter @sba/service build
# Static site served from site/ on 127.0.0.1:4283; Vite dev on 127.0.0.1:5178.
cd e2e
FUIN_PORT=4283 pnpm exec playwright test tests/audit-contract.spec.ts tests/landing.spec.ts tests/saleroom.spec.ts --grep-invert 'complaint:|provenance log:' --reporter=line
FUIN_PORT=4283 FUIN_SALEROOM=http://127.0.0.1:5178/ FUIN_DEV=1 pnpm exec playwright test tests/saleroom.spec.ts tests/audit-contract.spec.ts --grep-invert 'complaint:|audit landing|audit envelope|audit reduced envelope|audit evidence|audit full layout.*4283|audit static' --reporter=line
```

The final built run passed **160 / 160** in 3.4 minutes: [built.txt](built.txt).
The final dev run passed **88 / 88** in 1.7 minutes: [dev.txt](dev.txt).
After the final dev-specific harness changes, the affected built-route checks were rerun with the
stricter status-specific health fixture: **12 / 12 passed** in 12.8 seconds,
[built-final-harness.txt](built-final-harness.txt).
Six compressed screenshots show the local landing, evidence and saleroom at both widths; each is
below 200 KB. Screenshots were visually inspected in addition to the browser assertions.

The existing three live complaint/log cases per viewport were excluded from this corrective run;
their previous chain evidence is retained, and an independent full-plan re-verification is still due.
The expanded complete browser suite contains 166 cases. Successful verification uses the real
published records, proofs and verification key. Only the explicitly specified failure/empty-state
cases alter browser inputs; they do not stand in for successful verification or chain data.
The missing-Rust preflight uses a nonexistent verifier path, reads no complaint document and confirms
`Setup required: SBA_VERIFY_BIN`; static pages and in-browser proof verification remain available.
No unexpected console/page/network errors occurred in the selected passing runs. The deliberate
404/503 responses are the only allowed HTTP error responses.

No send, reveal-run, testnet-run, wallet access, deployment or push was performed. Heavy runs used
`grokbot/tools/heavy-slot.sh`; only the processes started for this task were stopped afterward.
`UI-V-004` requires the owner to deploy the source fix before the live standalone URL can be re-verified.
