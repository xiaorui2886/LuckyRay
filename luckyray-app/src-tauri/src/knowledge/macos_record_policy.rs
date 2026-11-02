//! Bounded, fixed-name layout for large recovery payloads. Individual records
//! and pieces remain below the existing 32 MiB private-record ceiling.
pub(super) const PIECE_BYTES: usize = 8 * 1024 * 1024;
pub(super) const MAX_BYTES: usize = 384 * 1024 * 1024;
fn id(value: &str) -> bool {
    value.len() == 32
        && value
            .bytes()
            .all(|b| b.is_ascii_digit() || (b'a'..=b'f').contains(&b))
}
pub(super) fn record_name(name: &str) -> bool {
    let Some(body) = name.strip_suffix(".json") else {
        return false;
    };
    if let Some(body) = body.strip_suffix(".result") {
        let Some((operation, attempt)) = body.split_once('-') else {
            return false;
        };
        id(operation) && id(attempt)
    } else if let Some((operation, step)) = body.split_once(".s") {
        let Some((index, phase)) = step.split_once('.') else {
            return false;
        };
        id(operation)
            && index.len() == 4
            && index.bytes().all(|c| c.is_ascii_digit())
            && index.parse::<usize>().is_ok_and(|value| value < 1024)
            && ["fi", "fd", "ri", "rd"].contains(&phase)
    } else {
        id(body)
    }
}
pub(super) fn piece_count(total: usize) -> Option<usize> {
    (total > 0 && total <= MAX_BYTES).then(|| total.div_ceil(PIECE_BYTES))
}
pub(super) fn piece_len(total: usize, count: usize, index: usize) -> Option<usize> {
    if piece_count(total) != Some(count) || index >= count {
        return None;
    }
    Some((total - index * PIECE_BYTES).min(PIECE_BYTES))
}
pub(super) fn piece_name(record: &str, index: usize) -> Option<String> {
    (record_name(record) && index < MAX_BYTES / PIECE_BYTES)
        .then(|| format!("{record}.part-{index:03}"))
}
pub(super) fn hash64(value: &str) -> bool {
    value.len() == 64
        && value
            .bytes()
            .all(|b| b.is_ascii_digit() || (b'a'..=b'f').contains(&b))
}
pub(super) fn data_path(value: &str) -> bool {
    !value.is_empty()
        && value.trim() == value
        && !value.contains(['\\', ':', '\0'])
        && !value.chars().any(char::is_control)
        && value.split('/').all(|part| {
            let folded = part.to_ascii_lowercase();
            !part.is_empty()
                && part != "."
                && part != ".."
                && ![".luckyray", ".git", ".obsidian"]
                    .iter()
                    .any(|reserved| part.eq_ignore_ascii_case(reserved))
                && !folded.starts_with(".lrk-")
                && !folded.starts_with(".lrm-")
        })
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn layout_covers_every_byte_and_respects_the_individual_record_ceiling() {
        for total in [
            1,
            PIECE_BYTES,
            PIECE_BYTES + 1,
            32 * 1024 * 1024 + 1,
            MAX_BYTES,
        ] {
            let count = piece_count(total).unwrap();
            assert_eq!(
                (0..count)
                    .map(|i| piece_len(total, count, i).unwrap())
                    .sum::<usize>(),
                total
            );
            assert!((0..count).all(|i| piece_len(total, count, i).unwrap() <= PIECE_BYTES));
        }
        assert_eq!(piece_count(0), None);
        assert_eq!(piece_count(MAX_BYTES + 1), None);
    }
    #[test]
    fn record_names_cannot_address_another_directory_or_private_metadata() {
        let operation = "a".repeat(32);
        let attempt = "b".repeat(32);
        assert!(record_name(&format!("{operation}.json")));
        assert!(record_name(&format!("{operation}-{attempt}.result.json")));
        assert!(record_name(&format!("{operation}.s0000.fi.json")));
        assert!(record_name(&format!("{operation}.s1023.rd.json")));
        for suffix in [
            "s1024.fi.json",
            "s0000.done.json",
            "s0000.fi.extra.json",
            "s00.fi.json",
            "s0000.fi/other.json",
        ] {
            assert!(!record_name(&format!("{operation}.{suffix}")));
        }
        for invalid in [
            "../vault.json".into(),
            "attachment-receipt.key".into(),
            format!("../{operation}.json"),
            format!("{operation}/{attempt}.json"),
            format!("{operation}-{attempt}-c.result.json"),
            "A".repeat(32) + ".json",
        ] {
            assert!(!record_name(&invalid));
        }
        assert!(data_path("Folder/笔记.md"));
        for invalid in [
            "../note.md",
            "a//note.md",
            "a/./note.md",
            ".luckyray/key",
            "a/.lrm-old.backup",
            "a/.LRM-old.backup",
            "a/.lrk-old.json",
            "a/.LRK-old.json",
            "/note.md",
            "C:/note.md",
            "a\\note.md",
            "a/\n.md",
        ] {
            assert!(!data_path(invalid), "{invalid}");
        }
        assert!(hash64(&"a".repeat(64)));
        assert!(!hash64(&"A".repeat(64)));
        assert!(!hash64("a"));
    }
    #[test]
    fn truncated_extended_or_duplicate_piece_positions_are_rejected() {
        let total = PIECE_BYTES + 19;
        assert_eq!(piece_len(total, 2, 0), Some(PIECE_BYTES));
        assert_eq!(piece_len(total, 2, 1), Some(19));
        assert_eq!(piece_len(total, 1, 0), None);
        assert_eq!(piece_len(total, 3, 0), None);
        assert_eq!(piece_len(total, 2, 2), None);
        let name = "a".repeat(32) + ".json";
        assert_ne!(piece_name(&name, 0), piece_name(&name, 1));
        assert_eq!(piece_name(&name, 48), None);
    }
}
