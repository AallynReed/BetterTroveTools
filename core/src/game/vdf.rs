//! Just enough of Valve's KeyValues text format to read `libraryfolders.vdf`.

use serde_json::{Map, Value};

/// Parses KeyValues text into nested JSON objects (all leaves are strings).
pub fn parse(text: &str) -> Value {
    let tokens = tokenize(text);
    let mut pos = 0;
    Value::Object(parse_block(&tokens, &mut pos))
}

#[derive(Debug, PartialEq)]
enum Tok {
    Str(String),
    Open,
    Close,
}

fn tokenize(text: &str) -> Vec<Tok> {
    let mut out = Vec::new();
    let mut chars = text.chars().peekable();
    while let Some(c) = chars.next() {
        match c {
            '"' => {
                let mut s = String::new();
                while let Some(c) = chars.next() {
                    match c {
                        '\\' => {
                            if let Some(n) = chars.next() {
                                match n {
                                    'n' => s.push('\n'),
                                    't' => s.push('\t'),
                                    other => s.push(other),
                                }
                            }
                        }
                        '"' => break,
                        other => s.push(other),
                    }
                }
                out.push(Tok::Str(s));
            }
            '{' => out.push(Tok::Open),
            '}' => out.push(Tok::Close),
            '/' if chars.peek() == Some(&'/') => {
                for c in chars.by_ref() {
                    if c == '\n' {
                        break;
                    }
                }
            }
            c if c.is_whitespace() => {}
            c => {
                let mut s = String::from(c);
                while let Some(&n) = chars.peek() {
                    if n.is_whitespace() || n == '{' || n == '}' || n == '"' {
                        break;
                    }
                    s.push(n);
                    chars.next();
                }
                out.push(Tok::Str(s));
            }
        }
    }
    out
}

fn parse_block(tokens: &[Tok], pos: &mut usize) -> Map<String, Value> {
    let mut map = Map::new();
    while *pos < tokens.len() {
        match &tokens[*pos] {
            Tok::Close => {
                *pos += 1;
                break;
            }
            Tok::Open => {
                *pos += 1;
            }
            Tok::Str(key) => {
                *pos += 1;
                match tokens.get(*pos) {
                    Some(Tok::Open) => {
                        *pos += 1;
                        let child = parse_block(tokens, pos);
                        map.insert(key.clone(), Value::Object(child));
                    }
                    Some(Tok::Str(val)) => {
                        map.insert(key.clone(), Value::String(val.clone()));
                        *pos += 1;
                    }
                    _ => {}
                }
            }
        }
    }
    map
}

#[cfg(test)]
mod tests {
    #[test]
    fn library_folders() {
        let v = super::parse(
            r#""libraryfolders"
{
	"0"
	{
		"path"		"C:\\Program Files (x86)\\Steam"
		"apps" { "304050" "123" }
	}
}"#,
        );
        assert_eq!(v["libraryfolders"]["0"]["path"], "C:\\Program Files (x86)\\Steam");
        assert_eq!(v["libraryfolders"]["0"]["apps"]["304050"], "123");
    }
}
