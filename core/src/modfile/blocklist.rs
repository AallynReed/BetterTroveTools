//! Words a mod may not contain anywhere: metadata, packed file paths or its file name.

use std::sync::OnceLock;

use base64::Engine;

use super::TroveMod;

/// Newline-separated, base64-encoded so the words don't sit in the source as plain text.
const BLOCKED_WORDS: &str = "cXV3YXN0ZQ==";

pub const BLOCKED_MESSAGE: &str = "Failure to compile";

/// Folds text so disguised spellings compare equal: lowercase, look-alike digits and
/// symbols to letters, separators dropped, repeated letters collapsed.
fn fold(text: &str) -> String {
    let mut out = String::with_capacity(text.len());
    for c in text.chars().flat_map(char::to_lowercase) {
        let c = match c {
            '0' => 'o',
            '1' | '!' | '|' => 'i',
            '3' => 'e',
            '4' | '@' => 'a',
            '5' | '$' => 's',
            '7' | '+' => 't',
            '8' => 'b',
            '9' => 'g',
            c => c,
        };
        if c.is_alphanumeric() && !out.ends_with(c) {
            out.push(c);
        }
    }
    out
}

fn words() -> &'static [String] {
    static WORDS: OnceLock<Vec<String>> = OnceLock::new();
    WORDS.get_or_init(|| {
        let raw = base64::engine::general_purpose::STANDARD.decode(BLOCKED_WORDS).unwrap_or_default();
        String::from_utf8_lossy(&raw).lines().map(fold).filter(|w| !w.is_empty()).collect()
    })
}

/// True when `text` contains a blocked word, however it is cased, spaced or disguised.
pub fn contains_blocked(text: &str) -> bool {
    let text = fold(text);
    words().iter().any(|w| text.contains(w.as_str()))
}

/// True when any property, packed file path or the mod's own file name contains a blocked word.
pub fn mod_is_blocked(m: &TroveMod) -> bool {
    m.properties.iter().any(|p| contains_blocked(&p.name) || contains_blocked(&p.value))
        || m.files.iter().any(|f| contains_blocked(&f.trove_path))
        || m.mod_path.file_name().map(|n| contains_blocked(&n.to_string_lossy())).unwrap_or(false)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn matches_disguised_spellings() {
        for hit in ["QuWaste", "my_QUWASTE_mod.png", "Qu_W4ste", "q u w a s t e", "quuwaaste", "QU-W@$TE", "qu.w4st3"] {
            assert!(contains_blocked(hit), "{hit}");
        }
        for clean in ["quiet waste", "Quest", "wasteland", "Clean Mod"] {
            assert!(!contains_blocked(clean), "{clean}");
        }
    }
}
