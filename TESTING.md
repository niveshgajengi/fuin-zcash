# Testing Fuin (zec-sealed-bid-auction)

No mocks or stub RPCs. Proofs are real Groth16 proofs; chain reads go to lightwalletd
(testnet.zec.rocks) through `sba-verify`.

```sh
pnpm install && pnpm build && pnpm test
```

`pnpm test` builds `sba-verify` and the circuits and service packages first, so it passes on a fresh
clone. Last run: 22 Oct 2026, this machine (the verifier's release build was already present, so
cargo reused it).

| Suite | Network | What | Result |
|---|---|---|---|
| verifier (Rust) | none | memo decoding (text, empty, binary flagged), txid parsing, scan range bounds; a real Ironwood bundle built in-process that pays the auction key twice and another key once (both payments read, each with its own action index); `owns` with in-process keys | 6 passed |
| circuits `maxbid` | local | valid proof verifies and shows no losing bid; tampered winner / winning bid fails verification; no witness for a non-highest winner, a below-reserve bid, an altered opening, or a later slot claiming a tie | 6 passed |
| circuits `result` | local | `checkResult`: the honest result passes; a phantom winning bid in a spare slot verifies as a proof but is rejected; a left-out deposit fails unless declared unrevealed, and only valid deposits can be declared; another auction or reserve fails | 4 passed |
| service `auction` | local | memo format; late, wrong-amount, memo-mismatch, other-auction, pending and duplicate deposits in chain order; `depositForCommitment`; altered and over-deposit reveals refused; winner, proof and payouts, **each payout memo naming what it pays**; no sale below the reserve; **a same-block tie goes to the lower txid**; **nine valid bids: the 9th is `over_capacity` and refunded, the proof verifies over 8, an uncapped record fails**; an unrevealed deposit is declared and **forfeited to the seller**, hiding it fails; two payments in one transaction (both compete; a same-commitment second payment is a refunded duplicate); **the auction id hashes every term (each of ten edits is a mismatch, a name-only id is legacy) and a 127-bit id fits the memos and a real proof** | 13 passed |
| service `reveal` | local | real X25519/ChaCha20-Poly1305 reveals: fit one memo, carry no bid, salt or address in the clear, open only with the reveal key or the bidder's ephemeral secret; reveals ingested from on-chain-shaped notes decide the auction; a reveal for another bidder's commitment is `wrong_commitment` (moved ciphertext `tampered`); tampered and other-key ciphertexts rejected; late, early and pending reveals; duplicates idempotent, a conflicting opening cannot replace the first; malformed, other-auction and unknown-deposit reveals; `auditReveals` catches a hidden, relabelled or contradictory reveal log | 8 passed |
| service `dispute` | local | real Ed25519 complaints over real sealed reveals: honest loser and winner "unfounded, paid in full"; upheld when a valid reveal is called tampered and its deposit declared unrevealed, or when the refund address got less than owed; rejected when forged, altered, opened with the wrong secret, naming another deposit, unanchored or anchored outside the window; a late reveal's complaint is unfounded; **one paid deposit cannot mask an unpaid one on the same refund address (tagged memos: upheld)**; **legacy memos: complaints sharing a refund key are summed (received 2,000,000, owed 4,000,000: upheld; both paid: paid in full)**; **a complaint with no refund key is still verified** (honoured, upheld when ignored, rejected when unanchored) | 10 passed |
| service `audit` | live testnet | Sale 001: passes with the `legacy` terms note; a record hiding the late deposit fails with `NOT LISTED`; **a record that understates the settlement height to stop the scan before the late deposit it hides fails on the chain height** (it passed before). Sale 002: passes, two-payment transaction read as `valid` + `duplicate`, 5 reveal notes listed; a record with a renamed auction fails the `terms` check; a record hiding the wrong-commitment reveal or calling the late reveal tampered fails; the winner's complaint is unfounded and paid in full (summed per refund key), fails on the height when the record names a transaction mined before the window, and is upheld (received 0, owed 5,000) when it names one mined after it | 7 passed |
| mcp | live testnet | real MCP client: tools listed; `auction_status` finds the recorded deposits by scanning; `verify_result` holds on both sales and **fails, naming the mismatch, on a record with an understated settlement height**; `bid` refuses out-of-range bids, names missing settings, refuses the closed live auction, **refuses 151/182/217-character refund addresses before reading any setting, refuses a card whose id does not hash its terms (or is legacy), fails before any wallet call when the openings folder cannot be written, and keeps the opening marked "send failed, may still be mined" when the send fails**; `reveal` refuses outside the window and **reports an opening with no deposit for its commitment**; `complain` refuses outside the window and **publishes no viewing key unless asked, then refuses the bidding wallet as the refund wallet** | 15 passed |
| **total** | | | **69 passed, 0 skipped** |

The capacity refusal in MCP `bid` (8 valid bids already on chain) has no live test: it would need
eight funded deposits in one auction. The rule itself is covered by the `auction` tests (`openSlots`).

## Live testnet run, Sale 001 (`pnpm --filter @sba/service testnet-run`)

Recorded in `deployments/testnet.json`; see the README tables. Each rule was exercised on-chain:
three valid bids, then a wrong amount, a memo mismatch, a duplicate and a late deposit, all
classified from the auction's incoming viewing key. An altered reveal was refused. One settlement
followed, with each of its 7 outputs checked by the recipient's own viewing key. Every transaction
was Ironwood-only. The run was recorded at `58c2393`; the record later gained `openHeight`,
`outcome.unrevealed` (`[]`) and `blockTimes`, read from the chain, which the scanning audit needs.

## Live testnet run, Sale 002 (`pnpm --filter @sba/mcp reveal-run`)

Recorded in `deployments/testnet-reveal.json`; see the README tables. Each bidder ran as its own
`sba-mcp` process (own wallet, own openings folder) and bid and revealed through the MCP tools. The
auctioneer read every opening from the sealed reveal notes on chain. Exercised on chain: a
transaction paying the auction twice (valid + duplicate, both refunded), a reveal pointed at another
bidder's deposit (`wrong_commitment`), a late reveal, a never-revealed deposit (`unrevealed`), and
the winner's complaint (unfounded). Settlement: 5 outputs, each matched by its recipient's key; every
transaction Ironwood-only. A first attempt was abandoned when lightwalletd transmission failures
held its deposits past its close; its four payments show up in Sale 002 as memo mismatches.

## Audit (`pnpm --filter @sba/service run audit [record] [complaint.json ...]`)

Reads the settlement's block height from the chain and fails unless it equals the record's and comes
after the close (or reveal window). Says whether the auction id is the hash of every term on the card
(`bound`, a failure on mismatch, or `! terms: legacy` for the two live sales, whose ids hash only the
name). Scans the auction's blocks, open height to that chain height, with only the auction's incoming
viewing key, so the deposit list comes from the chain, not from the record. Fails if a deposit on chain
is not in the record or the other way round. Re-classifies every deposit, verifies the MaxBid proof
and runs `checkResult`, and checks every transaction is Ironwood-only. With `SBA_AUDIT_UIVK` set to a
recipient's key it also decrypts that recipient's settlement outputs and labels each by its memo
(seller, change, refund or forfeit of a deposit). On an auction with the reveal channel it also scans
for reveal notes and checks the record's reveal log. Each complaint file is checked against the chain
(anchor in the dispute window counted from the mined settlement height, the reveal it opens, its
signature, the record, and the settlement read with the refund key if the complaint carries one);
an upheld complaint, or a refund key shared by complaints that was paid less than they are owed in
total, is a failure that names what went wrong. Prints `all checks pass` or the failures.

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
| `landing.spec.ts` | 17 | Sale 002 cover facts and MCP agents, clock, envelope reveal and reduced motion, anchors, CTAs (the saleroom opens and holds) and skip link, Sale 002 lot cards vs `testnet-reveal.json`, reveal notes and the anchored complaint, provenance ledger, Sale 001's section vs `testnet.json`, conditions and condition report, prior art with sources, record links, the saleroom section (hosted link and local route), masthead sweep 641-1040 px, footer, every line of the page's audit log found in a live run of the exact command it shows, Setup required without `sba-verify` |
| `saleroom.spec.ts` | 19 | sale tabs and `?sale=001`; for **each sale**: header, timeline and clock, verify (vk hash, proof, slots, winner), both tamper buttons, filters, lot cards, provenance; Sale 002 reveal notes; Sale 002 complaint (digest computed in the tab = the anchor memo read live with `sba-verify tx`, verdict = a live audit run); viewing-key disclosure; controls labelled log and the catalogue link; reduced motion; missing or altered verification key |

Run on 22 Oct 2026: desktop 36 passed, mobile 36 passed, 0 failed (72 in 3.4 min). Three tests
re-read live testnet each run: the landing's audit log, the Sale 002 complaint and its anchor.
