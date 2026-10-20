//! sba-verify: audit a sealed-bid auction with only its unified *incoming* viewing key.
//!
//!     sba-verify tx <txid>...        (UIVK from SBA_UIVK)
//!         For each transaction: fetch it from lightwalletd (SBA_LWD_URL, default testnet.zec.rocks),
//!         trial-decrypt every Sapling, Orchard and Ironwood output, and print one JSON line:
//!         {"txid","height","confirmations","outputs":[{"pool","value","memo"}],"transparent":bool}
//!     sba-verify derive               prints the UIVK for the UFVK in SBA_UFVK (env only)
//!
//! An incoming viewing key sees received notes and their memos. It cannot spend and cannot see
//! spends or change. Exit 1 on any error; a transaction with no decryptable output is not an error
//! (its outputs list is empty), so callers decide what that means.
//! Decryption follows zec-shielded-x402's check_uivk (same author, MIT).

#[allow(dead_code)]
mod lwd;

use orchard::note_encryption::{DomainVersion, IronwoodVersion, NoteEncryptionDomain, OrchardVersion};
use sapling::note_encryption::SaplingDomain;
use serde_json::{json, Value};
use zcash_keys::keys::{UnifiedFullViewingKey, UnifiedIncomingViewingKey};
use zcash_note_encryption::try_note_decryption;
use zcash_primitives::transaction::{components::sapling::zip212_enforcement, Transaction};
use zcash_protocol::consensus::{BlockHeight, BranchId, Network};
use zcash_protocol::memo::{Memo, MemoBytes};

const NETWORK: Network = Network::TestNetwork;

fn die(msg: impl std::fmt::Display) -> ! {
    eprintln!("error: {msg}");
    std::process::exit(1)
}

fn memo_value(m: &[u8; 512]) -> Value {
    match MemoBytes::from_bytes(m).ok().and_then(|b| Memo::try_from(&b).ok()) {
        Some(Memo::Text(t)) => json!({ "text": &*t }),
        Some(Memo::Empty) => json!(null),
        _ => json!({ "non_text": true }),
    }
}

fn orchard_family<V: DomainVersion>(
    pool: &str,
    ivk: &orchard::keys::IncomingViewingKey,
    bundle: &orchard::bundle::Bundle<orchard::bundle::Authorized, zcash_protocol::value::ZatBalance>,
    out: &mut Vec<Value>,
) {
    let p = orchard::keys::PreparedIncomingViewingKey::new(ivk);
    for a in bundle.actions() {
        let d = NoteEncryptionDomain::<V>::for_action(a);
        if let Some((note, _, memo)) = try_note_decryption(&d, &p, a) {
            out.push(json!({ "pool": pool, "value": note.value().inner(), "memo": memo_value(&memo) }));
        }
    }
}

async fn inspect(c: &mut lwd::Client, uivk: &UnifiedIncomingViewingKey, txid: &str, tip: BlockHeight) -> Value {
    let id = lwd::parse_txid(txid).unwrap_or_else(|| die(format!("bad txid {txid}")));
    let (data, loc) = match lwd::get_transaction(c, &id).await.unwrap_or_else(|e| die(e)) {
        lwd::FetchedTx::Found { data, location } => (data, location),
        lwd::FetchedTx::NotFound => die(format!("transaction {txid} not found")),
    };
    let mined = match loc {
        lwd::TxLocation::Mined(h) => Some(h),
        lwd::TxLocation::Mempool => None,
        lwd::TxLocation::Orphaned => die(format!("{txid} is only on an orphaned fork")),
    };
    let tx = Transaction::read(&data[..], BranchId::for_height(&NETWORK, mined.unwrap_or(tip + 1)))
        .unwrap_or_else(|e| die(format!("{txid}: unparseable: {e}")));
    if tx.txid() != id {
        die("lightwalletd returned a different transaction");
    }
    let mut out = Vec::new();
    if let (Some(b), Some(ivk)) = (tx.sapling_bundle(), uivk.sapling()) {
        let d = SaplingDomain::new(zip212_enforcement(&NETWORK, mined.unwrap_or(tip + 1)));
        let p = ivk.prepare();
        for o in b.shielded_outputs() {
            if let Some((note, _, memo)) = try_note_decryption(&d, &p, o) {
                out.push(json!({ "pool": "Sapling", "value": note.value().inner(), "memo": memo_value(&memo) }));
            }
        }
    }
    if let Some(ivk) = uivk.orchard() {
        if let Some(b) = tx.orchard_bundle() {
            orchard_family::<OrchardVersion>("Orchard", ivk, b, &mut out);
        }
        if let Some(b) = tx.ironwood_bundle() {
            orchard_family::<IronwoodVersion>("Ironwood", ivk, b, &mut out);
        }
    }
    let transparent = tx.transparent_bundle().is_some_and(|b| !b.vin.is_empty() || !b.vout.is_empty());
    let confirmations = mined.map(|h| u32::from(tip).saturating_sub(u32::from(h)) + 1).unwrap_or(0);
    json!({
        "txid": txid,
        "height": mined.map(u32::from),
        "confirmations": confirmations,
        "outputs": out,
        "pools": {
            "sapling": tx.sapling_bundle().is_some(),
            "orchard": tx.orchard_bundle().is_some(),
            "ironwood": tx.ironwood_bundle().is_some(),
            "transparent": transparent,
        },
    })
}

#[tokio::main]
async fn main() {
    let args: Vec<String> = std::env::args().skip(1).collect();
    match args.first().map(String::as_str) {
        Some("derive") => {
            let s = std::env::var("SBA_UFVK").unwrap_or_else(|_| die("Setup required: SBA_UFVK"));
            let ufvk = UnifiedFullViewingKey::decode(&NETWORK, s.trim()).unwrap_or_else(|e| die(e));
            println!("{}", ufvk.to_unified_incoming_viewing_key().encode(&NETWORK).unwrap_or_else(|e| die(format!("{e:?}"))));
        }
        Some("tx") if args.len() > 1 => {
            let s = std::env::var("SBA_UIVK").unwrap_or_else(|_| die("Setup required: SBA_UIVK"));
            let uivk = UnifiedIncomingViewingKey::decode(&NETWORK, s.trim()).unwrap_or_else(|e| die(e));
            let url = std::env::var("SBA_LWD_URL").unwrap_or_else(|_| lwd::DEFAULT_LWD_URL.to_string());
            let mut c = lwd::connect(&url).await.unwrap_or_else(|e| die(e));
            let tip = lwd::chain_tip(&mut c).await.unwrap_or_else(|e| die(e));
            for txid in &args[1..] {
                println!("{}", inspect(&mut c, &uivk, txid, tip).await);
            }
        }
        _ => die("usage: sba-verify tx <txid>...   (SBA_UIVK)   |   sba-verify derive   (SBA_UFVK)"),
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn memo(bytes: &[u8]) -> [u8; 512] {
        let mut m = [0u8; 512];
        m[..bytes.len()].copy_from_slice(bytes);
        m
    }

    #[test]
    fn text_memos_decode_and_empty_is_null() {
        assert_eq!(memo_value(&memo(b"sba1:42:7")), json!({ "text": "sba1:42:7" }));
        let mut empty = [0u8; 512];
        empty[0] = 0xF6;
        assert_eq!(memo_value(&empty), json!(null));
    }

    #[test]
    fn binary_memos_are_flagged_not_decoded() {
        let mut bin = [0u8; 512];
        bin[0] = 0xFF;
        bin[1] = 0x01;
        assert_eq!(memo_value(&bin), json!({ "non_text": true }));
    }

    #[test]
    fn txids_parse_in_display_order_only_when_well_formed() {
        assert!(lwd::parse_txid(&"ab".repeat(32)).is_some());
        assert!(lwd::parse_txid("xyz").is_none());
    }
}
