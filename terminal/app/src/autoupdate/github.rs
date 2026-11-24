//! Checking GitHub releases for a newer Rook.
//!
//! Upstream's update pipeline serves its own release channels and refuses the
//! `oss` channel outright ("these channels don't ship release artifacts"), which
//! is the one Rook ships on. Rook publishes to GitHub releases instead, so this
//! asks GitHub what the latest tag is.
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
pub const RELEASES_URL: &str = "https://github.com/FJRG2007/rook/releases";

const LATEST_RELEASE_API: &str = "https://api.github.com/repos/FJRG2007/rook/releases/latest";

/// The page for one release, which is where someone told to get a specific
/// version needs to land. The index lists every release Rook has ever had, and
/// leaving them to pick the right one out of it is the kind of last step that
/// gets skipped.
pub fn release_url(tag: &str) -> String {
    // A tag carrying anything path-like would build a URL for a page that does
    // not exist, and a 404 is worse than the index it came from.
    if tag.is_empty() || tag.contains(['/', '?', '#', ' ']) {
        return RELEASES_URL.to_owned();
    }
    format!("{RELEASES_URL}/tag/{tag}")
}

/// Kept short: this runs on a poll, and a hung request must not accumulate.
const FETCH_TIMEOUT: Duration = Duration::from_secs(10);

/// The version a release tag reports as: the tag, verbatim.
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
/// shows the "Update Rook" pill in the tab bar; without it a downloaded update
/// only earns a red dot on the avatar and an entry in its menu. GitHub has no
/// such field, so nothing was ever prominent, and a ready update was easy to
/// miss next to Warp showing the button for the same kind of release.
fn version_from_tag(tag: &str) -> VersionInfo {
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
        // Build metadata is excluded from precedence by the semver spec.
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
            Some("RookOssSetup-arm64.exe")
        } else if cfg!(target_arch = "x86_64") {
            Some("RookOssSetup.exe")
        } else {
            None
        }
    } else if cfg!(target_os = "macos") {
        Some("RookOss.dmg")
    } else if cfg!(target_os = "linux") && cfg!(target_arch = "x86_64") {
        Some("RookOss-x86_64.AppImage")
    } else {
        None
    }
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

/// The version of the most recent published release, as a `VersionInfo` so it
/// travels through the same reporting path as any other update check.
pub async fn fetch_latest_release_version(client: &http_client::Client) -> Result<VersionInfo> {
    let response = client
        .get(LATEST_RELEASE_API)
        // GitHub rejects an API request with no user agent.
        .header("User-Agent", "rook-autoupdate")
        .header("Accept", "application/vnd.github+json")
        .timeout(FETCH_TIMEOUT)
        .send()
        .await
        .context("failed to reach the GitHub releases API")?
        .error_for_status()
        .context("the GitHub releases API returned an error")?;

    let release: LatestRelease = response
        .json()
        .await
        .context("failed to parse the GitHub release payload")?;

    // `/releases/latest` already excludes both, but a future switch to
    // `/releases` would not, and offering someone a draft is worse than
    // offering nothing.
    if release.draft || release.prerelease {
        anyhow::bail!("latest GitHub release is a draft or prerelease");
    }

    // The three installers are built by separate jobs and published as each
    // finishes, so a release exists, and is `latest`, from the moment the
    // first one lands. Reporting it to everyone at that point offers an
    // update that only one platform can act on - and the one platform whose
    // job failed outright would be offered it forever.
    let Some(asset) = installer_asset_name() else {
        anyhow::bail!("no installer is published for this platform");
    };
    if !release
        .assets
        .iter()
        .any(|published| published.name == asset)
    {
        anyhow::bail!("release {} has not published {asset} yet", release.tag_name);
    }

    Ok(version_from_tag(&release.tag_name))
}

#[cfg(test)]
#[path = "github_tests.rs"]
mod tests;
