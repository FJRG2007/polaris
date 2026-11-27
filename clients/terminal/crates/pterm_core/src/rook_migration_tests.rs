use std::fs;
use std::path::Path;

use super::*;

fn write(path: &Path, contents: &str) {
    fs::create_dir_all(path.parent().unwrap()).unwrap();
    fs::write(path, contents).unwrap();
}

fn read(path: &Path) -> String {
    fs::read_to_string(path).unwrap()
}

fn plan(root: &Path) -> MigrationPlan {
    MigrationPlan {
        old_homes: vec![root.join(".rook-oss"), root.join(".rook")],
        new_home: root.join(".polaris-terminal-oss"),
        data_dirs: vec![(root.join("rook-data"), root.join("polaris-data"))],
    }
}

#[test]
fn copies_the_home_and_data_directories_and_renames_the_database() {
    let root = tempfile::tempdir().unwrap();
    let root = root.path();
    write(&root.join(".rook-oss/settings.toml"), "theme = \"dark\"\n");
    write(&root.join(".rook-oss/skills/one/SKILL.md"), "skill");
    write(&root.join(".rook-oss/.mcp.json"), "{}");
    write(&root.join("rook-data/rook.sqlite"), "db");
    write(&root.join("rook-data/rook.sqlite-wal"), "wal");
    write(
        &root.join("rook-data/themes/rook.sqlite"),
        "not the database",
    );

    let report = migrate(&plan(root)).unwrap().unwrap();

    let home = root.join(".polaris-terminal-oss");
    assert_eq!(read(&home.join("settings.toml")), "theme = \"dark\"\n");
    assert_eq!(read(&home.join("skills/one/SKILL.md")), "skill");
    assert_eq!(read(&home.join(".mcp.json")), "{}");
    assert_eq!(
        read(&root.join("polaris-data/polaris-terminal.sqlite")),
        "db"
    );
    assert_eq!(
        read(&root.join("polaris-data/polaris-terminal.sqlite-wal")),
        "wal"
    );
    assert!(!root.join("polaris-data/rook.sqlite").exists());
    // Only the top-level database is renamed.
    assert_eq!(
        read(&root.join("polaris-data/themes/rook.sqlite")),
        "not the database"
    );
    assert_eq!(report.files, 6);
    assert_eq!(
        report.home_from.as_deref(),
        Some(root.join(".rook-oss").as_path())
    );
    assert!(read(&home.join(MIGRATION_MARKER)).contains(".rook-oss"));
    assert!(!root.join(".polaris-terminal-oss.rook-copy").exists());
}

#[test]
fn copies_never_moves() {
    let root = tempfile::tempdir().unwrap();
    let root = root.path();
    write(&root.join(".rook-oss/settings.toml"), "a");
    write(&root.join("rook-data/rook.sqlite"), "db");

    migrate(&plan(root)).unwrap().unwrap();

    assert_eq!(read(&root.join(".rook-oss/settings.toml")), "a");
    assert_eq!(read(&root.join("rook-data/rook.sqlite")), "db");
}

#[test]
fn falls_back_to_the_older_home_directory() {
    let root = tempfile::tempdir().unwrap();
    let root = root.path();
    write(&root.join(".rook/settings.toml"), "old");

    let report = migrate(&plan(root)).unwrap().unwrap();

    assert_eq!(
        report.home_from.as_deref(),
        Some(root.join(".rook").as_path())
    );
    assert_eq!(
        read(&root.join(".polaris-terminal-oss/settings.toml")),
        "old"
    );
}

#[test]
fn prefers_the_released_build_home_over_the_older_one() {
    let root = tempfile::tempdir().unwrap();
    let root = root.path();
    write(&root.join(".rook-oss/settings.toml"), "released");
    write(&root.join(".rook/settings.toml"), "old");

    migrate(&plan(root)).unwrap().unwrap();

    assert_eq!(
        read(&root.join(".polaris-terminal-oss/settings.toml")),
        "released"
    );
}

#[test]
fn does_nothing_once_the_polaris_home_exists() {
    let root = tempfile::tempdir().unwrap();
    let root = root.path();
    write(&root.join(".rook-oss/settings.toml"), "rook");
    write(&root.join(".polaris-terminal-oss/settings.toml"), "mine");
    write(&root.join("rook-data/rook.sqlite"), "db");

    assert_eq!(migrate(&plan(root)).unwrap(), None);

    assert_eq!(
        read(&root.join(".polaris-terminal-oss/settings.toml")),
        "mine"
    );
    assert!(!root.join("polaris-data").exists());
}

#[test]
fn runs_once() {
    let root = tempfile::tempdir().unwrap();
    let root = root.path();
    write(&root.join(".rook-oss/settings.toml"), "rook");

    assert!(migrate(&plan(root)).unwrap().is_some());
    assert_eq!(migrate(&plan(root)).unwrap(), None);
}

#[test]
fn does_nothing_without_a_rook_install() {
    let root = tempfile::tempdir().unwrap();
    let root = root.path();
    write(&root.join("rook-data/rook.sqlite"), "db");

    assert_eq!(migrate(&plan(root)).unwrap(), None);
    assert!(!root.join(".polaris-terminal-oss").exists());
    assert!(!root.join("polaris-data").exists());
}

#[test]
fn never_overwrites_data_already_on_the_polaris_side() {
    let root = tempfile::tempdir().unwrap();
    let root = root.path();
    write(&root.join(".rook-oss/settings.toml"), "rook");
    write(&root.join("rook-data/rook.sqlite"), "rook db");
    write(&root.join("rook-data/logs/a.log"), "rook log");
    write(
        &root.join("polaris-data/polaris-terminal.sqlite"),
        "polaris db",
    );

    let report = migrate(&plan(root)).unwrap().unwrap();

    assert_eq!(
        read(&root.join("polaris-data/polaris-terminal.sqlite")),
        "polaris db"
    );
    assert_eq!(read(&root.join("polaris-data/logs/a.log")), "rook log");
    assert_eq!(report.skipped, 1);
}

#[test]
fn an_interrupted_copy_is_redone_from_scratch() {
    let root = tempfile::tempdir().unwrap();
    let root = root.path();
    write(&root.join(".rook-oss/settings.toml"), "rook");
    // What a crash halfway through the last launch left behind.
    write(
        &root.join(".polaris-terminal-oss.rook-copy/stale.txt"),
        "half",
    );

    migrate(&plan(root)).unwrap().unwrap();

    let home = root.join(".polaris-terminal-oss");
    assert_eq!(read(&home.join("settings.toml")), "rook");
    assert!(!home.join("stale.txt").exists());
    assert!(!root.join(".polaris-terminal-oss.rook-copy").exists());
}

#[cfg(unix)]
#[test]
fn symbolic_links_are_not_followed() {
    let root = tempfile::tempdir().unwrap();
    let root = root.path();
    write(&root.join("elsewhere/secret.txt"), "outside");
    write(&root.join(".rook-oss/settings.toml"), "rook");
    std::os::unix::fs::symlink(root.join("elsewhere"), root.join(".rook-oss/linked")).unwrap();

    let report = migrate(&plan(root)).unwrap().unwrap();

    assert!(!root.join(".polaris-terminal-oss/linked").exists());
    assert_eq!(report.skipped, 1);
}

#[test]
fn the_plan_pairs_each_directory_once_and_leaves_the_home_out() {
    let old = directories::ProjectDirs::from("dev", "rook", "RookOss").unwrap();
    let new = directories::ProjectDirs::from("dev", "polaris", "PolarisTerminal").unwrap();
    let home = Path::new("/home/someone");
    let new_home = new.data_dir().to_owned();

    let plan = plan_from(home, new_home.clone(), &old, &new);

    assert_eq!(
        plan.old_homes,
        vec![home.join(".rook-oss"), home.join(".rook")]
    );
    assert!(plan.data_dirs.iter().all(|(_, to)| to != &new_home));
    let mut targets: Vec<_> = plan.data_dirs.iter().map(|(_, to)| to.clone()).collect();
    let count = targets.len();
    targets.sort();
    targets.dedup();
    assert_eq!(targets.len(), count);
    assert!(
        plan.data_dirs
            .iter()
            .any(|(from, to)| from == old.data_local_dir() && to == new.data_local_dir())
            || new.data_local_dir() == new_home
    );
}
