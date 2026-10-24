//! Parity with the Python model, against fixtures recorded by tools/parity/modfile.py.

use std::path::{Path, PathBuf};

use md5::{Digest, Md5};
use serde_json::{json, Value};

use super::*;

fn fixtures() -> PathBuf {
    Path::new(env!("CARGO_MANIFEST_DIR")).join("tests/fixtures/modfile")
}

fn load(name: &str) -> Value {
    serde_json::from_str(&std::fs::read_to_string(fixtures().join(name)).unwrap()).unwrap()
}

fn md5_hex(data: &[u8]) -> String {
    hex::encode(Md5::digest(data))
}

fn payload(n: usize, seed: usize) -> Vec<u8> {
    (0..n).map(|i| ((i * seed + 7) % 251) as u8).collect()
}

type Case = (Vec<(&'static str, &'static str)>, Vec<(&'static str, Vec<u8>)>, u16);

/// The cases of `build_cases()` in the parity script.
fn build_case(key: &str) -> TroveMod {
    let (props, files, version): Case = match key {
        "simple" => (vec![("title", "Simple"), ("author", "me")], vec![("ui/a.swf", b"abc".to_vec())], 1),
        "unicode" => (
            vec![("title", "Café 中文"), ("author", "é"), ("notes", "nötes")],
            vec![("ui/été.swf", payload(5, 3)), ("ui/My Mod.cfg", b"[x]\nk = v".to_vec())],
            1,
        ),
        "multi_block" => (
            vec![("title", "Multi"), ("author", "a"), ("modLoader", "X"), ("tags", "a,b")],
            vec![("textures/big.png", payload(70001, 11)), ("ui/empty.swf", Vec::new()), ("ui/three.swf", b"xyz".to_vec())],
            1,
        ),
        "exact_block" => (vec![("title", "Exact"), ("author", "a")], vec![("ui/a.swf", payload(32768, 5))], 1),
        "version3" => (vec![("title", "V3"), ("author", "a")], vec![("ui/a.swf", b"1".to_vec())], 3),
        _ => unreachable!(),
    };
    let mut m = TroveMod::new(ModKind::Tmod);
    m.version = version;
    for (k, v) in props {
        m.add_property(k, v);
    }
    for (p, d) in files {
        m.add_file(ModFile::new(p, d)).unwrap();
    }
    m
}

fn describe(m: &mut TroveMod) -> Value {
    let files: Vec<Value> = m
        .files
        .iter()
        .map(|f| {
            json!({"path": f.trove_path, "index": f.index, "offset": f.offset, "size": f.size(),
                   "checksum": f.checksum().unwrap(), "md5": md5_hex(f.data().unwrap())})
        })
        .collect();
    json!({
        "version": m.version,
        "properties": m.properties.iter().map(|p| json!([p.name, p.value])).collect::<Vec<_>>(),
        "files": files,
        "hash": m.hash().unwrap(),
        "name": m.name(),
        "tags": m.tags(),
        "subtype": m.subtype(),
        "preview": m.preview_path(),
        "config": m.config_path(),
        "is_ui": m.is_ui_mod(),
        "content_files": m.content_files(),
        "image_md5": md5_hex(m.image().unwrap().as_bytes()),
    })
}

#[test]
#[cfg_attr(not(windows), ignore = "fixtures recorded with Windows pathlib")]
fn internal_paths_normalize_like_python() {
    for (input, expected) in load("internal_paths.json").as_object().unwrap() {
        let got = normalize_internal_path(input);
        assert_eq!(got.as_deref(), expected.as_str(), "{input:?}");
    }
}

#[test]
fn builds_are_byte_identical() {
    let built = load("built.json");
    for key in ["simple", "unicode", "multi_block", "exact_block", "version3"] {
        let mut m = build_case(key);
        let bytes = m.compile_tmod().unwrap();
        assert_eq!(md5_hex(&bytes), built[key]["md5"], "{key}");
        let file = fixtures().join(format!("{key}.tmod"));
        if file.exists() {
            assert_eq!(bytes, std::fs::read(file).unwrap(), "{key} bytes");
        }
        assert_eq!(m.metadata().unwrap(), built[key]["metadata"], "{key} metadata");
        let props: Vec<Value> = m.properties.iter().map(|p| json!([p.name, p.value])).collect();
        assert_eq!(Value::Array(props), built[key]["properties"], "{key} properties");
    }
}

#[test]
fn reads_match_python() {
    let built = load("built.json");
    for key in ["simple", "unicode", "version3"] {
        let data = std::fs::read(fixtures().join(format!("{key}.tmod"))).unwrap();
        let mut m = TroveMod::read_tmod(Path::new(&format!("{key}.tmod")), data.clone(), false).unwrap();
        assert_eq!(describe(&mut m), built[format!("{key}_read")], "{key}");
        m.reset_cache();
        assert_eq!(m.compile_tmod().unwrap(), data, "{key} rebuilt");
    }
    let legacy = std::fs::read(fixtures().join("legacy_char_lengths.tmod")).unwrap();
    assert!(format::header_uses_char_lengths(&legacy));
    let mut m = TroveMod::read_tmod(Path::new("legacy.tmod"), legacy, false).unwrap();
    assert_eq!(describe(&mut m), built["legacy_read"]);

    let zip = std::fs::read(fixtures().join("zipped.zip")).unwrap();
    let mut z = TroveMod::read_zip(Path::new("Zipped Mod.zip"), zip).unwrap();
    assert_eq!(describe(&mut z), built["zip_read"]);
}

#[test]
fn tpack_container_matches_modpacks() {
    let built = load("built.json");
    let mut files: Vec<ModFile> = [("Simple Mod.tmod", "simple.tmod"), ("Café.tmod", "unicode.tmod")]
        .iter()
        .map(|(name, src)| {
            let mut f = ModFile::new(name, std::fs::read(fixtures().join(src)).unwrap());
            f.trove_path = name.to_string();
            f
        })
        .collect();
    let tpack = build_container(2, &[("title", "Pack"), ("author", "me")], &mut files).unwrap();
    assert_eq!(md5_hex(&tpack), built["tpack"]["md5"]);
    assert_eq!(json!(format::raw_file_names(&tpack).unwrap()), built["tpack"]["names"]);
}

#[test]
fn partial_reads_load_lazily() {
    let dir = std::env::temp_dir().join(format!("btt-modfile-{}", std::process::id()));
    std::fs::create_dir_all(&dir).unwrap();
    let path = dir.join("Multi.tmod");
    let bytes = build_case("multi_block").compile_tmod().unwrap();
    std::fs::write(&path, &bytes).unwrap();
    let header = format::header_slice(&bytes).to_vec();
    let mut m = TroveMod::read_tmod(&path, header.clone(), true).unwrap();
    assert_eq!(m.hash().unwrap(), md5_hex(&header));
    assert_eq!(m.files[0].data().unwrap(), payload(70001, 11).as_slice());
    assert_eq!(m.files[2].data().unwrap(), b"xyz");
    m.reset_cache();
    assert_eq!(m.compile_tmod().unwrap(), bytes);
    let _ = std::fs::remove_dir_all(dir);
}

fn env_paths(var: &str) -> Option<Vec<PathBuf>> {
    std::env::var(var).ok().map(|v| v.split(';').map(PathBuf::from).collect())
}

/// `BTT_PARITY_REAL=<mods>;<out of "modfile.py real">`.
#[test]
#[ignore]
fn real_mods_match_python() {
    let Some(paths) = env_paths("BTT_PARITY_REAL") else { panic!("set BTT_PARITY_REAL") };
    let (mods_dir, out) = (&paths[0], &paths[1]);
    let report = serde_json::from_str::<Value>(&std::fs::read_to_string(out.join("report.json")).unwrap()).unwrap();
    let mut checked = 0;
    for (name, want) in report.as_object().unwrap() {
        let path = mods_dir.join(name);
        let data = std::fs::read(&path).unwrap();
        if name.contains(".zip") {
            let mut m = TroveMod::read_zip(&path, data).unwrap();
            assert_eq!(describe(&mut m), want["zip"], "{name}");
            checked += 1;
            continue;
        }
        let mut full = TroveMod::read_tmod(&path, data.clone(), false).unwrap();
        assert_eq!(describe(&mut full), want["full"], "{name}");
        let header = format::header_slice(&data).to_vec();
        let mut partial = TroveMod::read_tmod(&path, header, true).unwrap();
        assert_eq!(partial.hash().unwrap(), want["partial_hash"], "{name} partial hash");
        for (p, f) in partial.files.iter().zip(&full.files) {
            assert_eq!(p.data().unwrap(), f.data().unwrap(), "{name} lazy {}", p.trove_path);
        }
        full.reset_cache();
        let rebuilt = full.compile_tmod().unwrap();
        assert_eq!(rebuilt, std::fs::read(out.join(format!("{name}.rebuilt"))).unwrap(), "{name} rebuilt bytes");
        checked += 1;
    }
    eprintln!("{checked} real mods match");
}

fn copy_dir(from: &Path, to: &Path) {
    std::fs::create_dir_all(to).unwrap();
    for e in std::fs::read_dir(from).unwrap() {
        let e = e.unwrap();
        std::fs::copy(e.path(), to.join(e.file_name())).unwrap();
    }
}

fn snapshot(root: &Path) -> Value {
    let mut out = serde_json::Map::new();
    if root.exists() {
        let mut files: Vec<PathBuf> = walkdir::WalkDir::new(root).into_iter().filter_map(|e| e.ok()).filter(|e| e.file_type().is_file()).map(|e| e.into_path()).collect();
        files.sort();
        for f in files {
            let rel = f.strip_prefix(root).unwrap().to_string_lossy().replace('\\', "/");
            out.insert(rel, json!(md5_hex(&std::fs::read(&f).unwrap())));
        }
    }
    Value::Object(out)
}

/// `BTT_PARITY_LIST=<mods>;<python side of "modfile.py list">;<scratch dir for this side>`.
#[test]
#[ignore]
fn mod_list_matches_python() {
    let Some(paths) = env_paths("BTT_PARITY_LIST") else { panic!("set BTT_PARITY_LIST") };
    let (mods_src, py_side, side) = (&paths[0], &paths[1], &paths[2]);
    let _ = std::fs::remove_dir_all(side);
    let game = side.join("game");
    copy_dir(mods_src, &game.join("mods"));
    std::env::set_var("APPDATA", side.join("appdata"));
    let mut list = TroveModList::new(
        crate::game::registry::TroveGamePath::new(&game, None),
        ListOptions { partial: true, fix_names: true, fix_configs: true, ..Default::default() },
    )
    .unwrap();
    let mut rows = Vec::new();
    for i in 0..list.mods.len() {
        let mut conflicts: Vec<String> = list.conflicts_of(i).iter().map(|c| c.name().unwrap_or("").to_string()).collect();
        conflicts.sort();
        let m = &mut list.mods[i];
        rows.push(json!({
            "name": m.name(), "author": m.author(), "version": m.mod_version(), "enabled": m.enabled,
            "path": m.mod_path.strip_prefix(&game).unwrap().to_string_lossy().replace('\\', "/"),
            "hash": m.hash().unwrap(), "image_md5": md5_hex(m.image().unwrap().as_bytes()),
            "has_conflicts": m.has_conflicts(), "conflicts": conflicts, "wrong_name": m.has_wrong_name(),
        }));
    }
    let mut mods_dir: Vec<String> = std::fs::read_dir(game.join("mods")).unwrap().map(|e| e.unwrap().file_name().to_string_lossy().into_owned()).collect();
    mods_dir.sort();
    let got = json!({
        "mods": rows, "read_only_configs": list.read_only_configs, "mods_dir": mods_dir,
        "mod_cfgs": snapshot(&side.join("appdata").join("Trove").join("ModCfgs")),
    });
    let want: Value = serde_json::from_str(&std::fs::read_to_string(py_side.join("list.json")).unwrap()).unwrap();
    for (g, w) in got["mods"].as_array().unwrap().iter().zip(want["mods"].as_array().unwrap()) {
        assert_eq!(g, w);
    }
    assert_eq!(got, want);
}

#[test]
fn zip_compile_matches_pythons_recursion() {
    let zip = std::fs::read(fixtures().join("zipped.zip")).unwrap();
    let mut z = TroveMod::read_zip(Path::new("Zipped Mod.zip"), zip.clone()).unwrap();
    assert_eq!(z.compile_zip_mod().unwrap(), zip);
    z.reset_cache();
    assert_eq!(z.hash().unwrap_err().to_string(), "maximum recursion depth exceeded");
}

#[test]
fn one_bad_file_does_not_hide_the_folder() {
    let root = std::env::temp_dir().join(format!("btt-modlist-{}", std::process::id()));
    let mods = root.join("mods");
    let _ = std::fs::remove_dir_all(&root);
    std::fs::create_dir_all(&mods).unwrap();
    std::fs::write(mods.join("Simple.tmod"), build_case("simple").compile_tmod().unwrap()).unwrap();
    let mut untitled = TroveMod::new(ModKind::Tmod);
    untitled.add_property("author", "me");
    untitled.add_file(ModFile::new("ui/b.swf", b"b".to_vec())).unwrap();
    std::fs::write(mods.join("untitled.tmod"), untitled.compile_tmod().unwrap()).unwrap();
    std::fs::write(mods.join("garbage.tmod"), b"\x10\0\0\0\0\0\0\0not a mod").unwrap();

    let list = TroveModList::new(
        crate::game::registry::TroveGamePath::new(&root, None),
        ListOptions { partial: true, fix_names: true, ..Default::default() },
    )
    .unwrap();
    let names: Vec<Option<&str>> = list.mods.iter().map(|m| m.name()).collect();
    assert_eq!(names, vec![Some("Simple"), None]);
    assert_eq!(list.unreadable.len(), 1);
    assert!(list.unreadable[0].0.ends_with("garbage.tmod"));
    let _ = std::fs::remove_dir_all(&root);
}
