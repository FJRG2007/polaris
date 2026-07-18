//! Security primitives shared across the daemon.
//!
//! This process runs effectively as root, so every routine here treats its
//! input as hostile: the bearer token is compared in constant time, request
//! paths are canonicalized and confined to an allowlist root, and mount fields
//! are validated against shell metacharacters even though we never touch a
//! shell (defense in depth for the arg-vector `mount`/`umount` calls).

use std::path::{Component, Path, PathBuf};

/// Compare two byte strings without leaking, through timing, where they first
/// differ. The token length is not secret (it is fixed), so an early length
/// check is fine; the byte comparison itself never short-circuits.
pub fn constant_time_eq(a: &[u8], b: &[u8]) -> bool {
    if a.len() != b.len() {
        return false;
    }
    let mut diff = 0u8;
    for (x, y) in a.iter().zip(b.iter()) {
        diff |= x ^ y;
    }
    diff == 0
}

/// Generate a fresh 256-bit token, hex-encoded (64 chars).
///
/// On Linux (the only real target) the bytes come from `/dev/urandom`, which
/// is the correct CSPRNG source and needs no `rand` dependency. The non-unix
/// branch exists solely so the crate compiles on a Windows dev box; it is never
/// exercised in production and is intentionally not cryptographically strong.
pub fn generate_token() -> String {
    let mut bytes = [0u8; 32];
    #[cfg(unix)]
    {
        use std::io::Read;
        // A short read from /dev/urandom is not expected; loop to be safe.
        let mut f = std::fs::File::open("/dev/urandom").expect("open /dev/urandom");
        f.read_exact(&mut bytes).expect("read /dev/urandom");
    }
    #[cfg(not(unix))]
    {
        // Dev-only fallback: mixes clock + address entropy. Not for production.
        use std::time::{SystemTime, UNIX_EPOCH};
        let seed = SystemTime::now()
            .duration_since(UNIX_EPOCH)
            .map(|d| d.as_nanos())
            .unwrap_or(0);
        let addr = &bytes as *const _ as usize as u128;
        let mut state = seed ^ (addr << 64) ^ (std::process::id() as u128);
        for b in bytes.iter_mut() {
            // xorshift-style mixing; adequate only for a placeholder on Windows.
            state ^= state << 13;
            state ^= state >> 7;
            state ^= state << 17;
            *b = (state & 0xff) as u8;
        }
    }
    let mut hex = String::with_capacity(64);
    for b in bytes {
        hex.push_str(&format!("{b:02x}"));
    }
    hex
}

/// Resolve `requested` (a relative path already stripped of its route prefix)
/// against `root`, guaranteeing the result cannot escape `root`.
///
/// Two independent defenses are applied:
///   1. Lexical: `..` components and NUL bytes are rejected outright, so no
///      request can walk upward even before the filesystem is consulted.
///   2. Canonical: the deepest existing ancestor is canonicalized and checked
///      to still live under the canonical root, which also defeats symlink
///      escapes. The remaining (not-yet-created) components are appended, so a
///      `PUT` to a new file still resolves correctly.
///
/// Returns the absolute path to operate on, or `Err` if it escapes the root.
pub fn resolve_within(root: &Path, requested: &str) -> Result<PathBuf, PathError> {
    if requested.as_bytes().contains(&0) {
        return Err(PathError::Nul);
    }

    // Build the relative path, rejecting any upward or absolute component.
    let mut rel = PathBuf::new();
    for comp in Path::new(requested).components() {
        match comp {
            Component::Normal(part) => rel.push(part),
            Component::CurDir => {}
            // `..`, a leading `/`, or a Windows drive prefix would let the join
            // reset outside root. None are ever legitimate here.
            Component::ParentDir | Component::RootDir | Component::Prefix(_) => {
                return Err(PathError::Escape);
            }
        }
    }

    let candidate = root.join(&rel);
    let canonical_root = root.canonicalize().map_err(|_| PathError::Escape)?;

    // Canonicalize the deepest ancestor that exists, then re-attach the tail.
    let mut existing = candidate.as_path();
    let mut tail: Vec<&std::ffi::OsStr> = Vec::new();
    let resolved_base = loop {
        match existing.canonicalize() {
            Ok(p) => break p,
            Err(_) => match existing.parent() {
                Some(parent) => {
                    if let Some(name) = existing.file_name() {
                        tail.push(name);
                    }
                    existing = parent;
                }
                // Ran out of ancestors without finding an existing one.
                None => return Err(PathError::Escape),
            },
        }
    };

    if !resolved_base.starts_with(&canonical_root) {
        return Err(PathError::Escape);
    }

    let mut out = resolved_base;
    for name in tail.iter().rev() {
        out.push(name);
    }
    Ok(out)
}

#[derive(Debug, PartialEq, Eq)]
pub enum PathError {
    /// Contained a NUL byte.
    Nul,
    /// Escaped (or would escape) the allowlist root.
    Escape,
}

/// Characters that must never appear in a mount field. We invoke `mount` with
/// an argument vector (never a shell), so these are not directly exploitable,
/// but rejecting them stops smuggling of option separators and keeps the values
/// well-formed. NUL is rejected separately with a clearer error.
const FORBIDDEN_MOUNT_CHARS: &[char] = &[
    ';', '&', '|', '$', '`', '\n', '\r', '\t', '<', '>', '(', ')', '{', '}', '*', '?', '[', ']',
    '!', '\\', '\'', '"', ' ',
];

/// Validate a free-form mount field (source, target, options).
pub fn validate_mount_field(name: &str, value: &str) -> Result<(), String> {
    if value.is_empty() {
        return Err(format!("{name} must not be empty"));
    }
    if value.as_bytes().contains(&0) {
        return Err(format!("{name} contains a NUL byte"));
    }
    if let Some(c) = value.chars().find(|c| FORBIDDEN_MOUNT_CHARS.contains(c)) {
        return Err(format!("{name} contains a forbidden character: {c:?}"));
    }
    Ok(())
}

/// Validate a mount id. Ids name both the registry key and, by convention, a
/// path segment, so they are held to a strict allowlist.
pub fn validate_mount_id(id: &str) -> Result<(), String> {
    if id.is_empty() || id.len() > 128 {
        return Err("id must be 1-128 characters".into());
    }
    if !id
        .chars()
        .all(|c| c.is_ascii_alphanumeric() || c == '-' || c == '_')
    {
        return Err("id may only contain letters, digits, '-' and '_'".into());
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::fs;

    #[test]
    fn constant_time_eq_matches_and_rejects() {
        assert!(constant_time_eq(b"abc123", b"abc123"));
        assert!(!constant_time_eq(b"abc123", b"abc124"));
        // Differing lengths never compare equal.
        assert!(!constant_time_eq(b"abc", b"abcd"));
        assert!(!constant_time_eq(b"", b"x"));
        assert!(constant_time_eq(b"", b""));
    }

    fn temp_root(tag: &str) -> PathBuf {
        let dir =
            std::env::temp_dir().join(format!("polaris-hostd-test-{tag}-{}", std::process::id()));
        fs::create_dir_all(&dir).unwrap();
        dir
    }

    #[test]
    fn resolve_within_allows_child_paths() {
        let root = temp_root("ok");
        fs::create_dir_all(root.join("sub")).unwrap();
        fs::write(root.join("sub/file.txt"), b"x").unwrap();
        let resolved = resolve_within(&root, "sub/file.txt").unwrap();
        assert!(resolved.starts_with(root.canonicalize().unwrap()));
        // A not-yet-existing file under an existing dir still resolves.
        let new = resolve_within(&root, "sub/new.txt").unwrap();
        assert!(new.starts_with(root.canonicalize().unwrap()));
        fs::remove_dir_all(&root).ok();
    }

    #[test]
    fn resolve_within_rejects_parent_traversal() {
        let root = temp_root("esc");
        assert_eq!(
            resolve_within(&root, "../etc/passwd"),
            Err(PathError::Escape)
        );
        assert_eq!(resolve_within(&root, "a/../../b"), Err(PathError::Escape));
        assert_eq!(resolve_within(&root, "sub/../../x"), Err(PathError::Escape));
        fs::remove_dir_all(&root).ok();
    }

    #[test]
    fn resolve_within_rejects_absolute_and_nul() {
        let root = temp_root("abs");
        // A leading separator must not reset the join outside root.
        #[cfg(unix)]
        assert_eq!(resolve_within(&root, "/etc/passwd"), Err(PathError::Escape));
        assert_eq!(resolve_within(&root, "a\0b"), Err(PathError::Nul));
        fs::remove_dir_all(&root).ok();
    }

    #[test]
    fn mount_field_rejects_metacharacters() {
        assert!(validate_mount_field("source", "//nas/share").is_ok());
        assert!(validate_mount_field("target", "backups").is_ok());
        for bad in [
            "a;rm -rf", "a$(x)", "a|b", "a`b`", "a&b", "a b", "a\nb", "a>b",
        ] {
            assert!(
                validate_mount_field("source", bad).is_err(),
                "expected rejection for {bad:?}"
            );
        }
        assert!(validate_mount_field("source", "a\0b").is_err());
        assert!(validate_mount_field("source", "").is_err());
    }

    #[test]
    fn mount_id_allowlist() {
        assert!(validate_mount_id("nas-backups_01").is_ok());
        for bad in ["", "has space", "../x", "a/b", "a;b", "a$b"] {
            assert!(
                validate_mount_id(bad).is_err(),
                "expected rejection for {bad:?}"
            );
        }
    }
}
