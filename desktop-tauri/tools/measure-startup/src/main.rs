//! Startup time and memory of the Tauri beta, measured without a visible window.
//!
//!     cargo build --release -p polaris-desktop-beta --features measure
//!     cargo run --release -p measure-startup -- [--app <path>] [--runs <n>] [--settle-ms <ms>]
//!
//! Serves a small static page on 127.0.0.1, starts the beta built with the
//! `measure` feature against it (`POLARIS_MEASURE_PAGE`; the window is created
//! hidden, off-screen and off the taskbar, see `src-tauri/src/measure.rs`), and
//! records for each run the time from spawning the process to the page's load,
//! then the working set of the whole process tree (the app and every engine
//! process under it) once it has settled. Prints one JSON object.
//!
//! The first run after a boot or a build is the cold one; the rest are warm.
//!
//! The Electron app cannot be measured the same way without changing `desktop/`:
//! it has no way to be pointed at a page other than its saved server, and its
//! `--hidden` start still loads that server with the owner's own settings and
//! hands over to an Electron app already running, which then shows its window.
//! `docs/desktop-tauri-parity.md` says how to measure it by hand.

use std::io::{BufRead, BufReader, Read, Write};
use std::net::{TcpListener, TcpStream};
use std::path::PathBuf;
use std::process::{Child, Command, Stdio};
use std::sync::mpsc;
use std::time::{Duration, Instant};
use sysinfo::{Pid, ProcessRefreshKind, ProcessesToUpdate, System};

const PAGE: &str = "<!doctype html><html><head><meta charset=\"utf-8\"><title>Polaris measure</title></head><body><h1>Polaris</h1><p>A static page for measuring a start.</p></body></html>";
/// The most a start may take to load the page before the run counts as failed.
const LOAD_LIMIT: Duration = Duration::from_secs(60);
/// The longest request head the page server reads.
const REQUEST_LIMIT: usize = 8 * 1024;

fn serve(listener: TcpListener) {
    for stream in listener.incoming().flatten() {
        std::thread::spawn(move || answer(stream));
    }
}

fn answer(mut stream: TcpStream) {
    let _ = stream.set_read_timeout(Some(Duration::from_secs(5)));
    let mut head = Vec::new();
    let mut buffer = [0_u8; 1024];
    while !head.windows(4).any(|window| window == b"\r\n\r\n") && head.len() < REQUEST_LIMIT {
        match stream.read(&mut buffer) {
            Ok(0) | Err(_) => return,
            Ok(read) => head.extend_from_slice(&buffer[..read]),
        }
    }
    let response = format!(
        "HTTP/1.1 200 OK\r\nContent-Type: text/html; charset=utf-8\r\nContent-Length: {}\r\nCache-Control: no-store\r\nConnection: close\r\n\r\n{PAGE}",
        PAGE.len()
    );
    let _ = stream.write_all(response.as_bytes());
}

struct Options {
    app: PathBuf,
    runs: usize,
    settle: Duration,
}

fn default_app() -> PathBuf {
    let name = if cfg!(windows) {
        "polaris-desktop-beta.exe"
    } else {
        "polaris-desktop-beta"
    };
    PathBuf::from(env!("CARGO_MANIFEST_DIR"))
        .join("../../target/release")
        .join(name)
}

fn options() -> Result<Options, String> {
    let mut options = Options {
        app: default_app(),
        runs: 3,
        settle: Duration::from_secs(5),
    };
    let mut args = std::env::args().skip(1);
    while let Some(arg) = args.next() {
        let mut value = || args.next().ok_or(format!("{arg} needs a value"));
        match arg.as_str() {
            "--app" => options.app = PathBuf::from(value()?),
            "--runs" => {
                options.runs = value()?
                    .parse()
                    .ok()
                    .filter(|runs| (1..=20).contains(runs))
                    .ok_or("--runs takes 1 to 20")?
            }
            "--settle-ms" => {
                let ms: u64 = value()?
                    .parse()
                    .ok()
                    .filter(|ms| (0..=60_000).contains(ms))
                    .ok_or("--settle-ms takes 0 to 60000")?;
                options.settle = Duration::from_millis(ms);
            }
            other => return Err(format!("unknown argument {other}")),
        }
    }
    if !options.app.is_file() {
        return Err(format!(
            "{} is not built: cargo build --release -p polaris-desktop-beta --features measure",
            options.app.display()
        ));
    }
    Ok(options)
}

/// The process and every process under it.
fn tree(system: &System, root: Pid) -> Vec<Pid> {
    let mut found = vec![root];
    let mut at = 0;
    while at < found.len() {
        let parent = found[at];
        found.extend(
            system
                .processes()
                .iter()
                .filter(|(_, process)| process.parent() == Some(parent))
                .map(|(pid, _)| *pid),
        );
        at += 1;
    }
    found
}

fn refreshed() -> System {
    let mut system = System::new().expect("the process list can be read");
    system.refresh_processes_specifics(
        ProcessesToUpdate::All,
        true,
        ProcessRefreshKind::nothing().with_memory(),
    );
    system
}

fn spawn(app: &PathBuf, page: &str) -> std::io::Result<Child> {
    let mut command = Command::new(app);
    command
        .env("POLARIS_MEASURE_PAGE", page)
        .stdin(Stdio::null())
        .stdout(Stdio::piped())
        .stderr(Stdio::null());
    #[cfg(windows)]
    {
        use std::os::windows::process::CommandExt;
        // CREATE_NO_WINDOW: a debug build is a console program, and must not
        // open a console window either.
        command.creation_flags(0x0800_0000);
    }
    command.spawn()
}

fn run_once(options: &Options, page: &str) -> Result<serde_json::Value, String> {
    let spawned = Instant::now();
    let mut child =
        spawn(&options.app, page).map_err(|error| format!("could not start: {error}"))?;
    let stdout = child.stdout.take().ok_or("no output")?;
    let (lines, reading) = mpsc::channel();
    std::thread::spawn(move || {
        for line in BufReader::new(stdout).lines().map_while(Result::ok) {
            if lines.send(line).is_err() {
                return;
            }
        }
    });
    let outcome = (|| {
        let loaded = loop {
            let left = LOAD_LIMIT.saturating_sub(spawned.elapsed());
            let line = reading
                .recv_timeout(left)
                .map_err(|_| "the page did not load in time".to_owned())?;
            let Ok(event) = serde_json::from_str::<serde_json::Value>(&line) else {
                continue;
            };
            if event["event"] == "loaded" {
                break (spawned.elapsed(), event["ms"].as_f64());
            }
        };
        std::thread::sleep(options.settle);
        let system = refreshed();
        let pids = tree(&system, Pid::from_u32(child.id()));
        let bytes: u64 = pids
            .iter()
            .filter_map(|pid| system.process(*pid))
            .map(|process| process.memory())
            .sum();
        Ok(serde_json::json!({
            "load_ms": loaded.0.as_secs_f64() * 1000.0,
            "load_ms_in_process": loaded.1,
            "working_set_bytes": bytes,
            "working_set_mib": bytes as f64 / (1024.0 * 1024.0),
            "processes": pids.len(),
        }))
    })();
    // The engine's processes go with the app, but are ended here too.
    let system = refreshed();
    for pid in tree(&system, Pid::from_u32(child.id())).into_iter().rev() {
        if let Some(process) = system.process(pid) {
            process.kill();
        }
    }
    let _ = child.kill();
    let _ = child.wait();
    outcome
}

fn main() {
    let options = match options() {
        Ok(options) => options,
        Err(error) => {
            eprintln!("measure-startup: {error}");
            std::process::exit(2);
        }
    };
    let listener = TcpListener::bind("127.0.0.1:0").expect("a loopback port");
    let page = format!(
        "http://127.0.0.1:{}/",
        listener.local_addr().expect("its address").port()
    );
    std::thread::spawn(move || serve(listener));

    let mut runs = Vec::new();
    for _ in 0..options.runs {
        runs.push(
            run_once(&options, &page).unwrap_or_else(|error| serde_json::json!({ "error": error })),
        );
        std::thread::sleep(Duration::from_secs(2));
    }
    let report = serde_json::json!({
        "app": options.app.display().to_string(),
        "page": page,
        "settle_ms": options.settle.as_millis() as u64,
        "os": std::env::consts::OS,
        "arch": std::env::consts::ARCH,
        "runs": runs,
    });
    println!("{report}");
}
