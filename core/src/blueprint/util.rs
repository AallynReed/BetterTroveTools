//! The engine's error classes, and an insertion-ordered map with Python `dict` semantics
//! (a re-assigned key keeps its first slot), which several answers depend on.

use std::collections::HashMap;
use std::hash::{BuildHasherDefault, Hash, Hasher};

/// The `ValueError` subclasses the engine raises; which ones are caught where decides
/// whether a request ends as a 400 or a 500.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Kind {
    Editor,
    Blueprint,
    Transform,
    Merge,
    Qb,
    Tmod,
    Workshop,
}

#[derive(Debug)]
pub enum Error {
    /// A raised engine error, by class.
    Value(Kind, String),
    /// `_Refused(status, detail)`.
    Refused(u16, String),
    /// A `bottle.HTTPError` (a malformed body): status and message.
    Http(u16, String),
    /// An exception Python lets escape the route, which bottle turns into a 500.
    Internal(String),
}

pub type Result<T> = std::result::Result<T, Error>;

impl Error {
    pub fn editor(msg: impl Into<String>) -> Self {
        Error::Value(Kind::Editor, msg.into())
    }

    pub fn value(kind: Kind, msg: impl Into<String>) -> Self {
        Error::Value(kind, msg.into())
    }

    pub fn internal(msg: impl Into<String>) -> Self {
        Error::Internal(msg.into())
    }

    /// `except (kinds...) as exc: raise EditorError(str(exc))`.
    pub fn into_editor(self, kinds: &[Kind]) -> Self {
        match self {
            Error::Value(k, m) if kinds.contains(&k) => Error::Value(Kind::Editor, m),
            other => other,
        }
    }
}

/// FxHash: the cell maps hash millions of small integer keys.
#[derive(Default, Clone, Copy)]
pub struct FxHasher(u64);

impl Hasher for FxHasher {
    fn write(&mut self, bytes: &[u8]) {
        for &b in bytes {
            self.write_u64(b as u64);
        }
    }

    fn write_u64(&mut self, v: u64) {
        self.0 = (self.0.rotate_left(5) ^ v).wrapping_mul(0x517c_c1b7_2722_0a95);
    }

    fn write_i64(&mut self, v: i64) {
        self.write_u64(v as u64);
    }

    fn write_u32(&mut self, v: u32) {
        self.write_u64(v as u64);
    }

    fn write_usize(&mut self, v: usize) {
        self.write_u64(v as u64);
    }

    fn finish(&self) -> u64 {
        self.0
    }
}

pub type FxBuild = BuildHasherDefault<FxHasher>;
pub type FxMap<K, V> = HashMap<K, V, FxBuild>;

pub fn fx_map<K, V>(capacity: usize) -> FxMap<K, V> {
    HashMap::with_capacity_and_hasher(capacity, FxBuild::default())
}

pub type Cell = (i64, i64, i64);

/// A Python dict: iteration in first-insertion order, re-assignment in place.
#[derive(Clone)]
pub struct OrderedMap<K, V> {
    index: FxMap<K, usize>,
    pub items: Vec<(K, V)>,
}

impl<K: Hash + Eq + Copy, V> OrderedMap<K, V> {
    pub fn with_capacity(n: usize) -> Self {
        OrderedMap { index: fx_map(n), items: Vec::with_capacity(n) }
    }

    /// `d[k] = v`; true when `k` was already there.
    pub fn insert(&mut self, k: K, v: V) -> bool {
        match self.index.get(&k) {
            Some(&i) => {
                self.items[i].1 = v;
                true
            }
            None => {
                self.index.insert(k, self.items.len());
                self.items.push((k, v));
                false
            }
        }
    }

    pub fn get(&self, k: &K) -> Option<&V> {
        self.index.get(k).map(|&i| &self.items[i].1)
    }

    pub fn contains(&self, k: &K) -> bool {
        self.index.contains_key(k)
    }

    pub fn len(&self) -> usize {
        self.items.len()
    }

    pub fn is_empty(&self) -> bool {
        self.items.is_empty()
    }

    pub fn iter(&self) -> impl Iterator<Item = &(K, V)> {
        self.items.iter()
    }
}
