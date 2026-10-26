# Fresh browser re-verification — 26 Oct 2026

These are new runs against source commit `5465277`, with the test-only adjustments described below.
The earlier `audit/fixes-t23/README.md` results were not used to promote rows.
Installed Google Chrome **155.0.8059.85**, channel `chrome`, one worker, retries **0**, no grep
filters: desktop **1280×800**, mobile **375×812** (DPR 2). No case was skipped or flaky.
Source and test hashes are in [context.json](context.json).

| Run | Desktop pass / fail | Mobile pass / fail | Total pass / fail | Duration | List output |
|---|---:|---:|---:|---:|---|
| Full built site: landing, saleroom, audit-contract | 83 / 0 | 83 / 0 | 166 / 0 | 6.1 min | [built.txt](built.txt) |
| Initial full dev: saleroom, audit-contract | 58 / 2 | 58 / 2 | 116 / 4 | 5.8 min | [dev.txt](dev.txt) |
| Live landing + nested saleroom | 50 / 0 | 50 / 0 | 100 / 0 | 6.1 min | [live-nested.txt](live-nested.txt) |
| Live standalone saleroom | 26 / 1 | 26 / 1 | 52 / 2 | 3.2 min | [live-standalone.txt](live-standalone.txt) |
| Final built audit-contract + focused checks | 36 / 0 | 36 / 0 | 72 / 0 | 1.4 min | [built-contract-final.txt](built-contract-final.txt) |
| Final full dev + focused checks | 63 / 0 | 63 / 0 | 126 / 0 | 4.2 min | [dev-final.txt](dev-final.txt) |

The six runs executed **638 cases: 632 passed, six failed**. Four initial harness failures were
resolved and freshly rerun; the other two require the standalone deployment. No retry concealed
an initial failure. Each list file has a matching JSON result; [summary.json](summary.json) and
[final-local-summary.json](final-local-summary.json) retain the original reporter counts and times.

## Failures and test changes

The initial dev run's four failures were the hero/footer landing CTA test, at both viewports:
expected `http://127.0.0.1:5178/`, received `http://127.0.0.1:4284/saleroom/`.
The built landing correctly links to its own nested saleroom. The harness incorrectly reused
`FUIN_SALEROOM` as its expected CTA destination when that setting separately targeted Vite.
`audit-contract.spec.ts` now derives the exact CTA destination from `FUIN_LANDING`. It retains
the selected Sale 003, four successful checks and automatic console/request health assertions.
The fresh final built and dev runs passed those cases at both viewports.

`reverify.spec.ts` adds three cases per viewport: literal bogus/004/empty fallback queries with
record, lots and proof; the sole selected tab and labelled panel after every sale switch; and the
full Sale 003 5,000-zat forfeit-fee and Sale 002 historical non-refund wording. Both local routes
passed all six focused cases. No product code, circuit or audit CLI output was changed.

The two standalone failures are the navigation test at both viewports: after clicking Catalogue,
expected `https://fuin-landing.vercel.app/`, received `https://fuin-dashboard.vercel.app/`.
**UI-V-004 is UNTESTED:** needs a deploy of the current dashboard to
https://fuin-dashboard.vercel.app; this audit must not deploy. The other 52 standalone cases passed.

[failures.json](failures.json) retains exact failure messages and resolutions. All six failure
screenshots are JPEGs in [failures/](failures/), individually below 200,000 bytes. Raw traces,
videos, PNGs and browser snapshots remain outside `audit/`; no viewing keys were copied to evidence.

## Commands and process ownership

The unchanged heavy-slot script was used for each serialized phase, with release registered in
the enclosing shell's EXIT trap:

```sh
slot_script='/Volumes/Extreme SSD/Projects/grokbot/tools/heavy-slot.sh'
trap '"$slot_script" release fuin-reverify' EXIT
"$slot_script" acquire fuin-reverify
```

The previous owner's slot was allowed to finish and release; it was never deleted by this task.
Dependencies were installed with `pnpm install --frozen-lockfile`. The existing built verifier was
reused via `SBA_VERIFY_BIN` (path and SHA-256 in `context.json`); no Rust command ran. The fresh
worktree lacked circuits/service build outputs, so the complaint-test dependencies were built once:

```sh
export SBA_VERIFY_BIN='/Volumes/Extreme SSD/Projects/grokbot/projects/zec-sealed-bid-auction/packages/verifier/target/release/sba-verify'
pnpm build:site
pnpm --filter @sba/circuits --filter @sba/service build
cd e2e
FUIN_PORT=4284 ./stack.sh
FUIN_PORT=4284 npx playwright test tests/landing.spec.ts tests/saleroom.spec.ts tests/audit-contract.spec.ts
```

Port 4180 belonged to another process, so 4284 was used. From the repository root, started:

```sh
pnpm --filter @sba/dashboard dev --host 127.0.0.1 --port 5178
```

From `e2e`, while keeping the built landing available for landing/evidence contract cases:

```sh
FUIN_PORT=4284 FUIN_SALEROOM=http://127.0.0.1:5178/ FUIN_DEV=1 npx playwright test tests/saleroom.spec.ts tests/audit-contract.spec.ts
```

The dev contract asserts Catalogue is absent. Owned dev PID/group **36004** and stack PID **85489**
were stopped before either live command. Both live targets were explicit, with no task-owned local
server running (the standalone phase keeps the hosted landing explicit for global setup):

```sh
FUIN_LANDING=https://fuin-landing.vercel.app/ FUIN_SALEROOM=https://fuin-landing.vercel.app/saleroom/ npx playwright test tests/landing.spec.ts tests/saleroom.spec.ts
FUIN_LANDING=https://fuin-landing.vercel.app/ FUIN_SALEROOM=https://fuin-dashboard.vercel.app/ npx playwright test tests/saleroom.spec.ts
```

After the live phase and test correction, the slot was reacquired with the same EXIT trap. The
built stack and dev server were restarted for the final local runs:

```sh
FUIN_PORT=4284 npx playwright test tests/audit-contract.spec.ts tests/reverify.spec.ts
FUIN_PORT=4284 FUIN_SALEROOM=http://127.0.0.1:5178/ FUIN_DEV=1 npx playwright test tests/saleroom.spec.ts tests/audit-contract.spec.ts tests/reverify.spec.ts
```

All Playwright commands also used `--reporter=list,json --retries=0`, a per-run
`PLAYWRIGHT_JSON_OUTPUT_FILE`, and `--output=/tmp/fuin-t24-browser-artifacts/<run>`.
The final owned dev PID/group **36207** and stack PID **6880** were stopped; both heavy-slot traps
completed. No process belonging to another owner was stopped.

## Audit decisions and limits

[row-evidence.json](row-evidence.json) maps every one of the **187** pending rows to fresh
case titles, source locations, project/viewport and results. **186 become PASS**; UI-V-004 becomes
UNTESTED with the deployment dependency. Only pending rows changed. All 357 expected-result cells,
the 157 original PASS rows and the 13 original UNTESTED rows were preserved unchanged.
Final `AUDIT.md`: **343 PASS, 14 UNTESTED, zero FAIL or pending**.

The original UNTESTED dependencies remain: CLI-024 needs the remaining scan-wrapper unit case in
a separately permitted run; CLI-044 needs the seller key from prohibited demo state;
CLI-045–CLI-049 and MCP-036–MCP-041 need funded sends/wallet operations. This task performed none.

No mocks or stubs stand in for the checked sales. Successful verification uses the real published
records, proofs and verification key; complaint digests/anchors and displayed provenance audit
lines were checked against fresh read-only testnet reads. The explicitly named key-failure,
malformed-response and browser-only empty-catalogue cases remain deliberate negative fixtures.
The health fixture reported no unexpected console/page errors or failed same-origin requests;
only the specifically injected 404/503 responses were allowed.

No cargo, pnpm test, send, reveal-run, testnet-run, direct complaint JSON access, `.env`, `.demo`,
wallet access, key printing, deployment or push was performed. The circuit and audit CLI final line
are unchanged. `audit/` remains below 15 MB.
