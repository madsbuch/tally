//! Row ids are TypeIDs (https://github.com/jetify-com/typeid): a prefix naming
//! what the row is, `_`, then the 128 bits of a UUID in 26 characters of
//! Crockford base32 — `chat_01h455vb4pex5vsknk084sn02q`. The same encoding
//! lives in src/lib/ids.ts, in the migration that re-spelled the old UUIDs,
//! and in Kotlin (CoachDb.kt); all four must agree bit for bit.

/// Crockford's base32, lower case, as TypeID spells it.
const ALPHABET: &[u8; 32] = b"0123456789abcdefghjkmnpqrstvwxyz";

/// 16 bytes as TypeID's 26-character suffix: the big-endian 128-bit value in
/// base32, most significant digit first (130 bits, the top two always zero).
fn encode_suffix(bytes: [u8; 16]) -> String {
    let mut n = u128::from_be_bytes(bytes);
    let mut out = [b'0'; 26];
    for slot in out.iter_mut().rev() {
        *slot = ALPHABET[(n & 31) as usize];
        n >>= 5;
    }
    out.iter().map(|&c| char::from(c)).collect()
}

/// The TypeID of `bytes` under `prefix`.
pub fn type_id(prefix: &str, bytes: [u8; 16]) -> String {
    format!("{prefix}_{}", encode_suffix(bytes))
}

/// The TypeID of a UUID string (hyphens optional, any case) under `prefix`;
/// None when `uuid` isn't 32 hex digits. (Only tests need it so far.)
#[cfg(test)]
pub fn type_id_of_uuid(prefix: &str, uuid: &str) -> Option<String> {
    let hex_digits: String = uuid.chars().filter(|&c| c != '-').collect();
    let mut b = [0u8; 16];
    hex::decode_to_slice(&hex_digits, &mut b).ok()?;
    Some(type_id(prefix, b))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn matches_the_spec_examples() {
        assert_eq!(
            type_id_of_uuid("meal", "01890a5d-ac96-774b-bcce-b302099a8057").as_deref(),
            Some("meal_01h455vb4pex5vsknk084sn02q")
        );
        assert_eq!(type_id("chat", [0; 16]), "chat_00000000000000000000000000");
        assert_eq!(type_id("chat", [0xff; 16]), "chat_7zzzzzzzzzzzzzzzzzzzzzzzzz");
        let mut one = [0u8; 16];
        one[15] = 1;
        assert_eq!(type_id("chat", one), "chat_00000000000000000000000001");
        assert_eq!(
            type_id_of_uuid("chat", "00000000-0000-0000-0000-000000000001").as_deref(),
            Some("chat_00000000000000000000000001")
        );
    }

    #[test]
    fn reads_uuids_in_any_case_and_rejects_others() {
        assert_eq!(
            type_id_of_uuid("meal", "01890A5D-AC96-774B-BCCE-B302099A8057").as_deref(),
            Some("meal_01h455vb4pex5vsknk084sn02q")
        );
        assert_eq!(type_id_of_uuid("meal", "not-a-uuid"), None);
        assert_eq!(type_id_of_uuid("meal", "01890a5d"), None);
    }

    #[test]
    fn keeps_byte_order_as_text_order() {
        let a = type_id("x", [0x01, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0xff]);
        let b = type_id("x", [0x01, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 1, 0]);
        let c = type_id("x", [0x02, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0]);
        assert!(a < b && b < c, "{a} {b} {c}");
    }
}
