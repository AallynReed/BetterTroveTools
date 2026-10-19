//! `str` methods and `repr(str)`.

/// `str.isspace()`: Rust's whitespace plus the ASCII separators 0x1C-0x1F.
pub fn is_space(c: char) -> bool {
    c.is_whitespace() || ('\u{1c}'..='\u{1f}').contains(&c)
}

/// `str.strip()`.
pub fn strip(s: &str) -> &str {
    s.trim_matches(is_space)
}

/// `str.lstrip()`.
pub fn lstrip(s: &str) -> &str {
    s.trim_start_matches(is_space)
}

/// `str.split()`.
pub fn split_ws(s: &str) -> impl Iterator<Item = &str> {
    s.split(is_space).filter(|p| !p.is_empty())
}

/// `str.splitlines()`.
pub fn splitlines(s: &str) -> Vec<&str> {
    let mut out = Vec::new();
    let mut start = 0;
    let mut iter = s.char_indices().peekable();
    while let Some((i, c)) = iter.next() {
        let is_break = matches!(c, '\n' | '\r' | '\u{0b}' | '\u{0c}' | '\u{1c}' | '\u{1d}' | '\u{1e}' | '\u{85}' | '\u{2028}' | '\u{2029}');
        if !is_break {
            continue;
        }
        out.push(&s[start..i]);
        let mut end = i + c.len_utf8();
        if c == '\r' {
            if let Some((_, '\n')) = iter.peek() {
                iter.next();
                end += 1;
            }
        }
        start = end;
    }
    if start < s.len() {
        out.push(&s[start..]);
    }
    out
}

/// `str.title()`. Titlecase letters (`ǅ`) get upper-cased at a word start.
pub fn title(s: &str) -> String {
    let mut out = String::with_capacity(s.len());
    let mut prev_cased = false;
    for c in s.chars() {
        if prev_cased {
            out.extend(c.to_lowercase());
        } else {
            out.extend(c.to_uppercase());
        }
        prev_cased = c.is_lowercase() || c.is_uppercase();
    }
    out
}

/// `str.title()` that leaves uncased characters (titlecase letters included) untouched
/// (blueprint).
pub fn title_cased_only(s: &str) -> String {
    let mut out = String::with_capacity(s.len());
    let mut prev_cased = false;
    for c in s.chars() {
        let cased = c.is_lowercase() || c.is_uppercase();
        if cased {
            if prev_cased {
                out.extend(c.to_lowercase());
            } else {
                out.extend(c.to_uppercase());
            }
        } else {
            out.push(c);
        }
        prev_cased = cased;
    }
    out
}

/// One character of a regex `\w` class.
pub fn is_word(c: char) -> bool {
    c.is_alphanumeric() || c == '_'
}

/// `str.isdigit()`.
pub fn isdigit(s: &str) -> bool {
    !s.is_empty() && s.chars().all(char::is_numeric)
}

/// `len(s)` in code points.
pub fn char_len(s: &str) -> usize {
    s.chars().count()
}

/// `s[:n]` in code points.
pub fn char_prefix(s: &str, n: usize) -> String {
    s.chars().take(n).collect()
}

/// An approximation of `str.isprintable()` for one character.
pub fn is_printable(c: char) -> bool {
    let u = c as u32;
    if u < 0x20 || u == 0x7f {
        return false;
    }
    if u < 0x7f {
        return true;
    }
    !matches!(u,
        0x80..=0xa0 | 0xad | 0x600..=0x605 | 0x61c | 0x6dd | 0x70f | 0x1680 | 0x180e | 0x2000..=0x200f
        | 0x2028..=0x202f | 0x205f..=0x2064 | 0x2066..=0x206f | 0x3000 | 0xd800..=0xf8ff | 0xfeff
        | 0xfff9..=0xfffb | 0xe0001 | 0xe0020..=0xe007f | 0xf0000..=0x10ffff)
}

fn repr_str_with(s: &str, printable: fn(char) -> bool) -> String {
    let quote = if s.contains('\'') && !s.contains('"') { '"' } else { '\'' };
    let mut out = String::with_capacity(s.len() + 2);
    out.push(quote);
    for c in s.chars() {
        match c {
            '\\' => out.push_str("\\\\"),
            '\n' => out.push_str("\\n"),
            '\r' => out.push_str("\\r"),
            '\t' => out.push_str("\\t"),
            c if c == quote => {
                out.push('\\');
                out.push(c);
            }
            c if printable(c) => out.push(c),
            c if (c as u32) < 0x100 => out.push_str(&format!("\\x{:02x}", c as u32)),
            c if (c as u32) < 0x10000 => out.push_str(&format!("\\u{:04x}", c as u32)),
            c => out.push_str(&format!("\\U{:08x}", c as u32)),
        }
    }
    out.push(quote);
    out
}

/// `repr(str)`: single quotes unless the text holds a `'` and no `"`.
pub fn repr_str(s: &str) -> String {
    repr_str_with(s, is_printable)
}

/// `repr(str)` escaping only ASCII controls (home, file manager, auth).
pub fn repr_str_ascii(s: &str) -> String {
    repr_str_with(s, |c| !((c as u32) < 0x20 || c as u32 == 0x7f))
}

/// `repr(str)` escaping only non-printables up to U+00FF (gems).
pub fn repr_str_latin1(s: &str) -> String {
    repr_str_with(s, |c| !((c as u32) < 0x20 || (0x7f..=0xa0).contains(&(c as u32)) || c as u32 == 0xad))
}

/// `repr(str)` escaping only `Cc` controls (blueprint).
pub fn repr_str_cc(s: &str) -> String {
    repr_str_with(s, |c| !c.is_control())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn titles_like_python() {
        assert_eq!(title("a1b c_d it's"), "A1B C_D It'S");
        assert_eq!(title("HELLO wORLD"), "Hello World");
        assert_eq!(title("rampage"), "Rampage");
        assert_eq!(title("boss_rush 2x"), "Boss_Rush 2X");
        assert_eq!(title_cased_only("dragon mount2a x"), "Dragon Mount2A X");
    }

    #[test]
    fn splitlines_and_strip() {
        assert_eq!(splitlines("a\r\nb\rc\n\nd\x0be"), vec!["a", "b", "c", "", "d", "e"]);
        assert_eq!(strip("\x1c a \u{3000}"), "a");
        assert_eq!(repr_str("C:\\x'y"), "\"C:\\\\x'y\"");
        assert_eq!(repr_str("a\u{0}b"), "'a\\x00b'");
        assert_eq!(repr_str_ascii(r"C:\x\a'b"), r#""C:\\x\\a'b""#);
    }

    #[test]
    fn repr_flavours() {
        let s = "\u{85}\u{a0}\u{2028}";
        assert_eq!(repr_str(s), "'\\x85\\xa0\\u2028'");
        assert_eq!(repr_str_ascii(s), "'\u{85}\u{a0}\u{2028}'");
        assert_eq!(repr_str_latin1(s), "'\\x85\\xa0\u{2028}'");
        assert_eq!(repr_str_cc(s), "'\\x85\u{a0}\u{2028}'");
    }
}
