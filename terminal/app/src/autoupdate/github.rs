//! Checking GitHub releases for a newer Polaris Terminal.
//!
//! Upstream's update pipeline serves its own release channels and refuses the
//! `oss` channel outright ("these channels don't ship release artifacts"), which
//! is the one Polaris Terminal ships on. Polaris Terminal publishes to GitHub releases instead, so this
//! asks GitHub what the latest tag is.
//!
//! The Polaris repository releases more than the terminal (the desktop app, the
//! extension and others, each under its own tag prefix), so its "latest release"
//! is usually not a terminal one, and the terminal's are not marked latest at
//! all. Terminal releases are the `terminal-v*` tags: this lists those, orders
//! them, and reads the release of the newest.
//!
//! It only reports. Downloading and installing an update is left to the person,
//! because doing it properly means platform-specific install flows and a way to
//! verify what was downloaded, and neither exists here yet.

use std::cmp::Ordering;
use std::time::Duration;

use ::channel_versions::VersionInfo;
use anyhow::{Context, Result};
use serde::Deserialize;

/// Where releases are published. Also what the user is sent to.
pub const RELEASES_URL: &str = "https://github.com/FJRG2007/polaris/releases";

/// Every terminal release tag starts with this; the rest is what the build
/// reports as its version (`GIT_RELEASE_TAG`), `v0.YYYY.MM.DD.HH.MM.oss_NN`.
pub const TAG_PREFIX: &str = "terminal-";

/// The tags that are terminal releases, and nothing else the repository tags.
const TERMINAL_TAGS_API: &str =
    "https://api.github.com/repos/FJRG2007/polaris/git/matching-refs/tags/terminal-v";

/// One release, by its tag.
const RELEASE_BY_TAG_API: &str = "https://api.github.com/repos/FJRG2007/polaris/releases/tags";

/// How many of the newest tags are tried when the newest has no usable
/// release (a prerelease, or one whose installers are still uploading). Kept
/// small: each costs a request against an unauthenticated rate limit.
const RELEASES_TRIED: usize = 3;

/// The page for one release, which is where someone told to get a specific
/// version needs to land. The index lists every release Polaris Terminal has ever had, and
/// leaving them to pick the right one out of it is the kind of last step that
/// gets skipped.
pub fn release_url(tag: &str) -> String {
    // A tag carrying anything path-like would build a URL for a page that does
    // not exist, and a 404 is worse than the index it came from.
    if tag.is_empty() || tag.contains(['/', '?', '#', ' ']) {
        return RELEASES_URL.to_owned();
    }
    // A version is reported without the prefix (it is what the build calls
    // itself), and the tag it came from has it.
    if tag.starts_with(TAG_PREFIX) {
        format!("{RELEASES_URL}/tag/{tag}")
    } else {
        format!("{RELEASES_URL}/tag/{TAG_PREFIX}{tag}")
    }
}

/// Kept short: this runs on a poll, and a hung request must not accumulate.
const FETCH_TIMEOUT: Duration = Duration::from_secs(10);

/// The version a release tag reports as: the tag, verbatim, less the
/// [`TAG_PREFIX`] the build never sees (the release workflow passes the version
/// after it as `GIT_RELEASE_TAG`).
///
/// `ChannelState::app_version` hands back `GIT_RELEASE_TAG` exactly as the build
/// passed it - `v0.1.0`, `v` and all - and `should_update` compares the two with
/// `==`. Normalising one side and not the other made every check disagree with a
/// build of that very tag, and the result was a permanent notice offering an
/// update this fork does not install. Ordering the two when they differ is
/// [`compare_release_tags`].
///
/// Every release is also its own `last_prominent_update`. Upstream's channel
/// server sets that field on the releases it wants announced, and it is what
/// shows the "Update Polaris Terminal" pill in the tab bar; without it a downloaded update
/// only earns a red dot on the avatar and an entry in its menu. GitHub has no
/// such field, so nothing was ever prominent, and a ready update was easy to
/// miss next to Warp showing the button for the same kind of release.
fn version_from_tag(tag: &str) -> VersionInfo {
    let tag = tag.strip_prefix(TAG_PREFIX).unwrap_or(tag);
    let mut version = VersionInfo::new(tag.to_owned());
    version.last_prominent_update = Some(tag.to_owned());
    version
}

/// Orders two release tags, or `None` if either is not a version this
/// understands.
///
/// `ParsedVersion` cannot stand in for this. Its regex accepts only the dated
/// `v0.YYYY.MM.DD.HH.MM.channel_NN` shape, which releases now carry but the
/// `v0.1.x` tags published before them do not - and an install on one of those
/// still has to order itself against a dated release. A tag it cannot parse
/// makes `is_current_version_ahead_of_latest_version` return an error that the
/// caller reads as "not ahead", so every tag that merely differed from the
/// installed one was treated as newer, and a build ahead of the published
/// release - one tagged locally, or one whose release was later yanked - was
/// offered a downgrade on every poll, permanently.
pub fn compare_release_tags(left: &str, right: &str) -> Option<Ordering> {
    Some(ReleaseTag::parse(left)?.cmp(&ReleaseTag::parse(right)?))
}

/// A tag of either shape this fork has published: the dated
/// `v0.2026.09.08.21.45.oss_00`, or the earlier `v0.1.0` with an optional
/// prerelease suffix and build metadata.
#[derive(Debug, PartialEq, Eq)]
struct ReleaseTag {
    /// The dot-separated numeric components, in order.
    core: Vec<u64>,
    /// The `-rc.1` suffix, split on its dots. Empty for a final release.
    prerelease: Vec<PrereleaseIdentifier>,
}

/// Semver orders a numeric prerelease identifier below an alphanumeric one, and
/// numeric ones among themselves numerically - which the derived ordering gives,
/// in this variant order.
#[derive(Debug, PartialEq, Eq, PartialOrd, Ord)]
enum PrereleaseIdentifier {
    Numeric(u64),
    Alphanumeric(String),
}

impl ReleaseTag {
    fn parse(tag: &str) -> Option<Self> {
        // The prefix says which product a tag belongs to, not which release
        // is newer. Build metadata is excluded from precedence by the semver
        // spec.
        let tag = tag.strip_prefix(TAG_PREFIX).unwrap_or(tag);
        let tag = tag.strip_prefix('v').unwrap_or(tag);
        let tag = tag.split('+').next().unwrap_or(tag);
        let (core, prerelease) = match tag.split_once('-') {
            Some((core, prerelease)) => (core, Some(prerelease)),
            None => (tag, None),
        };

        // Two shapes reach this. A dated tag ends in the channel and a counter
        // for the minute it was cut in; a semver one does not. The counter
        // becomes the last numeric component, and the channel is dropped, which
        // affects precedence no more than build metadata does - it names where a
        // release was published, not which release is newer.
        let (core, counter) = match core.rsplit_once('.') {
            Some((leading, last)) => match last.split_once('_') {
                Some((channel, counter))
                    if !channel.is_empty()
                        && channel.chars().all(|c| c.is_ascii_lowercase())
                        && !counter.is_empty()
                        && counter.chars().all(|c| c.is_ascii_digit()) =>
                {
                    (leading, Some(counter))
                }
                _ => (core, None),
            },
            None => (core, None),
        };

        let mut core = core
            .split('.')
            .map(|component| component.parse::<u64>().ok())
            .collect::<Option<Vec<_>>>()?;
        if let Some(counter) = counter {
            core.push(counter.parse().ok()?);
        }

        let prerelease = match prerelease {
            Some(prerelease) => prerelease
                .split('.')
                .map(|identifier| {
                    if identifier.is_empty() {
                        None
                    } else if let Ok(number) = identifier.parse::<u64>() {
                        Some(PrereleaseIdentifier::Numeric(number))
                    } else {
                        Some(PrereleaseIdentifier::Alphanumeric(identifier.to_owned()))
                    }
                })
                .collect::<Option<Vec<_>>>()?,
            None => Vec::new(),
        };

        Some(Self { core, prerelease })
    }
}

impl Ord for ReleaseTag {
    fn cmp(&self, other: &Self) -> Ordering {
        // A tag with fewer components is that tag with zeroes appended, so
        // `v0.2` and `v0.2.0` are the same release.
        for index in 0..self.core.len().max(other.core.len()) {
            let ours = self.core.get(index).copied().unwrap_or(0);
            let theirs = other.core.get(index).copied().unwrap_or(0);
            match ours.cmp(&theirs) {
                Ordering::Equal => {}
                ordering => return ordering,
            }
        }

        // A prerelease comes before the release it leads to.
        match (self.prerelease.is_empty(), other.prerelease.is_empty()) {
            (true, false) => Ordering::Greater,
            (false, true) => Ordering::Less,
            _ => self.prerelease.cmp(&other.prerelease),
        }
    }
}

impl PartialOrd for ReleaseTag {
    fn partial_cmp(&self, other: &Self) -> Option<Ordering> {
        Some(self.cmp(other))
    }
}

/// The installer this platform needs out of a release, named the way the
/// bundle scripts name it. `None` on a target nothing is built for.
pub fn installer_asset_name() -> Option<&'static str> {
    if cfg!(windows) {
        if cfg!(target_arch = "aarch64") {
            Some("PolarisTerminalSetup-arm64.exe")
        } else if cfg!(target_arch = "x86_64") {
            Some("PolarisTerminalSetup.exe")
        } else {
            None
        }
    } else if cfg!(target_os = "macos") {
        Some("PolarisTerminal.dmg")
    } else if cfg!(target_os = "linux") && cfg!(target_arch = "x86_64") {
        Some("PolarisTerminal-x86_64.AppImage")
    } else {
        None
    }
}

/// The subset of GitHub's reference payload that matters here.
#[derive(Debug, Deserialize)]
struct GitRef {
    /// `refs/tags/terminal-v...`.
    #[serde(rename = "ref")]
    name: String,
}

/// The release tags among `refs`, newest first. A tag this cannot order is
/// left out rather than guessed at.
fn newest_release_tags(refs: &[GitRef]) -> Vec<&str> {
    let mut tags: Vec<&str> = refs
        .iter()
        .filter_map(|git_ref| git_ref.name.strip_prefix("refs/tags/"))
        .filter(|tag| tag.starts_with(TAG_PREFIX) && ReleaseTag::parse(tag).is_some())
        .collect();
    tags.sort_by(|left, right| compare_release_tags(right, left).unwrap_or(Ordering::Equal));
    tags
}

/// The subset of GitHub's release payload that matters here.
#[derive(Debug, Deserialize)]
struct LatestRelease {
    tag_name: String,
    #[serde(default)]
    draft: bool,
    #[serde(default)]
    prerelease: bool,
    #[serde(default)]
    assets: Vec<ReleaseAsset>,
}

#[derive(Debug, Deserialize)]
struct ReleaseAsset {
    name: String,
}

/// One GET against the GitHub API, parsed as `T`.
async fn get_github_json<T: serde::de::DeserializeOwned>(
    client: &http_client::Client,
    url: &str,
) -> Result<T> {
    client
        .get(url)
        // GitHub rejects an API request with no user agent.
        .header("User-Agent", "polaris-terminal-autoupdate")
        .header("Accept", "application/vnd.github+json")
        .timeout(FETCH_TIMEOUT)
        .send()
        .await
        .context("failed to reach the GitHub API")?
        .error_for_status()
        .context("the GitHub API returned an error")?
        .json()
        .await
        .context("failed to parse the GitHub API payload")
}

/// Why `release` cannot be offered to this platform, if it cannot.
fn unusable_release(release: &LatestRelease, asset: &str) -> Option<String> {
    // Offering someone a draft or a prerelease is worse than offering nothing.
    if release.draft || release.prerelease {
        return Some(format!(
            "release {} is a draft or prerelease",
            release.tag_name
        ));
    }
    // The three installers are built by separate jobs and published as each
    // finishes, so a release exists from the moment the first one lands.
    // Reporting it to everyone at that point offers an update that only one
    // platform can act on - and the one platform whose job failed outright
    // would be offered it forever.
    if !release
        .assets
        .iter()
        .any(|published| published.name == asset)
    {
        return Some(format!(
            "release {} has not published {asset} yet",
            release.tag_name
        ));
    }
    None
}

/// The version of the most recent published terminal release, as a
/// `VersionInfo` so it travels through the same reporting path as any other
/// update check.
pub async fn fetch_latest_release_version(client: &http_client::Client) -> Result<VersionInfo> {
    let Some(asset) = installer_asset_name() else {
        anyhow::bail!("no installer is published for this platform");
    };

    let refs: Vec<GitRef> = get_github_json(client, TERMINAL_TAGS_API)
        .await
        .context("failed to list the terminal release tags")?;
    let tags = newest_release_tags(&refs);
    if tags.is_empty() {
        anyhow::bail!("no terminal release has been tagged yet");
    }

    let mut reasons = Vec::new();
    for tag in tags.into_iter().take(RELEASES_TRIED) {
        let release: LatestRelease =
            match get_github_json(client, &format!("{RELEASE_BY_TAG_API}/{tag}")).await {
                Ok(release) => release,
                // A tag is pushed before its release is created, so the newest
                // tag having none yet is ordinary.
                Err(error) => {
                    reasons.push(format!("{tag}: {error:#}"));
                    continue;
                }
            };
        match unusable_release(&release, asset) {
            None => return Ok(version_from_tag(&release.tag_name)),
            Some(reason) => reasons.push(reason),
        }
    }
    anyhow::bail!("no usable terminal release: {}", reasons.join("; "))
}

#[cfg(test)]
#[path = "github_tests.rs"]
mod tests;
