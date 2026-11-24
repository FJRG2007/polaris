use super::*;
use crate::SizeInfo;

const POWERSHELL_PATH: &str = r"C:\Windows\System32\WindowsPowerShell\v1.0\powershell.exe";

fn options_for(
    shell_starter: ShellStarter,
    env_vars: &[(&str, &str)],
    start_dir: Option<PathBuf>,
) -> PtyOptions {
    PtyOptions {
        size: SizeInfo::new_without_font_metrics(24, 80),
        window_id: None,
        shell_starter,
        start_dir,
        env_vars: env_vars
            .iter()
            .map(|(name, value)| (OsString::from(name), OsString::from(value)))
            .collect(),
        enable_ssh_wrapper: false,
        reuse_ssh_control_master: false,
        shell_debug_mode: false,
        honor_ps1: false,
        node_version_chip_enabled: false,
        close_fds: false,
    }
}

fn standard_powershell() -> ShellStarter {
    ShellStarter::Direct(DirectShellStarter::standard_for_test(
        ShellType::PowerShell,
        PathBuf::from(POWERSHELL_PATH),
    ))
}

#[test]
fn per_session_vars_match_case_insensitively() {
    assert!(is_per_session_var(&OsString::from(
        TERMINAL_SESSION_UUID_ENV
    )));
    assert!(is_per_session_var(&OsString::from(
        FOCUS_URL_ENV.to_ascii_lowercase()
    )));
    assert!(!is_per_session_var(&OsString::from("PATH")));
}

#[test]
fn standard_powershell_with_only_per_session_vars_is_eligible() {
    let options = options_for(
        standard_powershell(),
        &[
            (TERMINAL_SESSION_UUID_ENV, "0123"),
            (FOCUS_URL_ENV, "rook://focus"),
        ],
        None,
    );
    assert!(eligible_starter(&options).is_some());
}

#[test]
fn any_other_variable_makes_a_request_ineligible() {
    let options = options_for(
        standard_powershell(),
        &[(TERMINAL_SESSION_UUID_ENV, "0123"), ("ROOK_AGENT", "1")],
        None,
    );
    assert!(eligible_starter(&options).is_none());
}

#[test]
fn non_standard_arguments_or_other_shells_are_ineligible() {
    let custom_args = ShellStarter::Direct(DirectShellStarter::new_for_test(
        ShellType::PowerShell,
        PathBuf::from(POWERSHELL_PATH),
        vec![OsString::from("-NoProfile")],
    ));
    assert!(eligible_starter(&options_for(custom_args, &[], None)).is_none());

    let bash = ShellStarter::Direct(DirectShellStarter::standard_for_test(
        ShellType::Bash,
        PathBuf::from(r"C:\Program Files\Git\bin\bash.exe"),
    ));
    assert!(eligible_starter(&options_for(bash, &[], None)).is_none());
}

#[test]
fn claim_statements_quote_every_single_quote_powershell_accepts() {
    let root = tempfile::tempdir().unwrap();
    let start_dir = root.path().join("it's \u{2018}a\u{2019} \u{201A}b\u{201B}");
    std::fs::create_dir(&start_dir).unwrap();
    let quoted_dir = format!(
        "'{}'",
        start_dir
            .to_string_lossy()
            .replace('\'', "''")
            .replace('\u{2018}', "\u{2018}\u{2018}")
            .replace('\u{2019}', "\u{2019}\u{2019}")
            .replace('\u{201A}', "\u{201A}\u{201A}")
            .replace('\u{201B}', "\u{201B}\u{201B}")
    );
    let options = options_for(
        standard_powershell(),
        &[
            (FOCUS_URL_ENV, "rook://x?a='b'"),
            (TERMINAL_SESSION_UUID_ENV, "0123"),
        ],
        Some(start_dir),
    );

    assert_eq!(
        claim_statements(&options),
        vec![
            format!("$env:{FOCUS_URL_ENV} = 'rook://x?a=''b'''"),
            format!("$env:{TERMINAL_SESSION_UUID_ENV} = '0123'"),
            format!("$env:{INITIAL_WORKING_DIR_NAME} = {quoted_dir}"),
            format!("try {{ [Environment]::CurrentDirectory = {quoted_dir} }} catch {{}}"),
        ],
    );
}

#[test]
fn claim_statements_skip_a_start_dir_that_does_not_exist() {
    let root = tempfile::tempdir().unwrap();
    let options = options_for(
        standard_powershell(),
        &[],
        Some(root.path().join("missing")),
    );
    assert!(claim_statements(&options).is_empty());
    assert!(claim_input(&options, SessionId::from(1)).is_none());
}

#[test]
fn claim_script_is_utf8_with_bom_and_deletes_itself() {
    let root = tempfile::tempdir().unwrap();
    let path = root.path().join("claim \u{e9}'.ps1");
    let statements = vec!["$env:A = '\u{e9}'".to_owned()];

    write_claim_script(&path, &statements).unwrap();

    let script = std::fs::read_to_string(&path).unwrap();
    let quoted_path = format!("'{}'", path.to_string_lossy().replace('\'', "''"));
    let remove = format!("Remove-Item -LiteralPath {quoted_path} -Force -ErrorAction Ignore");
    assert_eq!(script, format!("\u{FEFF}$env:A = '\u{e9}'\r\n{remove}\r\n"));
}

#[test]
fn claim_script_never_overwrites_an_existing_file() {
    let root = tempfile::tempdir().unwrap();
    let path = root.path().join("claim.ps1");
    std::fs::write(&path, "existing").unwrap();

    assert!(write_claim_script(&path, &["$env:A = '1'".to_owned()]).is_err());
    assert_eq!(std::fs::read_to_string(&path).unwrap(), "existing");
}
