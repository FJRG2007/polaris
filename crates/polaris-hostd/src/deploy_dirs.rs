//! The compose working directories under the deploy root.
//!
//! Every deploy writes `<deploy root>/<project>/compose.yml`, and `compose down`
//! leaves the directory behind. An application removed before Polaris cleaned up
//! after itself therefore leaves a directory nothing will ever read again. These
//! two calls let the dashboard list them and remove one it names - only ever a
//! directory shaped like an application's project (`polaris-<8 hex>`, optionally
//! with a release marker), so Polaris's own stack and anything else under the
//! root is out of reach.

use std::path::Path;
use std::process::{Command, Stdio};

/// Whether a name is the shape Polaris gives an application's compose project.
pub fn is_app_project(name: &str) -> bool {
    let Some(rest) = name.strip_prefix("polaris-") else {
        return false;
    };
    let (hash, marker) = match rest.split_once('-') {
        Some((hash, marker)) => (hash, Some(marker)),
        None => (rest, None),
    };
    let marker_ok = match marker {
        None => true,
        Some(m) => {
            (1..=8).contains(&m.len())
                && m.chars().all(|c| c.is_ascii_lowercase() || c.is_ascii_digit())
        }
    };
    hash.len() == 8
        && hash.chars().all(|c| c.is_ascii_digit() || ('a'..='f').contains(&c))
        && marker_ok
}

/// The application project directories directly under `root`, sorted.
pub fn list(root: &Path) -> std::io::Result<Vec<String>> {
    let mut names = Vec::new();
    for entry in std::fs::read_dir(root)? {
        let entry = entry?;
        // A symlink is never followed or listed: removal below must only ever
        // reach a real directory under the root.
        if !entry.file_type()?.is_dir() {
            continue;
        }
        if let Some(name) = entry.file_name().to_str() {
            if is_app_project(name) {
                names.push(name.to_string());
            }
        }
    }
    names.sort();
    Ok(names)
}

/// Whether any container, running or stopped, still belongs to the compose
/// project. `None` when the engine would not answer, which callers treat as
/// "cannot tell" and refuse on: a directory a live install still reads is never
/// removed on a guess.
pub fn project_in_use(name: &str) -> Option<bool> {
    if !is_app_project(name) {
        return None;
    }
    let output = Command::new("docker")
        .args(["ps", "-aq", "--filter"])
        .arg(format!("label=com.docker.compose.project={name}"))
        .stdin(Stdio::null())
        .output()
        .ok()?;
    if !output.status.success() {
        return None;
    }
    Some(!String::from_utf8_lossy(&output.stdout).trim().is_empty())
}

/// Remove one application project directory under `root`. A directory that is
/// not there is nothing to remove.
pub fn remove(root: &Path, name: &str) -> Result<bool, String> {
    if !is_app_project(name) {
        return Err("invalid project name".into());
    }
    let dir = root.join(name);
    match std::fs::symlink_metadata(&dir) {
        Err(_) => Ok(false),
        Ok(meta) if !meta.file_type().is_dir() => Err("not a directory".into()),
        Ok(_) => std::fs::remove_dir_all(&dir)
            .map(|_| true)
            .map_err(|e| format!("could not remove {name}: {e}")),
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn only_application_projects_match() {
        assert!(is_app_project("polaris-0a1b2c3d"));
        assert!(is_app_project("polaris-0a1b2c3d-r2"));
        for name in [
            "polaris",
            "polaris-",
            "polaris-0a1b2c3",
            "polaris-0a1b2c3dd",
            "polaris-0A1B2C3D",
            "polaris-0a1b2c3d-",
            "polaris-0a1b2c3d-toolongmk",
            "polaris-0a1b2c3d-R2",
            "polaris-ntunnel-0a1b2c3d",
            "polaris-0a1b2c3d/../x",
            "../polaris-0a1b2c3d",
        ] {
            assert!(!is_app_project(name), "{name}");
        }
    }

    #[test]
    fn lists_and_removes_only_project_directories() {
        let root =
            std::env::temp_dir().join(format!("polaris-dirs-test-{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&root);
        std::fs::create_dir_all(root.join("polaris-0a1b2c3d")).unwrap();
        std::fs::write(root.join("polaris-0a1b2c3d").join("compose.yml"), "x").unwrap();
        std::fs::create_dir_all(root.join("polaris-stack")).unwrap();
        std::fs::write(root.join("polaris-11111111"), "a file").unwrap();
        assert_eq!(list(&root).unwrap(), vec!["polaris-0a1b2c3d".to_string()]);
        assert!(remove(&root, "polaris-stack").is_err());
        assert!(remove(&root, "polaris-11111111").is_err());
        assert_eq!(remove(&root, "polaris-22222222"), Ok(false));
        assert_eq!(remove(&root, "polaris-0a1b2c3d"), Ok(true));
        assert!(list(&root).unwrap().is_empty());
        std::fs::remove_dir_all(&root).unwrap();
    }
}
