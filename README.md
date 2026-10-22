# Fuin — sealed-bid auctions on Zcash

Fuin (封印, Japanese for "seal") is a sealed-bid auction where every bid is a **shielded Zcash deposit of the same size**, its memo a
Poseidon commitment to the bid. After the close, each bidder **reveals through the chain**: a second
shielded note whose memo is its opening sealed to the auctioneer's reveal key. A **Groth16 proof (`MaxBid`)** shows which
commitment holds the highest bid at or above the reserve, so **only the winning bid is ever
published**. One shielded transaction then pays the seller and refunds every other revealed deposit, and each
recipient checks its own output with its own viewing key. Zcash testnet, Ironwood pool, no
transparent parts.

## Live run on Zcash testnet: Sale 001 (before the reveal channel)

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

## Live run on Zcash testnet: Sale 002 (the reveal channel)

Auction `fuin-reveal-2026-10-21T18:43` (id 2582488456264710777): deposit 0.002 TAZ, reserve 0.0005 TAZ,
open at block 4,526,425 (18:42:10 UTC), closes after block 4,526,455 (18:57:03 UTC), reveals until
block 4,526,479 (19:04:48 UTC), complaints until 60 blocks after the settlement. Record:
[`deployments/testnet-reveal.json`](deployments/testnet-reveal.json). Run by
`pnpm --filter @sba/mcp reveal-run`: each bidder is its own `sba-mcp` process with only its own wallet
and openings folder. The auctioneer learns the openings only from the reveal notes on chain.

| Deposit | Status | Tx | Block |
|---|---|---|---|
| bidder1 sealed bid (MCP `bid`) | valid | [`b7511ee8…`](https://testnet.zcashexplorer.app/transactions/b7511ee8836566793f9d687468293e2cae371273b265877aadf8dc410d8f846b) | 4526435 |
| bidder2 sealed bid (MCP `bid`) | **valid, wins (0.00135 TAZ)** | [`eb27d26d…`](https://testnet.zcashexplorer.app/transactions/eb27d26d5b30353021585db730bb90d3cd42e1158748a29a463103410569b768) | 4526435 |
| bidder3: one transaction pays the auction twice | output 0 **valid**, output 2 **duplicate** (both refunded) | [`9bb4098e…`](https://testnet.zcashexplorer.app/transactions/9bb4098e6428c1ce3ceac1d568c2a7875cb5ec9c22c30c86516f42f42b85e74c) | 4526438 |
| bidder2's second bid, never revealed | **unrevealed** (listed in the outcome, not refunded) | [`19029d77…`](https://testnet.zcashexplorer.app/transactions/19029d771d63cb844ecd5746098b9eb02a9d6f50067563d1a5b22fe7d6a55e66) | 4526439 |
| 4 payments for an abandoned first attempt (below) | memo_mismatch (another auction's id) | `26f240bc…` ×2, `42ed60c8…`, `597be193…` | 4526425 |

| Reveal note (1 zat, memo sealed to the reveal key) | Status | Tx | Block |
|---|---|---|---|
| bidder1 (MCP `reveal`) | accepted | [`332fbc3c…`](https://testnet.zcashexplorer.app/transactions/332fbc3c408d9086da29a81e85132b6863bbffef58d0bf7569fdac3d1c489161) | 4526461 |
| bidder2 (MCP `reveal`) | accepted | [`07ec9dcd…`](https://testnet.zcashexplorer.app/transactions/07ec9dcd0814d5557ebf72932e1e4931c8ea944b5a8e87a641c2df45062d5553) | 4526464 |
| bidder3 (MCP `reveal`, names `9bb4098e…:0`) | accepted | [`80428975…`](https://testnet.zcashexplorer.app/transactions/804289759a1962c4b47197b82d55e5f53d28d8857a8085b8fccc09db10d71bd7) | 4526465 |
| bidder3's opening pointed at bidder2's deposit | **wrong_commitment** | [`ca315a6c…`](https://testnet.zcashexplorer.app/transactions/ca315a6cd6e05c01699dd2edd903caf7032ccfb1b8781ebd2de1fd8be7bf398e) | 4526465 |
| bidder1's reveal re-sent after the window | **late** | [`64de2707…`](https://testnet.zcashexplorer.app/transactions/64de2707bf22b32ee3e3f49489e6f96b2700e7dffaeaa76811f66a2e6584a29a) | 4526489 |

**Settlement** [`e84de386…`](https://testnet.zcashexplorer.app/transactions/e84de386e23fb514b7b329873d48a4b9316bc00984101f67b4167a9738746f5d)
(block 4,526,493, 19:10:08 UTC), 5 outputs, each matched by its recipient's own viewing key: seller
135,000 zat; bidder2 (winner) 5,000 change; bidder1 200,000; bidder3 200,000 + 200,000 (its bid and
the duplicate second payment). The proof's slots are the three revealed valid deposits; the
never-revealed one is declared `unrevealed`.

**Dispute:** bidder2, the winner (its bid is already public), filed a complaint with MCP `complain`,
anchored at [`f17193d5…`](https://testnet.zcashexplorer.app/transactions/f17193d5b7ccef68227e514ebd16c46bb28aa8d72f13a0937928ddc5a5d125fb)
(file: [`deployments/complaints/`](deployments/complaints)). The audit checks it against the chain:
`unfounded: reveal 07ec9dcd08 (block 4526464) was honoured; paid in full: the refund address received
5000 zat in settlement e84de386e2, owed 5000`. Pointed at a record that names a different
transaction as the settlement, the same complaint is upheld and the audit fails (live test).

An earlier attempt (`fuin-reveal-2026-10-21T18:32`) was abandoned: lightwalletd transmission failures
held three of its deposit transactions (four payments, 0.008 TAZ) in the mempool past its close. They
were mined in Sale 002's first block, where the audit reads them as memo mismatches. They stay in
the auction wallet.

## How it works

1. A bidder commits `Poseidon(auction_id, bid, salt)` and sends the fixed deposit with memo `sba1:<auction_id>:<commitment>`.
2. After the close, inside the reveal window, it sends a 1-zat note to the auction address whose memo
   is `sba1r:<auction_id>:<deposit>:<sealed>`: its bid, salt, refund address and a complaint key,
   encrypted to the auction's published X25519 reveal key. Anyone with the viewing key sees which
   deposit a reveal names and when, never what it says. The auctioneer decrypts reveals from the
   chain. Why a memo and not an HTTP endpoint: [packages/docs](packages/docs/README.md#why-reveal-by-memo-not-an-http-endpoint).
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
| [`packages/verifier`](packages/verifier) | `sba-verify` (Rust): decrypt transactions, or scan a block range, with an incoming viewing key via lightwalletd, as JSON (every output, with its index); address ownership; chain tip; block times |
| [`packages/service`](packages/service) | auction rules, the reveal channel (seal, ingest, audit), complaints, zingo-cli wallet wrapper, settlement, the first live run, the chain-scanning audit |
| [`packages/mcp`](packages/mcp) | `sba-mcp` for agent bidders: `auction_status`, `bid` (refuses closed auctions), `reveal` (sealed note, refuses outside the window), `complain`, `verify_result`; `reveal-run`, the Sale 002 live run |
| [`packages/dashboard`](packages/dashboard) | the saleroom: lot cards, live clock since the hammer, and in-browser checks (vk hash, Groth16 proof, `checkResult`) with two tamper buttons; Sale 002's reveal notes |
| [`packages/docs`](packages/docs) | protocol, privacy table, rules, trusted setup, prior art |
| [`packages/landing`](packages/landing) | one-page catalogue landing with the sealed-envelope reveal |

## Run it

Needs Node 22+, pnpm 10, circom 2.2, Rust 1.89 (pinned in `packages/verifier`) and, for a live run,
zingo-cli (`SBA_ZINGO_CLI`, default `~/src/zingolib/target/release/zingo-cli`).

```sh
pnpm install
pnpm build                     # sba-verify (Rust) + TS packages
pnpm test                      # verifier 6 (Rust) + circuits 10 + service 28 + mcp 8 = 52 (service audit and mcp read live testnet)
pnpm --filter @sba/dashboard dev
# a new live auction with the reveal channel: wallets in .demo/wallets/{auction,bidder1,bidder2,bidder3,seller}, bidders funded
pnpm --filter @sba/mcp reveal-run
# re-check a published auction from the chain with only its incoming viewing key (and any complaint files)
SBA_AUDIT_UIVK=<a recipient's UIVK, optional> pnpm --filter @sba/service run audit [deployments/testnet-reveal.json] [complaint.json ...]
```

Demo video: `zec-sealed-bid-audit.mp4` (shared separately until hosted): the audit script re-reading
Sale 001 with only its viewing key. It was recorded at `58c2393`, before the audit scanned blocks and
before the reveal channel, so it shows the earlier output.

Testnet funds came from the public Valar testnet faucet (0.125 TAZ); Sale 002 reused what was left in the same demo wallets. Wallet files and keys stay in
the gitignored `.demo/` folder.

## Honest limits

- The auctioneer learns every bid at the reveal and is trusted to settle. It cannot fake a winner the
  proof does not support, add a phantom bid, hide a deposit or a reveal note from the audit, or call
  an in-window reveal late. If it rejects a valid reveal it alone can decrypt, or underpays, the
  bidder's complaint proves it and the audit fails. Nothing forces it to settle at all.
- Reveals cost one more shielded transaction per bidder, and the public viewing key shows which
  deposits were revealed and when (the outcome's `unrevealed` list says the same).
- Filing a complaint publishes the complaining bidder's own bid. In Sale 002 only the winner filed
  one, so no losing bid is public.
- Sale 001 predates the reveal channel: one script held every opening.
- A deposit transaction that pays the auction several times is read as several deposits (fixed;
  Sale 002 has one). The 1-zat reveal and complaint notes stay with the auction.
- Zcash has no contracts: late, duplicate, wrong-amount, memo-mismatch and altered bids are rejected
  by the auction service, and the inputs to those decisions are re-checkable with the published key.
- `MaxBid` uses a single-party local Groth16 setup; whoever ran it could forge proofs.
- Testnet only. Sealed-bid auctions with ZK proofs have prior art; this is not the first.

Judge review and what was fixed: [docs/JUDGE-2026-10-21.md](docs/JUDGE-2026-10-21.md).

MIT — Copyright (c) 2026 Nivesh Gajengi.
