//! Which published release of the app is newer than the one running. Pure, for
//! the tests.
//!
//! The Electron app is released from the Polaris repository under `desktop-v`
//! tags (`.github/workflows/desktop.yml`), beside the dashboard's own releases and
//! never marked as the repository's latest one, so the answer is read from the list
//! of releases: the highest published version under the app's prefix. The beta has
//! a prefix of its own that the Electron app never reads, so no Tauri build can be
//! offered to an Electron install by accident.
//!
//! The Rust twin of `desktop/src/main/releases.ts`.

use serde::Deserialize;
use std::cmp::Ordering;
use std::collections::{HashMap, HashSet};

/// The Electron app's tag prefix: the one `desktop.yml` publishes under.
pub const TAG_PREFIX: &str = "desktop-v";

/// The beta's tag prefix. It must never start with [`TAG_PREFIX`], or every
/// Electron install would take a beta release for one of its own.
pub const BETA_TAG_PREFIX: &str = "desktop-tauri-v";

/// The checksums file the release job attaches beside the installers.
pub const CHECKSUMS: &str = "SHA256SUMS";

/// `major.minor.patch`.
pub type Version = [u64; 3];

/// `1.2.3` as numbers; `None` for anything else, a pre-release included.
pub fn parse_version(text: &str) -> Option<Version> {
    let mut parts = text.split('.');
    let mut version = [0_u64; 3];
    for slot in &mut version {
        let part = parts.next()?;
        if part.is_empty() || !part.bytes().all(|byte| byte.is_ascii_digit()) {
            return None;
        }
        *slot = part.parse().ok()?;
    }
    parts.next().is_none().then_some(version)
}

fn compare(a: &Version, b: &Version) -> Ordering {
    a.cmp(b)
}

/// Where the app's releases are listed and shown.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct ReleaseSource {
    owner: String,
    repo: String,
}

impl ReleaseSource {
    /// The release list, as GitHub's API serves it.
    pub fn api(&self) -> String {
        format!(
            "https://api.github.com/repos/{}/{}/releases?per_page=100",
            self.owner, self.repo
        )
    }

    /// A release's page.
    pub fn page(&self, tag: &str) -> String {
        format!(
            "https://github.com/{}/{}/releases/tag/{}",
            self.owner,
            self.repo,
            encode_uri_component(tag)
        )
    }

    /// Where a release's files are, as the folder Squirrel reads `RELEASES` and
    /// the package from.
    pub fn download(&self, tag: &str) -> String {
        format!(
            "https://github.com/{}/{}/releases/download/{}",
            self.owner,
            self.repo,
            encode_uri_component(tag)
        )
    }
}

fn is_name_char(character: char) -> bool {
    character.is_ascii_alphanumeric() || matches!(character, '_' | '.' | '-')
}

/// Where the releases are, from the manifest's `repository`. `None` when that is
/// not a GitHub repository.
pub fn release_source(repository: &str) -> Option<ReleaseSource> {
    let rest = repository.strip_prefix("git+").unwrap_or(repository);
    let rest = rest.strip_prefix("https://github.com/")?;
    let rest = rest.strip_suffix('/').unwrap_or(rest);
    let (owner, repo) = rest.split_once('/')?;
    let repo = repo.strip_suffix(".git").unwrap_or(repo);
    let valid = |name: &str| !name.is_empty() && name.chars().all(is_name_char);
    (valid(owner) && valid(repo)).then(|| ReleaseSource {
        owner: owner.to_owned(),
        repo: repo.to_owned(),
    })
}

/// JavaScript's `encodeURIComponent`.
fn encode_uri_component(text: &str) -> String {
    let mut encoded = String::with_capacity(text.len());
    for byte in text.bytes() {
        if byte.is_ascii_alphanumeric() || b"-_.!~*'()".contains(&byte) {
            encoded.push(byte as char);
        } else {
            encoded.push_str(&format!("%{byte:02X}"));
        }
    }
    encoded
}

/// A file attached to a release, as the release list names and sizes it.
#[derive(Debug, Clone, PartialEq, Eq, Deserialize)]
pub struct Asset {
    pub name: String,
    pub size: u64,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Release {
    pub version: String,
    pub tag: String,
    pub assets: Vec<Asset>,
}

#[derive(Deserialize)]
struct ListedRelease {
    tag_name: String,
    draft: bool,
    prerelease: bool,
    #[serde(default)]
    assets: Vec<Asset>,
}

/// The newest published release under `prefix` that is newer than `current`, or
/// `None` when there is none or the body is not a release list.
pub fn newer_release(body: &serde_json::Value, current: &str, prefix: &str) -> Option<Release> {
    let running = parse_version(current)?;
    let releases = Vec::<ListedRelease>::deserialize(body).ok()?;
    let mut newest: Option<(Release, Version)> = None;
    for release in releases {
        if release.draft || release.prerelease {
            continue;
        }
        let Some(text) = release.tag_name.strip_prefix(prefix) else {
            continue;
        };
        let Some(version) = parse_version(text) else {
            continue;
        };
        if compare(&version, &running) != Ordering::Greater {
            continue;
        }
        if newest
            .as_ref()
            .is_none_or(|(_, best)| compare(&version, best) == Ordering::Greater)
        {
            newest = Some((
                Release {
                    version: text.to_owned(),
                    tag: release.tag_name.clone(),
                    assets: release.assets,
                },
                version,
            ));
        }
    }
    newest.map(|(release, _)| release)
}

/// The update feed the release job writes for a macOS architecture, read by
/// Squirrel.Mac as a `json` server. Named the same in `desktop/build/mac-feed.cjs`.
pub fn mac_feed_name(arch: &str) -> String {
    format!("RELEASES-darwin-{arch}.json")
}

/// One `sha256sum` line: the digest and the name, text or binary mode.
fn checksum_line(line: &str) -> Option<(&str, &str)> {
    let digest = line.get(..64)?;
    if !digest.bytes().all(|byte| byte.is_ascii_hexdigit()) {
        return None;
    }
    let rest = line[64..].strip_prefix(' ')?;
    let name = rest.strip_prefix(' ').or_else(|| rest.strip_prefix('*'))?;
    (!name.is_empty()).then_some((digest, name))
}

/// `sha256sum` output as file name to lowercase digest. Lines that are not one are
/// skipped; a name listed twice keeps neither, since it is not known which one is
/// right.
pub fn parse_checksums(text: &str) -> HashMap<String, String> {
    let mut sums = HashMap::new();
    let mut repeated = HashSet::new();
    for line in text.split('\n') {
        let Some((digest, name)) = checksum_line(line.trim()) else {
            continue;
        };
        if sums
            .insert(name.to_owned(), digest.to_ascii_lowercase())
            .is_some()
        {
            repeated.insert(name.to_owned());
        }
    }
    for name in repeated {
        sums.remove(&name);
    }
    sums
}

fn arch_names(arch: &str) -> Option<&'static [&'static str]> {
    match arch {
        "x64" => Some(&["x64", "x86_64", "amd64"]),
        "arm64" => Some(&["arm64", "aarch64"]),
        _ => None,
    }
}

/// The release's AppImage for this architecture (Node's names: `x64`, `arm64`),
/// or `None` when it has none or more than one could be meant.
pub fn app_image_asset<'a>(assets: &'a [Asset], arch: &str) -> Option<&'a Asset> {
    let names = arch_names(arch)?;
    let mut matching = assets.iter().filter(|asset| {
        asset.size > 0
            && asset
                .name
                .strip_suffix(".AppImage")
                .is_some_and(|stem| stem.split(['-', '.']).any(|part| names.contains(&part)))
    });
    let first = matching.next()?;
    matching.next().is_none().then_some(first)
}
