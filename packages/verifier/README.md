# sba-verify (Rust)

Decrypts Zcash testnet transactions with an incoming viewing key, via lightwalletd, and prints JSON.
Same pinned pre-release librustzcash line as zec-shielded-x402 (NU7 / Ironwood), Rust 1.89.

```sh
SBA_UIVK=uivktest1… sba-verify tx <txid>...   # one line per tx: height, confirmations, outputs (pool, value, memo), pools present
SBA_UFVK=uviewtest1… sba-verify derive        # the incoming viewing key for a full viewing key
```

Keys come from the environment only. `SBA_LWD_URL` overrides `https://testnet.zec.rocks:443`.
Tests (`cargo test`, 3): memo decoding and txid parsing.
