# Fuin — sealed-bid auctions on Zcash

Fuin (封印, Japanese for "seal") is a sealed-bid auction where every bid is a **shielded Zcash deposit of the same size**, its memo a
Poseidon commitment to the bid. After the close, a **Groth16 proof (`MaxBid`)** shows which
commitment holds the highest bid at or above the reserve, so **only the winning bid is ever
published**. One shielded transaction then pays the seller and refunds every other revealed deposit, and each
recipient checks its own output with its own viewing key. Zcash testnet, Ironwood pool, no
transparent parts.

## Live run on Zcash testnet

Auction `sba-testnet-2026-10-20T13:30` (id 6201170948318861529): deposit 0.02 TAZ, reserve
0.005 TAZ, open at block 4,522,258 (13:29:28 UTC), closes after block 4,522,278 (13:35:21 UTC). Full record, including the proof and the auction's incoming
viewing key: [`deployments/testnet.json`](deployments/testnet.json).

| Deposit | Service says | Tx | Block |
|---|---|---|---|
| bidder3 sealed bid | valid | [`06d12181…`](https://testnet.zcashexplorer.app/transactions/06d121813387444ca3ecc9720e73160b5b80645d9204c6c411e51cef3a190af1) | 4522268 |
| bidder1 sealed bid | valid | [`3d104727…`](https://testnet.zcashexplorer.app/transactions/3d104727044cf3164fc8df304d8ea95d3307ca90f0b0d4c21d994a1f350b0890) | 4522268 |
| bidder2 sealed bid | **valid, wins (0.0175 TAZ, opened by the proof)** | [`d910ebad…`](https://testnet.zcashexplorer.app/transactions/d910ebad413bf37c0ffb38f9032c61bb2d1b26ae54ca2422d3bdd2428bb3e1eb) | 4522268 |
| bidder2 deposits 0.005 TAZ instead of 0.02 | **wrong_amount** | [`29c23b7d…`](https://testnet.zcashexplorer.app/transactions/29c23b7d99be5dc70e8b505fef16628454a32aed8189cf87ad375fd5c95bf1dc) | 4522275 |
| bidder3 sends a memo that is not a bid | **memo_mismatch** | [`76b0b9bb…`](https://testnet.zcashexplorer.app/transactions/76b0b9bb76aee301fe5640fe7b1c3ff0746a999c743d9a4199dbf60375c39aa0) | 4522275 |
| bidder1 re-sends the same commitment | **duplicate** | [`c1b89ecd…`](https://testnet.zcashexplorer.app/transactions/c1b89ecd0d0bbbbeaecc86ca3d353788e8c2e1f71ac99d8be87154ddef8d6503) | 4522275 |
| bidder1 deposits after the close | **late** | [`c2e20a26…`](https://testnet.zcashexplorer.app/transactions/c2e20a26d0279db8c55d037068c83af5cef68a3227dab45f423ad622708387fc) | 4522283 |

An **altered reveal** (bidder3 claiming 0.019 TAZ with its real salt) was refused: the opening
matches no deposit commitment.

**Settlement** [`89bf60fd…`](https://testnet.zcashexplorer.app/transactions/89bf60fd905a1bdecea16c6ebe22018f1ddcbe0a43fca32c103c2b995e74820a)
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

## How it works

1. A bidder commits `Poseidon(auction_id, bid, salt)` and sends the fixed deposit with memo `sba1:<auction_id>:<commitment>`.
2. After the close, it gives `(bid, salt, refund address)` to the auctioneer. There is no reveal
   channel yet: this happens out of band, and in the live run one script played every bidder and the
   auctioneer.
3. The auctioneer proves `MaxBid` over the revealed valid deposits in chain order, lists any valid
   deposit that was never revealed, and settles in one shielded transaction.
4. Anyone with the auction's **incoming viewing key** scans the auction's blocks, reads every
   deposit's amount and memo (never a bid), and checks that the proof covers exactly those deposits
   (`checkResult`): no phantom bid in a spare slot, no deposit silently left out, the winner a real
   deposit.

Protocol, what each party learns, rules and trusted setup: [packages/docs](packages/docs/README.md).

## Packages

| Package | What |
|---|---|
| [`packages/circuits`](packages/circuits) | `MaxBid(8)` Circom/Groth16 circuit (6,800 constraints), local setup, helpers, `checkResult` (ties a proof to the deposits), 10 real-proof tests |
| [`packages/verifier`](packages/verifier) | `sba-verify` (Rust): decrypt transactions, or scan a block range, with an incoming viewing key via lightwalletd, as JSON; chain tip; block times |
| [`packages/service`](packages/service) | auction rules, zingo-cli wallet wrapper, settlement, the resumable live testnet run, the chain-scanning audit |
| [`packages/mcp`](packages/mcp) | `sba-mcp` for agent bidders: `auction_status`, `bid` (refuses closed auctions), `verify_result` |
| [`packages/dashboard`](packages/dashboard) | the saleroom: lot cards, live clock since the hammer, and in-browser checks (vk hash, Groth16 proof, `checkResult`) with two tamper buttons |
| [`packages/docs`](packages/docs) | protocol, privacy table, rules, trusted setup, prior art |
| [`packages/landing`](packages/landing) | one-page catalogue landing with the sealed-envelope reveal |

## Run it

Needs Node 22+, pnpm 10, circom 2.2, Rust 1.89 (pinned in `packages/verifier`) and, for a live run,
zingo-cli (`SBA_ZINGO_CLI`, default `~/src/zingolib/target/release/zingo-cli`).

```sh
pnpm install
pnpm build                     # sba-verify (Rust) + TS packages
pnpm test                      # verifier 4 (Rust) + circuits 10 + service 8 + mcp 5 = 27 (service audit and mcp read live testnet)
pnpm --filter @sba/dashboard dev
# a new live auction: wallets in .demo/wallets/{auction,bidder1,bidder2,bidder3,seller}, bidder1 funded
pnpm --filter @sba/service testnet-run
# re-check a published auction from the chain with only its incoming viewing key
SBA_AUDIT_UIVK=<a recipient's UIVK, optional> pnpm --filter @sba/service audit
```

Demo video: `zec-sealed-bid-audit.mp4` (shared separately until hosted): the audit script re-reading
the live auction with only its viewing key. It was recorded at `58c2393`, before the audit scanned
blocks, so it shows the earlier output.

Testnet funds came from the public Valar testnet faucet (0.125 TAZ). Wallet files and keys stay in
the gitignored `.demo/` folder.

## Honest limits

- The auctioneer learns every bid at the reveal and is trusted to settle. It cannot fake a winner the
  proof does not support, add a phantom bid, or hide a deposit from the audit. It can still claim a
  bidder never revealed: that deposit is then listed as unrevealed, and the bidder holds an opening
  that proves otherwise, but no dispute flow is built.
- No reveal channel: reveals are handed over out of band, and in the live run one script played every
  bidder and the auctioneer.
- A deposit transaction is read as one deposit (its output with a text memo); a second payment to the
  auction in the same transaction is not counted or refunded.
- Zcash has no contracts: late, duplicate, wrong-amount, memo-mismatch and altered bids are rejected
  by the auction service, and the inputs to those decisions are re-checkable with the published key.
- `MaxBid` uses a single-party local Groth16 setup; whoever ran it could forge proofs.
- Testnet only. Sealed-bid auctions with ZK proofs have prior art; this is not the first.

Judge review and what was fixed: [docs/JUDGE-2026-10-21.md](docs/JUDGE-2026-10-21.md).

MIT — Copyright (c) 2026 Nivesh Gajengi.
