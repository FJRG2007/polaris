//! Fetches the ONNX classifier weights the `nld_classifier_v3` feature embeds.
//!
//! The weights are not tracked in git (they would put 17 MB into every clone of
//! the repository). They live as an asset on the `terminal-assets-v1` release and
//! are pinned here by sha256, so a build either embeds exactly those bytes or
//! fails. The downloaded file stays in `models/onnx/` (git-ignored) and is the
//! cache: a later build with a matching file does not touch the network.
//! `POLARIS_TERMINAL_ASSETS_DIR` may point at a directory that already holds the
//! file (an offline build, or a CI cache).

use std::env;
use std::fs;
use std::path::{Path, PathBuf};
use std::process::Command;

use sha2::{Digest, Sha256};

const MODEL_FILE: &str = "bert_tiny_v3.onnx";
const MODEL_SHA256: &str = "d649a9cf72bb8c188cea7f290290f12e3a3ac4031469cd5144f17a500b46b166";
const MODEL_URL: &str =
    "https://github.com/FJRG2007/polaris/releases/download/terminal-assets-v1/bert_tiny_v3.onnx";

fn main() {
    println!("cargo:rerun-if-changed=build.rs");
    println!("cargo:rerun-if-env-changed=POLARIS_TERMINAL_ASSETS_DIR");
    if env::var_os("CARGO_FEATURE_NLD_CLASSIFIER_V3").is_none() {
        return;
    }
    let manifest_dir = PathBuf::from(env::var("CARGO_MANIFEST_DIR").expect("CARGO_MANIFEST_DIR"));
    let target = manifest_dir.join("models").join("onnx").join(MODEL_FILE);
    println!("cargo:rerun-if-changed={}", target.display());
    if matches(&target) {
        return;
    }
    if let Some(dir) = env::var_os("POLARIS_TERMINAL_ASSETS_DIR") {
        let cached = Path::new(&dir).join(MODEL_FILE);
        if matches(&cached) {
            fs::copy(&cached, &target).expect("copy the cached classifier model");
            return;
        }
    }
    let partial = target.with_extension("onnx.part");
    let status = Command::new("curl")
        .args(["--fail", "--location", "--silent", "--show-error", "--retry", "3", "--output"])
        .arg(&partial)
        .arg(MODEL_URL)
        .status();
    match status {
        Ok(status) if status.success() => {}
        Ok(status) => panic!("downloading {MODEL_URL} failed ({status}); set POLARIS_TERMINAL_ASSETS_DIR to a directory holding {MODEL_FILE} to build offline"),
        Err(err) => panic!("could not run curl to download {MODEL_URL}: {err}"),
    }
    if !matches(&partial) {
        let _ = fs::remove_file(&partial);
        panic!("{MODEL_URL} did not match the pinned sha256 {MODEL_SHA256}");
    }
    fs::rename(&partial, &target).expect("move the classifier model into place");
    if let Some(dir) = env::var_os("POLARIS_TERMINAL_ASSETS_DIR") {
        let _ = fs::create_dir_all(&dir);
        let _ = fs::copy(&target, Path::new(&dir).join(MODEL_FILE));
    }
}

fn matches(path: &Path) -> bool {
    match fs::read(path) {
        Ok(bytes) => hex(&Sha256::digest(&bytes)) == MODEL_SHA256,
        Err(_) => false,
    }
}

fn hex(bytes: &[u8]) -> String {
    bytes.iter().map(|b| format!("{b:02x}")).collect()
}
