use super::*;

/// The regression this file exists for. `ChannelState::app_version` returns
/// `GIT_RELEASE_TAG` verbatim, and `AutoupdateState::should_update` decides
/// "already up to date" by comparing that string to this one with `==`. Trimming
/// the `v` here made the two disagree for a build of the very tag being offered,
/// and every check reported an update the fork has no way to install.
#[test]
fn a_release_reports_the_tag_verbatim() {
    assert_eq!(version_from_tag("v0.1.0").version, "v0.1.0");
}

/// Nothing is stripped, trimmed or reordered on the way through, whatever the
/// tag looks like - including the shape upstream's version server uses, which
/// is the only one `ParsedVersion` can parse.
#[test]
fn no_part_of_a_tag_is_rewritten() {
    for tag in [
        "v0.1.0",
        "v1.2.3-rc.1",
        "v0.2023.05.15.08.04.stable_01",
        "0.1.0",
    ] {
        assert_eq!(version_from_tag(tag).version, tag);
    }
}

/// The tab bar shows the "Update Polaris Terminal" pill only for an update at or before
/// `last_prominent_update`; left empty, a downloaded update was reachable from
/// the avatar menu alone.
#[test]
fn every_release_is_announced_prominently() {
    let tag = "v0.2026.09.10.13.50.oss_00";
    assert_eq!(
        version_from_tag(tag).last_prominent_update.as_deref(),
        Some(tag)
    );
}

/// The regression the ordering exists for: an installed build ahead of the
/// published release used to be offered that older release forever, because
/// `ParsedVersion` cannot read a semver tag and the caller reads a parse failure
/// as "not ahead".
#[test]
fn a_newer_installed_build_is_ahead_of_an_older_release() {
    assert_eq!(
        compare_release_tags("v0.2.0", "v0.1.0"),
        Some(Ordering::Greater)
    );
    assert_eq!(
        compare_release_tags("v0.1.0", "v0.2.0"),
        Some(Ordering::Less)
    );
    assert_eq!(
        compare_release_tags("v0.1.0", "v0.1.0"),
        Some(Ordering::Equal)
    );
}

/// Every component counts, the `v` is optional on either side, missing trailing
/// components are zero, and build metadata is excluded from precedence.
#[test]
fn tags_are_ordered_component_by_component() {
    for (left, right, expected) in [
        ("v1.0.0", "v0.9.9", Ordering::Greater),
        ("v0.10.0", "v0.9.0", Ordering::Greater),
        ("v0.1.10", "v0.1.9", Ordering::Greater),
        ("v0.2", "v0.2.0", Ordering::Equal),
        ("0.1.0", "v0.1.0", Ordering::Equal),
        ("v0.1.0+build.5", "v0.1.0", Ordering::Equal),
    ] {
        assert_eq!(compare_release_tags(left, right), Some(expected));
    }
}

/// A prerelease comes before the release it leads to, and prerelease
/// identifiers order numerically before alphanumerically.
#[test]
fn a_prerelease_precedes_its_release() {
    for (left, right, expected) in [
        ("v0.1.0-rc.1", "v0.1.0", Ordering::Less),
        ("v0.1.0-rc.1", "v0.1.0-rc.2", Ordering::Less),
        ("v0.1.0-rc.2", "v0.1.0-rc.10", Ordering::Less),
        ("v0.1.0-alpha", "v0.1.0-alpha.1", Ordering::Less),
        ("v0.1.0-1", "v0.1.0-alpha", Ordering::Less),
        ("v0.1.0-rc.1", "v0.0.9", Ordering::Greater),
    ] {
        assert_eq!(compare_release_tags(left, right), Some(expected));
    }
}

/// The dated tags releases carry, which have to order against each other and
/// against the `v0.1.x` tags an older install is still running - the case the
/// fallback exists for, since `ParsedVersion` refuses the semver side.
#[test]
fn a_dated_release_orders_against_anything_else_published() {
    let dated = "v0.2026.09.08.21.45.oss_00";
    for (left, right, expected) in [
        ("v0.1.2", dated, Ordering::Less),
        (dated, "v0.1.2", Ordering::Greater),
        (dated, dated, Ordering::Equal),
        // Two cut in the same minute are told apart by the counter.
        (dated, "v0.2026.09.08.21.45.oss_01", Ordering::Less),
        // A later minute wins whatever the counter says.
        (
            "v0.2026.09.08.21.45.oss_01",
            "v0.2026.09.09.10.00.oss_00",
            Ordering::Less,
        ),
        // The channel names where a release was published, not which one is
        // newer, so it weighs no more than build metadata does.
        ("v0.2023.05.15.08.04.stable_01", dated, Ordering::Less),
    ] {
        assert_eq!(compare_release_tags(left, right), Some(expected));
    }
}

/// Anything this does not understand orders as nothing rather than guessing.
#[test]
fn an_unrecognised_tag_has_no_ordering() {
    for tag in ["nightly", "v", "", "v0.1.0-"] {
        assert_eq!(compare_release_tags(tag, "v0.1.0"), None);
        assert_eq!(compare_release_tags("v0.1.0", tag), None);
    }
}

/// The button offering a new version has to land on that version, not on a
/// list of every release the fork has ever cut.
#[test]
fn a_release_url_points_at_the_version_it_names() {
    // A reported version carries no prefix; the tag it names does.
    for tag in [
        "v0.2026.09.08.21.45.oss_00",
        "terminal-v0.2026.09.08.21.45.oss_00",
    ] {
        assert_eq!(
            release_url(tag),
            "https://github.com/FJRG2007/polaris/releases/tag/terminal-v0.2026.09.08.21.45.oss_00"
        );
    }
}

/// The build calls itself by the version after the prefix (`GIT_RELEASE_TAG`),
/// and `should_update` compares the two with `==`, so the reported version
/// must not keep it - or every check would offer the build it is running.
#[test]
fn a_terminal_tag_reports_the_version_the_build_carries() {
    let version = version_from_tag("terminal-v0.2026.11.24.10.00.oss_00");
    assert_eq!(version.version, "v0.2026.11.24.10.00.oss_00");
    assert_eq!(
        version.last_prominent_update.as_deref(),
        Some("v0.2026.11.24.10.00.oss_00")
    );
}

/// The prefix names the product, so a tag orders the same with or without it.
#[test]
fn the_terminal_prefix_does_not_affect_ordering() {
    for (left, right, expected) in [
        (
            "terminal-v0.2026.11.24.10.00.oss_00",
            "v0.2026.11.24.10.00.oss_00",
            Ordering::Equal,
        ),
        (
            "terminal-v0.2026.11.24.10.00.oss_01",
            "v0.2026.11.24.10.00.oss_00",
            Ordering::Greater,
        ),
        (
            "v0.1.2",
            "terminal-v0.2026.11.24.10.00.oss_00",
            Ordering::Less,
        ),
    ] {
        assert_eq!(compare_release_tags(left, right), Some(expected));
    }
}

/// Only `terminal-v*` tags are releases of this app, newest first, and one
/// that cannot be ordered is skipped rather than guessed at.
#[test]
fn release_tags_are_the_terminal_ones_newest_first() {
    let refs: Vec<GitRef> = [
        "refs/tags/terminal-v0.2026.11.24.10.00.oss_00",
        "refs/tags/desktop-v0.1.81",
        "refs/tags/terminal-v0.2026.12.01.09.30.oss_00",
        "refs/tags/terminal-vnightly",
        "refs/tags/terminal-v0.2026.11.24.10.00.oss_01",
        "refs/heads/terminal-v0.2027.01.01.00.00.oss_00",
    ]
    .into_iter()
    .map(|name| GitRef {
        name: name.to_owned(),
    })
    .collect();
    assert_eq!(
        newest_release_tags(&refs),
        [
            "terminal-v0.2026.12.01.09.30.oss_00",
            "terminal-v0.2026.11.24.10.00.oss_01",
            "terminal-v0.2026.11.24.10.00.oss_00",
        ]
    );
}

/// A draft, a prerelease, or a release still missing this platform's
/// installer is not offered.
#[test]
fn only_a_finished_release_is_offered() {
    let release = |draft, prerelease, assets: &[&str]| LatestRelease {
        tag_name: "terminal-v0.2026.11.24.10.00.oss_00".to_owned(),
        draft,
        prerelease,
        assets: assets
            .iter()
            .map(|name| ReleaseAsset {
                name: (*name).to_owned(),
            })
            .collect(),
    };
    let asset = "PolarisTerminal.dmg";
    assert_eq!(
        unusable_release(&release(false, false, &[asset]), asset),
        None
    );
    assert!(unusable_release(&release(true, false, &[asset]), asset).is_some());
    assert!(unusable_release(&release(false, true, &[asset]), asset).is_some());
    assert!(unusable_release(&release(false, false, &["other.exe"]), asset).is_some());
}

/// A tag that would build a URL for a page that does not exist falls back to
/// the index, a list being a better answer than a 404.
#[test]
fn a_tag_that_cannot_be_a_url_falls_back_to_the_index() {
    for tag in ["", "../../etc", "v0.1.0 ", "a?b", "a#b"] {
        assert_eq!(release_url(tag), RELEASES_URL);
    }
}
