# Testing Fuin (zec-sealed-bid-auction)

No mocks or stub RPCs. Proofs are real Groth16 proofs; chain reads go to lightwalletd
(testnet.zec.rocks) through `sba-verify`.

```sh
pnpm install && pnpm build && pnpm test
```

`pnpm test` builds `sba-verify` and the circuits and service packages first, so it passes on a fresh
clone. It needs network access (the service audit and mcp tests read live Zcash testnet through
testnet.zec.rocks) and takes about 10 minutes here: the live audits about 8 minutes (one of them scans
about 3,100 blocks), the mcp tests about 1.5 minutes, plus the Rust build (cold, a few minutes more).
CI (`.github/workflows/ci.yml`) runs the same `pnpm test` on GitHub. Last run: 25 Oct 2026, this
machine (cold Rust build, after `pnpm install --frozen-lockfile`): **85 passed, 0 failed, 2
skipped** (87 tests). Two audit tests read the seller's viewing key from the gitignored local demo state
(`.demo/`); where that state is absent (CI, a fresh clone, this run) they are skipped and say why.

| Suite | Network | What | Result |
|---|---|---|---|
| verifier (Rust) | none | memo decoding (text, empty, binary flagged), txid parsing, scan range bounds; a real Ironwood bundle built in-process that pays the auction key twice and another key once (both payments read, each with its own action index); `owns` with in-process keys | 6 passed |
| circuits `maxbid` | local | valid proof verifies and shows no losing bid; tampered winner / winning bid fails verification; no witness for a non-highest winner, a below-reserve bid, an altered opening, or a later slot claiming a tie | 6 passed |
| circuits `result` | local | `checkResult`: the honest result passes; a phantom winning bid in a spare slot verifies as a proof but is rejected; a left-out deposit fails unless declared unrevealed, and only valid deposits can be declared; another auction or reserve fails | 4 passed |
| service `auction` | local | memo format and **canonical commitments only** (a leading zero or a value ≥ the BN254 modulus is a memo mismatch); late, wrong-amount, memo-mismatch, other-auction, pending and duplicate deposits in chain order; `depositForCommitment`; altered and over-deposit reveals refused; winner, proof and payouts, each payout memo naming what it pays; **no sale** below the reserve (a reserve-0 proof, refunds minus their output fee, the forfeit to the seller), a forged no-sale fails, nothing revealed; a same-block tie goes to the lower txid; **capacity over revealed bids** (nine revealed: the 9th is refunded, a proof over another 8 fails; 8 junk deposits nobody can open do not stop an honest bid winning); an unrevealed deposit is declared and forfeited to the seller, hiding it fails; two payments in one transaction; the auction id hashes every term; **the seller's payout check**; **the ZIP-317 fee** (8 bids + 5 revealed duplicates fit; an unaffordable settlement is refused) | 20 passed |
| service `verifier` | local | **scan windows** (1..12001 is three windows with no gap or overlap; a stand-in `sba-verify` that refuses more than 5,000 blocks is called once per window) | 2 passed |
| service `reveal` | local | real X25519/ChaCha20-Poly1305 reveals: fit one memo, carry no bid, salt or address in the clear, open only with the reveal key or the bidder's ephemeral secret; reveals ingested from on-chain-shaped notes decide the auction; a reveal for another bidder's commitment is `wrong_commitment` (moved ciphertext `tampered`); tampered and other-key ciphertexts rejected; late, early and pending reveals; duplicates idempotent, a conflicting opening cannot replace the first; malformed, other-auction and unknown-deposit reveals; `auditReveals` catches a hidden, relabelled or contradictory reveal log | 8 passed |
| service `dispute` | local | real Ed25519 complaints over real sealed reveals: honest loser and winner "unfounded, paid in full"; upheld when a valid reveal is called tampered and its deposit declared unrevealed, or when the refund address got less than owed; rejected when forged, altered, opened with the wrong secret, naming another deposit, unanchored or anchored outside the window; a late reveal's complaint is unfounded; one paid deposit cannot mask an unpaid one on the same refund address; legacy memos summed per refund key; a complaint with no refund key is still verified; **a no-sale refund is owed minus its output fee**; **a deposit outside the proof is owed minus its output fee (legacy: in full)** | 12 passed |
| service `audit` | live testnet | Sale 001: passes with the `legacy` terms note and **ends "chain checks pass; payments not checked"**; a record hiding the late deposit fails with `NOT LISTED`; a record that understates the settlement height fails on the chain height. Sale 002: passes, two-payment transaction read as `valid` + `duplicate`, 5 reveal notes listed; a renamed auction fails the `terms` check; a hidden or relabelled reveal fails; **a record naming an unrelated post-window transaction as its settlement no longer ends "all checks pass"** (scans about 3,100 blocks); **with the local demo seller key the real settlement pays 135,000 and a swapped one fails "seller received 0 zat, owed 135000"**; **a reveal mined after the record's `scannedTo` is a note, and a `scannedTo` inside the window fails**; the winner's complaint is unfounded and paid in full, fails on the height when the record names a transaction mined before the window, and is upheld (received 0, owed 5,000) when it names one mined after it. **Sale 003: passes with bound terms, `scannedTo`, the duplicate and forfeit declared and the no-key complaint unfounded; with the local demo seller key the winning bid and the 195,000 zat forfeit are confirmed and the run ends "all checks pass"** | 10 passed, 2 skipped |
| mcp | live testnet | real MCP client: tools listed; `auction_status` finds the recorded deposits by scanning; `verify_result` holds on all three sales (**Sale 003: nothing after the record, no sale null**) and fails, naming the mismatch, on a record with an understated settlement height **or a `scannedTo` inside the reveal window**; `bid` refuses out-of-range bids, names missing settings, refuses the closed live auction, refuses 151/182/217-character refund addresses before reading any setting, refuses a card whose id does not hash its terms (or is legacy), fails before any wallet call when the openings folder cannot be written, and keeps the opening marked "send failed, may still be mined" when the send fails; `reveal` refuses outside the window and reports an opening with no deposit for its commitment; `complain` refuses outside the window and publishes no viewing key unless asked, then refuses the bidding wallet as the refund wallet | 17 passed |
| **total** | | | **85 passed, 0 failed, 2 skipped** |

MCP `bid`'s advisory `capacity_note` (8 or more valid deposits already on chain) has no live test: it
would need eight funded deposits in one auction. The capacity rule itself is covered by the `auction`
tests. The no-sale path has no live run: it is covered by unit tests with real proofs.

## Live testnet run, Sale 001 (`pnpm --filter @sba/service testnet-run`)

Recorded in `deployments/testnet.json`; see the README tables. Each rule was exercised on-chain:
three valid bids, then a wrong amount, a memo mismatch, a duplicate and a late deposit, all
classified from the auction's incoming viewing key. An altered reveal was refused. One settlement
followed, with each of its 7 outputs checked by the recipient's own viewing key. Every transaction
was Ironwood-only. The run was recorded at `58c2393`; the record later gained `openHeight`,
`outcome.unrevealed` (`[]`) and `blockTimes`, read from the chain, which the scanning audit needs.

## Live testnet run, Sale 002 (`pnpm --filter @sba/mcp reveal-run`)

Recorded in `deployments/testnet-reveal.json`; see the README tables. Each bidder ran as its own
`sba-mcp` process (own wallet, own openings folder) and bid and revealed through the MCP tools,
driven by the script (it sets the amounts; no language model chose a bid). The
auctioneer read every opening from the sealed reveal notes on chain. Exercised on chain: a
transaction paying the auction twice (valid + duplicate, both refunded), a reveal pointed at another
bidder's deposit (`wrong_commitment`), a late reveal, a never-revealed deposit (`unrevealed`), and
the winner's complaint (unfounded). Settlement: 5 outputs, each matched by its recipient's key; every
transaction Ironwood-only. A first attempt was abandoned when lightwalletd transmission failures
held its deposits past its close; its four payments show up in Sale 002 as memo mismatches.

## Live testnet run, Sale 003 (`SBA_SALE=003 pnpm --filter @sba/mcp reveal-run`)

Recorded in `deployments/testnet-sale003.json`, under the current rules: an auction id bound to every
term, the same three script-driven `sba-mcp` bidders, a two-payment transaction (its duplicate refunded
minus its 5,000 zat output fee), a wrong-commitment reveal, a late reveal, a never-revealed deposit
forfeited to the seller (195,000 zat, memo `forfeit:<deposit>`), tagged settlement memos, `scannedTo`,
and the winner's complaint filed through MCP `complain` without a refund key (unfounded). Settlement: 6
outputs, each matched by its recipient's key; every transaction Ironwood-only. The first attempt at
the decide step stopped because lightwalletd served the late reveal before its compact block (the
scan missed it); the run resumed from its state file and `reveal-run` now rescans until the late
reveal shows. Outputs of its live audits (public, and with the seller's key) are kept with the e2e
reports outside the repository.

## Audit (`pnpm --filter @sba/service run audit [record] [complaint.json ...]`)

Reads the settlement's block height from the chain and fails unless it equals the record's and comes
after the close (or reveal window). Says whether the auction id is the hash of every term on the card
(`bound`, a failure on mismatch, or `! terms: legacy` for Sales 001 and 002, whose ids hash only the
name). Scans the auction's blocks, open height to that chain height (in windows of at most 5,000
blocks), with only the auction's incoming viewing key, so the deposit list comes from the chain, not
from the record. Fails if a deposit on chain up to the record's `scannedTo` is not in the record, or a
listed one is not on chain; notes mined after `scannedTo` (late, so they cannot change the outcome) are
printed as notes. Re-classifies every deposit, verifies the MaxBid proof
and runs `checkResult` (or checks a no-sale outcome), and checks every transaction is Ironwood-only.
With `SBA_SELLER_UIVK` it checks the seller received the winning bid and every forfeit. With `SBA_AUDIT_UIVK` set to a
recipient's key it also decrypts that recipient's settlement outputs and labels each by its memo
(seller, change, refund or forfeit of a deposit). On an auction with the reveal channel it also scans
for reveal notes and checks the record's reveal log. Each complaint file is checked against the chain
(anchor in the dispute window counted from the mined settlement height, the reveal it opens, its
signature, the record, and the settlement read with the refund key if the complaint carries one);
an upheld complaint, or a refund key shared by complaints that was paid less than they are owed in
total, is a failure that names what went wrong. Prints the failures, or `all checks pass` only when the
seller's payout was checked; otherwise `chain checks pass; payments not checked` (or `payments partly
checked` when complaints checked their own refunds).

## Dashboard and landing (browser)

Covered by the end-to-end suite below, in Google Chrome at 1280×800 and 375×812, plus a masthead
sweep from 641 to 1040 px. Screenshots, videos and traces of every test are written to
`e2e/test-results/` and the HTML report to `e2e/playwright-report/` (both gitignored; run
`pnpm test:e2e` to produce them).

## End-to-end in Google Chrome (`pnpm test:e2e`)

`e2e/` is a pnpm workspace package (root `pnpm install` installs Playwright) and a Playwright suite
run in the installed Google Chrome (`channel: 'chrome'`; install Google Chrome first) at 1280×800 and
375×812, with video, trace and screenshots. `e2e/stack.sh` runs `pnpm build:site` and serves `site/`
exactly as GitHub Pages does, the landing at `/` and the saleroom at `/saleroom/`, from one server on
127.0.0.1:4180 (`FUIN_PORT` to change it). It refuses a port another process holds, records its PID,
stops it afterwards, and also stops it when the build or a readiness check fails.
`FUIN_LANDING` / `FUIN_SALEROOM` point the suite at another copy, such as the Pages URLs. Every test
fails on a console error, an uncaught exception or a failed same-origin request.

| Spec | Tests per viewport | What it covers |
|---|---|---|
| `landing.spec.ts` | 23 | **the one-screen landing (4):** headline, subline, two buttons, the envelope stage opening the winner (and open at once under reduced motion), no txids or block ranges, the proof numbers (3 sale records, this file's unit/live total), the Live / Setup required strip, the evidence link, footer CTA and links. **`evidence.html` (19), the full catalogue moved from the landing on Oct 25:** Sale 003 cover facts and the script-driven MCP bidders, clock, envelope reveal and reduced motion, anchors, CTAs (the saleroom opens and holds) and skip link, Sale 003 lot cards vs `testnet-sale003.json` (forfeit and duplicate wording), reveal notes and the no-key complaint, provenance ledger, Sale 002's section vs `testnet-reveal.json`, Sale 001's section vs `testnet.json`, a sweep that no "agent" claim is left, conditions and condition report, prior art with sources, record links, the saleroom section (hosted link and local route), masthead sweep 641-1040 px, footer, every line of the page's audit log found in a live run of the exact command it shows, Setup required without `sba-verify` |
| `saleroom.spec.ts` | 27 | three sale tabs, `?sale=002` and `?sale=001`; for **each sale**: header, timeline and clock, verify (vk hash, proof, slots, winner), both tamper buttons, filters, lot cards, provenance; Sales 003 and 002 reveal notes; Sales 003 and 002 complaints (digest computed in the tab = the anchor memo read live with `sba-verify tx`, verdict = a live audit run, whose last line is not "all checks pass"); viewing-key disclosure; controls labelled log and the catalogue link; reduced motion; missing or altered verification key |

Run on 25 Oct 2026: desktop 50 passed, mobile 50 passed, 0 failed (100 in 4.4 min). Live testnet is
re-read each run by the landing's audit log (Sale 003) and the Sales 003 and 002 complaints and anchors.
