# sba-verify (Rust)

Decrypts Zcash testnet transactions with an incoming viewing key, via lightwalletd, and prints JSON.
Same pinned pre-release librustzcash line as zec-shielded-x402 (NU7 / Ironwood), Rust 1.89.

```sh
SBA_UIVK=uivktest1… sba-verify tx <txid>...   # one line per tx: height, confirmations, outputs (pool, index, value, memo), pools present
SBA_UIVK=uivktest1… sba-verify scan <from> <to>   # every tx in blocks from..=to (max 5,000) with an output this key decrypts
SBA_UIVK=uivktest1… sba-verify owns <address>    # true if the address's Orchard receiver belongs to the key
sba-verify tip                                  # chain tip height
sba-verify block <height>...                    # header time and hash per block
SBA_UFVK=uviewtest1… sba-verify derive        # the incoming viewing key for a full viewing key
```

Keys come from the environment only. `SBA_LWD_URL` overrides `https://testnet.zec.rocks:443`.
Every decrypted output is listed with its action index, so a transaction that pays the key twice
is two outputs.

Tests (`cargo test`, 6): memo decoding (2), txid parsing, scan range bounds, a real Ironwood bundle
built in-process that pays the key twice (both read, each with its own index), and `owns` with
in-process keys.
