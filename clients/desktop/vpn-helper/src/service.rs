//! Installing the helper as a system service, once, under the prompt the app
//! raises for it. After that connecting asks nobody for anything.

use crate::{auth, config};
use std::{
    fs, io,
    path::{Path, PathBuf},
    process::{Command, ExitStatus},
};

const SERVICE: &str = "PolarisVPN";

fn run(program: &str, args: &[&str]) -> io::Result<ExitStatus> {
    Command::new(program).args(args).status()
}

fn must(program: &str, args: &[&str]) -> io::Result<()> {
    let status = run(program, args)?;
    if status.success() {
        Ok(())
    } else {
        Err(io::Error::other(format!("{program} ended with {status}")))
    }
}

/// Copies this program, and the driver beside it on Windows, to the fixed folder.
fn place_files(home: &Path) -> io::Result<PathBuf> {
    fs::create_dir_all(home)?;
    let source = std::env::current_exe()?;
    let name = source
        .file_name()
        .ok_or_else(|| io::Error::other("no file name"))?;
    let target = home.join(name);
    if source != target {
        fs::copy(&source, &target)?;
    }
    #[cfg(windows)]
    {
        let folder = source
            .parent()
            .ok_or_else(|| io::Error::other("no folder"))?;
        let drivers = Path::new("resources-windows").join("binaries");
        fs::create_dir_all(home.join(&drivers))?;
        for dll in ["wireguard-amd64.dll", "wireguard-arm64.dll"] {
            let from = folder.join(&drivers).join(dll);
            if from.exists() {
                fs::copy(from, home.join(&drivers).join(dll))?;
            }
        }
    }
    Ok(target)
}

#[cfg(windows)]
fn stop_previous() {
    let _ = run("sc.exe", &["stop", SERVICE]);
    let _ = run("sc.exe", &["delete", SERVICE]);
    std::thread::sleep(std::time::Duration::from_secs(2));
}

#[cfg(windows)]
fn lock_folder(home: &Path) -> io::Result<()> {
    let path = home.to_string_lossy();
    must(
        "icacls.exe",
        &[
            &path,
            "/inheritance:r",
            "/grant:r",
            "*S-1-5-18:(OI)(CI)F",
            "*S-1-5-32-544:(OI)(CI)F",
        ],
    )
}

#[cfg(windows)]
fn start(binary: &Path) -> io::Result<()> {
    let command = format!("\"{}\" serve", binary.display());
    must(
        "sc.exe",
        &["create", SERVICE, "binPath=", &command, "start=", "auto"],
    )?;
    must("sc.exe", &["start", SERVICE])
}

#[cfg(unix)]
fn lock_folder(home: &Path) -> io::Result<()> {
    use std::os::unix::fs::PermissionsExt;
    fs::set_permissions(home, fs::Permissions::from_mode(0o700))
}

#[cfg(target_os = "linux")]
fn stop_previous() {
    let _ = run("systemctl", &["stop", SERVICE]);
}

#[cfg(target_os = "linux")]
fn start(binary: &Path) -> io::Result<()> {
    let unit = format!(
        "[Unit]\nDescription=Polaris VPN\nAfter=network.target\n\n[Service]\nExecStart={binary} serve\nExecStopPost={binary} cleanup\nRestart=on-failure\n\n[Install]\nWantedBy=multi-user.target\n",
        binary = binary.display()
    );
    fs::write(format!("/etc/systemd/system/{SERVICE}.service"), unit)?;
    must("systemctl", &["daemon-reload"])?;
    must("systemctl", &["enable", "--now", SERVICE])
}

#[cfg(target_os = "macos")]
const PLIST: &str = "/Library/LaunchDaemons/io.github.fjrg2007.polaris.vpn.plist";

#[cfg(target_os = "macos")]
fn stop_previous() {
    let _ = run("launchctl", &["bootout", "system", PLIST]);
}

#[cfg(target_os = "macos")]
fn start(binary: &Path) -> io::Result<()> {
    let plist = format!(
        "<?xml version=\"1.0\" encoding=\"UTF-8\"?>\n<plist version=\"1.0\"><dict><key>Label</key><string>io.github.fjrg2007.polaris.vpn</string><key>ProgramArguments</key><array><string>{}</string><string>serve</string></array><key>RunAtLoad</key><true/><key>KeepAlive</key><true/></dict></plist>\n",
        binary.display()
    );
    fs::write(PLIST, plist)?;
    must("launchctl", &["bootstrap", "system", PLIST])
}

/// Installs or replaces the service. The secret arrives in a file the app wrote,
/// never on a command line anybody on the machine could read.
pub fn install(secret_file: &str) -> io::Result<()> {
    let secret = fs::read_to_string(secret_file)?;
    let secret = secret.trim();
    if !auth::valid_secret(secret) {
        return Err(io::Error::other("not a secret"));
    }
    stop_previous();
    let home = config::home();
    let binary = place_files(&home)?;
    lock_folder(&home)?;
    config::store_secret(secret)?;
    start(&binary)
}

/// Starts serving, under the service manager on Windows.
#[cfg(not(windows))]
pub fn run_service() -> io::Result<()> {
    crate::server::serve()
}

#[cfg(windows)]
pub fn run_service() -> io::Result<()> {
    windows::dispatch()
}

#[cfg(windows)]
mod windows {
    use super::SERVICE;
    use std::{ffi::OsString, io, time::Duration};
    use windows_service::{
        define_windows_service,
        service::{
            ServiceControl, ServiceControlAccept, ServiceExitCode, ServiceState, ServiceStatus,
            ServiceType,
        },
        service_control_handler::{self, ServiceControlHandlerResult, ServiceStatusHandle},
        service_dispatcher,
    };

    define_windows_service!(service_entry, service_main);

    fn report(handle: &ServiceStatusHandle, state: ServiceState, accepts: ServiceControlAccept) {
        let _ = handle.set_service_status(ServiceStatus {
            service_type: ServiceType::OWN_PROCESS,
            current_state: state,
            controls_accepted: accepts,
            exit_code: ServiceExitCode::Win32(0),
            checkpoint: 0,
            wait_hint: Duration::default(),
            process_id: None,
        });
    }

    fn service_main(_arguments: Vec<OsString>) {
        let handler = |control| match control {
            ServiceControl::Interrogate => ServiceControlHandlerResult::NoError,
            // Ending the process closes the adapter with it.
            ServiceControl::Stop | ServiceControl::Shutdown => std::process::exit(0),
            _ => ServiceControlHandlerResult::NotImplemented,
        };
        let Ok(handle) = service_control_handler::register(SERVICE, handler) else {
            return;
        };
        report(
            &handle,
            ServiceState::Running,
            ServiceControlAccept::STOP | ServiceControlAccept::SHUTDOWN,
        );
        // The driver is found relative to the working folder.
        let _ = std::env::set_current_dir(crate::config::home());
        if let Err(error) = crate::server::serve() {
            eprintln!("polaris-vpn: {error}");
        }
        report(
            &handle,
            ServiceState::Stopped,
            ServiceControlAccept::empty(),
        );
    }

    pub fn dispatch() -> io::Result<()> {
        service_dispatcher::start(SERVICE, service_entry).map_err(io::Error::other)
    }
}
