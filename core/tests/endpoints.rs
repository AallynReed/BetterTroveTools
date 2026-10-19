//! Every function the Python backend exposed over eel must exist in btt-core under the same name.
//! The list was snapshotted from the Python sources before they were removed.

use std::collections::BTreeSet;
use std::path::Path;

#[test]
fn every_python_endpoint_is_ported() {
    let list = Path::new(env!("CARGO_MANIFEST_DIR")).join("tests/fixtures/python_endpoints.txt");
    let python: BTreeSet<String> = std::fs::read_to_string(list).unwrap().lines().filter(|l| !l.is_empty()).map(String::from).collect();
    assert_eq!(python.len(), 199);
    let rust: BTreeSet<String> = btt_core::command_names().into_iter().map(String::from).collect();
    let missing: Vec<_> = python.difference(&rust).cloned().collect();
    assert!(missing.is_empty(), "{} of {} endpoints not ported:\n{}", missing.len(), python.len(), missing.join("\n"));
}
