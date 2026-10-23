# Fuin — sealed-bid auctions on Zcash

> **Live:** landing https://fuin-landing.vercel.app (saleroom at https://fuin-landing.vercel.app/saleroom/),
> saleroom on its own at https://fuin-dashboard.vercel.app. Both are the static `pnpm build:site` output
> over the published records; the saleroom checks each sale's Groth16 result in the tab. There is no
> hosted backend: the chain re-read is the audit CLI (`pnpm --filter @sba/service run audit`).
>
> The code repository `https://github.com/nickthelegend/zec-sealed-bid-auction` is not public yet, so
> the page's GitHub links do not resolve today. Locally: `pnpm install && pnpm --filter @sba/dashboard dev`
> (the saleroom, http://localhost:5178), or `pnpm build:site` and serve `site/`. Once the repo is public,
> `.github/workflows/pages.yml` can also publish `pnpm build:site` to GitHub Pages and
> `.github/workflows/ci.yml` runs `pnpm test`.

Fuin (封印, Japanese for "seal") is a sealed-bid auction where every bid is a **shielded Zcash deposit of the same size**, its memo a
Poseidon commitment to the bid. After the close, each bidder **reveals through the chain**: a second
shielded note whose memo is its opening sealed to the auctioneer's reveal key. A **Groth16 proof (`MaxBid`)** shows which
commitment holds the highest bid at or above the reserve, so **only the winning bid is
published, unless a bidder files a complaint, which publishes its own bid**. One shielded transaction
then pays the seller and refunds every other revealed deposit, and each recipient checks its own
output with its own viewing key. In Sales 002 and 003 each bidder was a separate `sba-mcp` server
process with only its own wallet, driven over MCP by the `reveal-run` script: no language model chose
a bid. Zcash testnet, Ironwood pool, no transparent parts.

## What is new here

Sealed-bid ZK auctions are not new: zkSNARKs ran a blind-bid ZEC auction in September 2026
(reported 16,971 bids, cleared at 1.5 ZEC, settled through NEAR Intents), and Ethereum has many
ZK commit-reveal auctions. Fuin's differences:

1. **The deposits are the proof's public inputs.** Every bid is an equal shielded deposit whose memo is
   the commitment the MaxBid proof is about, so the result is tied to exactly the deposits on chain.
2. **Reveals are sealed inside shielded memos.** The chain timestamps each reveal against the window,
   and a dropped reveal is visible to anyone with the viewing key, without exposing the bid.
3. **Complaints are signed and anchored on chain, and the audit needs only the viewing key** (and an
   honest lightwalletd, which it trusts for block contents and heights) to show the record is
   complete up to the auctioneer's scan: no hidden deposit, no hidden reveal.

Sources and the comparison: [packages/docs](packages/docs/README.md#prior-art).

## Live run on Zcash testnet: Sale 003 (the current rules)

Auction `fuin-sale003-2026-10-22T21:24` (id 131728459360241149736859342020074215002, a hash of every
term on its card: the audit prints `✓ terms: the auction id is the hash of every term …`): deposit 0.002 TAZ, reserve 0.0005 TAZ, open at
block 4,530,264 (21:23:35 UTC), closes after block 4,530,294 (21:36:37 UTC), reveals until block
4,530,318 (21:48:06 UTC), complaints until 60 blocks after the settlement. Record:
[`deployments/testnet-sale003.json`](deployments/testnet-sale003.json). Run by
`SBA_SALE=003 pnpm --filter @sba/mcp reveal-run`: each bidder is its own `sba-mcp` process with only its
own wallet and openings folder, driven over MCP by the script, which sets the bid amounts. The
auctioneer learns the openings only from the reveal notes on chain.

| Deposit | Status | Tx | Block |
|---|---|---|---|
| bidder1 sealed bid (MCP `bid`) | valid | [`372e205c…`](https://testnet.zecblock.com/tx/372e205ce0e039f8219a3e2d099ba00c7b91d122ff28235ba266b4b2af137756) | 4530270 |
| bidder2 sealed bid (MCP `bid`) | **valid, wins (0.00135 TAZ)** | [`dc95f63d…`](https://testnet.zecblock.com/tx/dc95f63d121f62a0a8ef7f2b6505c8be5d1ef20748dec60c0fd580731014bafa) | 4530270 |
| bidder3: one transaction pays the auction twice | output 1 **valid**, output 2 **duplicate** (refunded minus its 5,000 zat output fee) | [`37e5c2df…`](https://testnet.zecblock.com/tx/37e5c2df32f94bed8fea377d72babbc03974bf415e8baf2511fbf28f6e2662d0) | 4530273 |
| bidder1's second bid, never revealed | **unrevealed: forfeited to the seller** (memo `forfeit:<deposit>`, 195,000 zat) | [`4462163e…`](https://testnet.zecblock.com/tx/4462163e69d228e6819f975c91cd0f1ccf66c2e2ae6a8ba9a4ee2377e92d1318) | 4530273 |

| Reveal note (1 zat, memo sealed to the reveal key) | Status | Tx | Block |
|---|---|---|---|
| bidder1 (MCP `reveal`) | accepted | [`de23eaa8…`](https://testnet.zecblock.com/tx/de23eaa8dcc112543914187b0bf645e0f9e06444cecfbad8e8403263982147a1) | 4530297 |
| bidder3 (MCP `reveal`, names `37e5c2df…:1`) | accepted | [`6b695300…`](https://testnet.zecblock.com/tx/6b695300bce63091bb95e30b7bc7fd1234b271e8a8cb8470c71730393f901bf3) | 4530306 |
| bidder2 (MCP `reveal`) | accepted | [`6e9e9cf9…`](https://testnet.zecblock.com/tx/6e9e9cf97c662997b116e7cb20c9709f14433bea8591ab4d3c8659f46f1f7f5a) | 4530306 |
| bidder3's opening pointed at bidder2's deposit | **wrong_commitment** | [`797e5467…`](https://testnet.zecblock.com/tx/797e5467cf766fe29f022797ee58be9ef3956aaf18793cc93be562fc0089c5a6) | 4530308 |
| bidder1's reveal re-sent after the window | **late** | [`a7688be1…`](https://testnet.zecblock.com/tx/a7688be186c6f41871ca2d52da85eb2c88da61437b98e13dae820126e5a1a075) | 4530326 |

**Settlement** [`2aefb90d…`](https://testnet.zecblock.com/tx/2aefb90dd67c42c9c674c4ef9eef5b5d8a3f0e734e2f146c6ff6c6a2d116e2ca)
(block 4,530,332, 21:52:20 UTC), 6 outputs, each memo naming what it pays, each matched by its
recipient's own viewing key: seller 135,000 (`seller`) + 195,000 (`forfeit:4462163e…`); bidder2 (winner)
5,000 change; bidder1 200,000; bidder3 200,000 (its bid) + 195,000 (its duplicate, minus its output fee).
The record says the auctioneer scanned to block 4,530,327 (`scannedTo`).

**Dispute:** bidder2, the winner, filed a complaint with MCP `complain` **without a refund key**, so it
publishes no viewing key (only its own opening, whose bid the proof already made public). Anchored at
[`3bc6631d…`](https://testnet.zecblock.com/tx/3bc6631dc915f660b260796273d562da44e9fb8db2c20a51a63a9acca5031e0a) (block 4,530,338).

**Audit** (`pnpm --filter @sba/service run audit deployments/testnet-sale003.json deployments/complaints/131728459360241149736859342020074215002-*.complaint.json`):
`✓ terms: the auction id is the hash of every term …`, every deposit and reveal note listed, the proof tied to the three revealed deposits,
the complaint `unfounded: reveal 6e9e9cf97c (block 4530306) was honoured; payment not checked: the
complaint gives no refund viewing key`, and the last line `chain checks pass; payments not checked`.
With the seller's incoming viewing key (`SBA_SELLER_UIVK`, kept in the gitignored demo state, not
published) the same audit prints `✓ seller received 135000 zat, owed 135000 (the winning bid)` and
`✓ forfeit of 4462163e69: seller received 195000 zat, owed 195000`, and ends `all checks pass`.

## Live run on Zcash testnet: Sale 002 (the reveal channel, before bound terms)

Auction `fuin-reveal-2026-10-21T18:43` (id 2582488456264710777): deposit 0.002 TAZ, reserve 0.0005 TAZ,
open at block 4,526,425 (18:42:10 UTC), closes after block 4,526,455 (18:57:03 UTC), reveals until
block 4,526,479 (19:04:48 UTC), complaints until 60 blocks after the settlement. Record:
[`deployments/testnet-reveal.json`](deployments/testnet-reveal.json). Run by
`pnpm --filter @sba/mcp reveal-run`: each bidder is its own `sba-mcp` process with only its own wallet
and openings folder, driven over MCP by the script. The auctioneer learns the openings only from the
reveal notes on chain.

| Deposit | Status | Tx | Block |
|---|---|---|---|
| bidder1 sealed bid (MCP `bid`) | valid | [`b7511ee8…`](https://testnet.zecblock.com/tx/b7511ee8836566793f9d687468293e2cae371273b265877aadf8dc410d8f846b) | 4526435 |
| bidder2 sealed bid (MCP `bid`) | **valid, wins (0.00135 TAZ)** | [`eb27d26d…`](https://testnet.zecblock.com/tx/eb27d26d5b30353021585db730bb90d3cd42e1158748a29a463103410569b768) | 4526435 |
| bidder3: one transaction pays the auction twice | output 0 **valid**, output 2 **duplicate** (both refunded) | [`9bb4098e…`](https://testnet.zecblock.com/tx/9bb4098e6428c1ce3ceac1d568c2a7875cb5ec9c22c30c86516f42f42b85e74c) | 4526438 |
| bidder2's second bid, never revealed | **unrevealed** (listed in the outcome; not refunded: this sale predates the forfeit-to-seller rule, so it stayed in the auction wallet) | [`19029d77…`](https://testnet.zecblock.com/tx/19029d771d63cb844ecd5746098b9eb02a9d6f50067563d1a5b22fe7d6a55e66) | 4526439 |
| 4 payments for an abandoned first attempt (below) | memo_mismatch (another auction's id) | `26f240bc…` ×2, `42ed60c8…`, `597be193…` | 4526425 |

| Reveal note (1 zat, memo sealed to the reveal key) | Status | Tx | Block |
|---|---|---|---|
| bidder1 (MCP `reveal`) | accepted | [`332fbc3c…`](https://testnet.zecblock.com/tx/332fbc3c408d9086da29a81e85132b6863bbffef58d0bf7569fdac3d1c489161) | 4526461 |
| bidder2 (MCP `reveal`) | accepted | [`07ec9dcd…`](https://testnet.zecblock.com/tx/07ec9dcd0814d5557ebf72932e1e4931c8ea944b5a8e87a641c2df45062d5553) | 4526464 |
| bidder3 (MCP `reveal`, names `9bb4098e…:0`) | accepted | [`80428975…`](https://testnet.zecblock.com/tx/804289759a1962c4b47197b82d55e5f53d28d8857a8085b8fccc09db10d71bd7) | 4526465 |
| bidder3's opening pointed at bidder2's deposit | **wrong_commitment** | [`ca315a6c…`](https://testnet.zecblock.com/tx/ca315a6cd6e05c01699dd2edd903caf7032ccfb1b8781ebd2de1fd8be7bf398e) | 4526465 |
| bidder1's reveal re-sent after the window | **late** | [`64de2707…`](https://testnet.zecblock.com/tx/64de2707bf22b32ee3e3f49489e6f96b2700e7dffaeaa76811f66a2e6584a29a) | 4526489 |

**Settlement** [`e84de386…`](https://testnet.zecblock.com/tx/e84de386e23fb514b7b329873d48a4b9316bc00984101f67b4167a9738746f5d)
(block 4,526,493, 19:10:08 UTC), 5 outputs, each matched by its recipient's own viewing key: seller
135,000 zat; bidder2 (winner) 5,000 change; bidder1 200,000; bidder3 200,000 + 200,000 (its bid and
the duplicate second payment). The proof's slots are the three revealed valid deposits; the
never-revealed one is declared `unrevealed`.

**Dispute:** bidder2, the winner (its bid is already public), filed a complaint with MCP `complain`,
anchored at [`f17193d5…`](https://testnet.zecblock.com/tx/f17193d5b7ccef68227e514ebd16c46bb28aa8d72f13a0937928ddc5a5d125fb)
(block 4,526,500; file: [`deployments/complaints/`](deployments/complaints)). The audit checks it
against the chain: `unfounded: reveal 07ec9dcd08 (block 4526464) was honoured`, and, summed per refund
key because this settlement's memos predate per-deposit tags, `paid in full: the refund address
received 5000 zat in settlement e84de386e2, owed 5000`. Pointed at a record that names another
transaction as the settlement, the audit fails only where a key can see the payment: with this
complaint file (its refund key reads 0 zat received) or with the seller's key. Without either it
cannot see payments at all and ends `chain checks pass; payments not checked`, not `all checks pass`.
That complaint was filed before the
refund key became opt-in, so it carries the incoming viewing key of bidder2's whole demo wallet
(also used in Sale 001): anyone can read every testnet payment to that wallet with it. The file stays
as it is because its digest is the one anchored on chain.

An earlier attempt (`fuin-reveal-2026-10-21T18:32`, auction 4193641125122731518) was abandoned:
lightwalletd transmission failures held three of its deposit transactions (four payments, 0.008 TAZ)
in the mempool past its close. They were mined in Sale 002's first block, where the audit reads them
as memo mismatches. They stay in the auction wallet and were not refunded: they came from the same
operator's demo bidder wallets, that attempt never settled, and no refund was sent, so there is no
refund txid. Under the current rules a memo mismatch is not a bid and stays where it is; an
unrevealed deposit goes to the seller, so the auctioneer gains nothing from a failed reveal.

## Live run on Zcash testnet: Sale 001 (before the reveal channel)

Auction `sba-testnet-2026-10-20T13:30` (id 6201170948318861529): deposit 0.02 TAZ, reserve
0.005 TAZ, open at block 4,522,258 (13:29:28 UTC), closes after block 4,522,278 (13:35:21 UTC). Full record, including the proof and the auction's incoming
viewing key: [`deployments/testnet.json`](deployments/testnet.json).

| Deposit | Service says | Tx | Block |
|---|---|---|---|
| bidder3 sealed bid | valid | [`06d12181…`](https://testnet.zecblock.com/tx/06d121813387444ca3ecc9720e73160b5b80645d9204c6c411e51cef3a190af1) | 4522268 |
| bidder1 sealed bid | valid | [`3d104727…`](https://testnet.zecblock.com/tx/3d104727044cf3164fc8df304d8ea95d3307ca90f0b0d4c21d994a1f350b0890) | 4522268 |
| bidder2 sealed bid | **valid, wins (0.0175 TAZ, opened by the proof)** | [`d910ebad…`](https://testnet.zecblock.com/tx/d910ebad413bf37c0ffb38f9032c61bb2d1b26ae54ca2422d3bdd2428bb3e1eb) | 4522268 |
| bidder2 deposits 0.005 TAZ instead of 0.02 | **wrong_amount** | [`29c23b7d…`](https://testnet.zecblock.com/tx/29c23b7d99be5dc70e8b505fef16628454a32aed8189cf87ad375fd5c95bf1dc) | 4522275 |
| bidder3 sends a memo that is not a bid | **memo_mismatch** | [`76b0b9bb…`](https://testnet.zecblock.com/tx/76b0b9bb76aee301fe5640fe7b1c3ff0746a999c743d9a4199dbf60375c39aa0) | 4522275 |
| bidder1 re-sends the same commitment | **duplicate** | [`c1b89ecd…`](https://testnet.zecblock.com/tx/c1b89ecd0d0bbbbeaecc86ca3d353788e8c2e1f71ac99d8be87154ddef8d6503) | 4522275 |
| bidder1 deposits after the close | **late** | [`c2e20a26…`](https://testnet.zecblock.com/tx/c2e20a26d0279db8c55d037068c83af5cef68a3227dab45f423ad622708387fc) | 4522283 |

An **altered reveal** (bidder3 claiming 0.019 TAZ with its real salt) was refused: the opening
matches no deposit commitment.

**Settlement** [`89bf60fd…`](https://testnet.zecblock.com/tx/89bf60fd905a1bdecea16c6ebe22018f1ddcbe0a43fca32c103c2b995e74820a)
(block 4,522,291, 13:42:50 UTC), one transaction with seven shielded outputs, each checked by the recipient's own
incoming viewing key:

| Recipient | Decrypted | Why |
|---|---|---|
| seller | 1,750,000 zat | the winning bid |
| bidder2 (winner) | 190,000 + 500,000 zat | deposit − bid − 60,000 fee budget; refund of its wrong-amount deposit |
| bidder1 | 2,000,000 × 3 | losing bid, duplicate and late deposits refunded |
| bidder3 | 2,000,000 zat | losing bid refunded |

The MaxBid proof verifies. Its first three public commitments are the three valid deposits' on-chain
memos in chain order, the other five are the empty commitment `Poseidon(auction_id, 0, 0)`, and the
winner slot is one of those deposits. Scanning blocks 4,522,258–4,522,291 with the auction's viewing
key finds exactly the seven deposits above, so the record leaves none out. Every deposit and the
settlement have only an Ironwood bundle. The losing bids appear nowhere public: not in the proof, on
the chain, in the run record or on the results page (the auctioneer's own gitignored working state
holds them, as an auctioneer must).

Not refunded: the memo-mismatch deposit (100,000 zat; no reveal can claim it) and whatever of the
60,000 zat fee budget the settlement fee did not use.

The audit prints `! terms: legacy` for Sales 001 and 002: their ids hash only the name, so their
close, reveal window and reserve are read from the record. Sale 003's id hashes every term.

## How it works

1. A bidder commits `Poseidon(auction_id, bid, salt)` and sends the fixed deposit with memo `sba1:<auction_id>:<commitment>`.
2. After the close, inside the reveal window, it sends a 1-zat note to the auction address whose memo
   is `sba1r:<auction_id>:<deposit>:<sealed>`: its bid, salt, refund address and a complaint key,
   encrypted to the auction's published X25519 reveal key. Anyone with the viewing key sees which
   deposit a reveal names and when, never what it says. The auctioneer decrypts reveals from the
   chain. Why a memo and not an HTTP endpoint: [packages/docs](packages/docs/README.md#why-reveal-by-memo-not-an-http-endpoint).
3. The auctioneer proves `MaxBid` over the first 8 revealed valid deposits in chain order (a deposit
   nobody reveals takes no slot; a ninth revealed bid is over capacity and refunded), lists any valid
   deposit that was never revealed, and settles in one shielded transaction whose memos name what
   each output pays (`seller`, `change:<deposit>`, `refund:<deposit>`, `forfeit:<deposit>`). An
   unrevealed deposit goes to the seller. If nothing valid is revealed, or the top bid is below the
   reserve, there is **no sale**: every revealed deposit is refunded minus its output fee, and a proof
   with reserve 0 shows the top bid is below the reserve.
4. Anyone with the auction's **incoming viewing key** reads the settlement's height from the chain,
   scans the auction's blocks up to it, reads every deposit's amount and memo (never a bid), and
   checks that the proof covers exactly those deposits (`checkResult`): no phantom bid in a spare
   slot, no deposit silently left out, the winner a real deposit. It also checks that the auction id
   is the hash of every term on the card (`checkTerms`), so no term changed after the bids. Notes
   mined after the auctioneer's scan (`scannedTo`) are reported, not failed: they are late. With the
   seller's viewing key it checks the seller's payout; without one it says payments were not checked.
   It trusts the lightwalletd it reads (`SBA_LWD_URL`) for block contents and heights.

Protocol, what each party learns, rules and trusted setup: [packages/docs](packages/docs/README.md).

## Packages

| Package | What |
|---|---|
| [`packages/circuits`](packages/circuits) | `MaxBid(8)` Circom/Groth16 circuit (6,800 constraints), local setup, helpers, `checkResult` (ties a proof to the deposits), 10 real-proof tests |
| [`packages/verifier`](packages/verifier) | `sba-verify` (Rust): decrypt transactions, or scan a block range, with an incoming viewing key via lightwalletd, as JSON (every output, with its index); address ownership; chain tip; block times |
| [`packages/service`](packages/service) | auction rules (bound terms, capacity, tagged settlement memos, forfeits), the reveal channel (seal, ingest, audit), complaints, zingo-cli wallet wrapper, settlement, the first live run, the chain-scanning audit |
| [`packages/mcp`](packages/mcp) | `sba-mcp`, the bidder's MCP server: `auction_status`, `bid` (refuses closed or unbound auctions and unrevealable refund addresses, warns at 8 valid deposits; saves the opening before sending), `reveal` (sealed note, refuses outside the window), `complain` (no viewing key unless asked), `verify_result`; `reveal-run`, the script that drove Sales 002 and 003 |
| [`packages/dashboard`](packages/dashboard) | the saleroom: all three sales in tabs (Sale 003 first), lot cards, live clock since the hammer, in-browser checks (vk hash, Groth16 proof, `checkResult`) with two tamper buttons on any sale; the reveal notes and complaints of Sales 003 and 002 |
| [`packages/docs`](packages/docs) | protocol, privacy table, rules (including no sale), trusted setup, a threshold-decryption sketch, what the audit trusts, prior art |
| [`packages/landing`](packages/landing) | one-page catalogue landing: Sale 003 and its MCP bidders, the sealed-envelope reveal, Sales 002 and 001, what is new |
| [`e2e`](e2e) | Playwright suite in Google Chrome over the landing and the saleroom as hosted (`pnpm test:e2e`) |

## Run it

**Two minutes, no Rust:** the saleroom re-checks all three sales' proofs in your browser.

```sh
pnpm install && pnpm --filter @sba/dashboard dev   # then open http://localhost:5178
```

Everything: Node 22+, pnpm 10, circom 2.2, Rust 1.89 (pinned in `packages/verifier`), Google Chrome
(for the e2e suite, which runs Playwright with `channel: 'chrome'`) and, for a live run, zingo-cli
(`SBA_ZINGO_CLI`, default `~/src/zingolib/target/release/zingo-cli`).

```sh
pnpm install
pnpm build                     # sba-verify (Rust) + TS packages
pnpm test                      # verifier 6 (Rust) + circuits 10 + service 54 + mcp 17 = 87; needs network (the service audit and mcp tests read live testnet) and takes about 10 min (audit ~8 min, mcp ~1.5 min, plus the Rust build)
pnpm build:site                # site/: the landing at /, the saleroom at /saleroom/, as GitHub Pages serves them
pnpm test:e2e                  # Playwright in Google Chrome over that site (92 tests: 46 per viewport; about 4 min; see TESTING.md)
# a new live auction with the reveal channel: wallets in .demo/wallets/{auction,bidder1,bidder2,bidder3,seller}, bidders funded
SBA_SALE=004 pnpm --filter @sba/mcp reveal-run   # writes deployments/testnet-sale004.json (Sale 003: SBA_SALE=003)
# re-check a published auction from the chain with only its incoming viewing key (and any complaint files)
pnpm --filter @sba/service run audit deployments/testnet-sale003.json deployments/complaints/131728459360241149736859342020074215002-*.complaint.json
SBA_SELLER_UIVK=<the seller's UIVK> pnpm --filter @sba/service run audit [record] [complaint.json ...]   # also checks the seller's payout
SBA_AUDIT_UIVK=<any recipient's UIVK, optional> pnpm --filter @sba/service run audit [record]           # prints what that key decrypts
SBA_LWD_URL=<another lightwalletd> pnpm --filter @sba/service run audit [record]                         # cross-check the server you trust
```

`pnpm test:e2e` never stops a process it did not start: `e2e/stack.sh` serves `site/` on
127.0.0.1:4180 (`FUIN_PORT` to change it), refuses a port in use, and stops its own server by PID,
also when the build or a readiness check fails.

**Demo video:** there is no current one. The only recording, `zec-sealed-bid-audit.mp4` (16 s,
shared separately), is the audit re-reading Sale 001 at `58c2393`: it predates the chain-scanning
audit, the reveal channel and Sales 002 and 003. A 2-minute walkthrough (landing, saleroom checks and
tamper buttons on each sale, the live Sale 003 audit with its complaint, the MCP tools) is still to be
recorded.

Testnet funds came from the public Valar testnet faucet (0.125 TAZ); Sales 002 and 003 reused what was left in the same demo wallets. Wallet files and keys stay in
the gitignored `.demo/` folder.

## Honest limits

- The auctioneer learns every bid at the reveal and is trusted to settle. It cannot fake a winner the
  proof does not support, add a phantom bid, or leave a deposit or a reveal note out of its record
  up to its declared scan (`scannedTo`, at or after the end of the reveal window) without failing the
  audit. The converse: anyone can pay the auction address after that scan; such notes are late, so
  the audit reports them instead of failing an honest record. Sale 003's id binds its terms; **Sales
  001 and 002 predate that** (`! terms: legacy`): their windows and reserve come from the record, so an
  auctioneer could have moved them. If it rejects a valid reveal it alone can decrypt, or underpays,
  the bidder's complaint proves it and the audit fails. Nothing forces it to settle. Threshold
  decryption of the reveal key would stop it seeing bids early; it is sketched in the docs, not built.
- The audit trusts the one lightwalletd it reads (testnet.zec.rocks by default) for block contents and
  heights: "complete" means complete as that server reports the chain. Run it against a second server
  (`SBA_LWD_URL`) or your own node to compare.
- The auction's viewing key sees no settlement output. Payments are checked only with a recipient's
  key: the seller's (`SBA_SELLER_UIVK`) or a complaint's refund key. Without one the audit ends
  `chain checks pass; payments not checked`.
- Reveals cost one more shielded transaction per bidder, and the public viewing key shows which
  deposits were revealed and when (the outcome's `unrevealed` list says the same).
- Filing a complaint publishes the complaining bidder's own bid. Adding a refund viewing key (opt-in,
  from a refunds-only wallet) makes every payment to that wallet readable. Sale 003's complaint carries
  no key; Sale 002's carries bidder2's whole demo-wallet key (filed before the key was opt-in).
- Unrevealed deposits go to the seller (Sale 003 shows it: 195,000 zat with memo `forfeit:<deposit>`).
  In Sale 002, before that rule, the unrevealed deposit and the abandoned attempt's four payments
  (0.008 TAZ) stayed in the auction wallet.
- The no-sale path (nothing revealed, or the top bid below the reserve) is covered by unit tests with
  real proofs; no live sale has ended without a sale.
- Ties within one block go to the lexically lower txid, not the transaction mined first
  (`sba-verify` reports no position in the block): a bidder could grind its txid to win a same-block tie.
- At most 8 revealed bids compete (the circuit has 8 slots); a later revealed bid is refunded minus its
  output fee. Deposits nobody reveals take no slot.
- The bidders in Sales 002 and 003 were `sba-mcp` processes driven by a script that chose the amounts;
  no autonomous agent or language model chose a bid. Sale 001 predates the reveal channel: one script
  held every opening.
- Zcash has no contracts: late, duplicate, wrong-amount, memo-mismatch and altered bids are rejected
  by the auction service, and the inputs to those decisions are re-checkable with the published key.
- `MaxBid` uses a single-party local Groth16 setup; whoever ran it could forge proofs. A ceremony needs
  outside contributors; none has been run.
- Testnet only, and not the first sealed-bid ZK auction (see "What is new here").

What changed, by date: [docs/CHANGELOG.md](docs/CHANGELOG.md).

MIT — Copyright (c) 2026 Nivesh Gajengi.
