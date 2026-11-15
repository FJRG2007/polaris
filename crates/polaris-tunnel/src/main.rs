//! `polaris-tunnel --config <file> [--info <addr:port>]`

use std::net::SocketAddr;
use std::process::ExitCode;
use std::sync::atomic::Ordering;

use polaris_tunnel::{config, engine, status, SILENT};

const USAGE: &str = "usage: polaris-tunnel -c <config> [-i <addr:port>] [-s] [-n] [-v] [-h]
  -c, --config <file>      the configuration file
  -i, --info <addr:port>   serve /metrics and /readyz there
  -s, --silent             log nothing
  -n, --configtest         check the configuration and exit
  -v, --version            print the version
  -h, --help               print this help";

#[derive(Debug, Default, PartialEq, Eq)]
struct Args {
    config: Option<String>,
    info: Option<SocketAddr>,
    silent: bool,
    configtest: bool,
    version: bool,
    help: bool,
}

fn parse_args(args: impl IntoIterator<Item = String>) -> Result<Args, String> {
    let mut out = Args::default();
    let mut args = args.into_iter();
    while let Some(arg) = args.next() {
        let (flag, inline) = match arg.split_once('=') {
            Some((f, v)) if f.starts_with("--") => (f.to_string(), Some(v.to_string())),
            _ => (arg.clone(), None),
        };
        let mut value = |name: &str| {
            inline
                .clone()
                .or_else(|| args.next())
                .ok_or(format!("{name} needs a value"))
        };
        match flag.as_str() {
            "-c" | "--config" => out.config = Some(value("--config")?),
            "-i" | "--info" => {
                let v = value("--info")?;
                out.info = Some(
                    v.parse()
                        .map_err(|_| format!("--info {v:?} is not an address:port"))?,
                );
            }
            "-s" | "--silent" => out.silent = true,
            "-n" | "--configtest" => out.configtest = true,
            "-v" | "--version" => out.version = true,
            "-h" | "--help" => out.help = true,
            "-d" | "--daemon" => {
                return Err("--daemon is not supported: run it in the foreground".into())
            }
            other => return Err(format!("unknown argument {other}")),
        }
    }
    Ok(out)
}

fn main() -> ExitCode {
    let args = match parse_args(std::env::args().skip(1)) {
        Ok(a) => a,
        Err(e) => {
            eprintln!("polaris-tunnel: {e}\n{USAGE}");
            return ExitCode::from(2);
        }
    };
    if args.help {
        println!("{USAGE}");
        return ExitCode::SUCCESS;
    }
    if args.version {
        println!("polaris-tunnel {}", env!("CARGO_PKG_VERSION"));
        return ExitCode::SUCCESS;
    }
    SILENT.store(args.silent, Ordering::Relaxed);
    let Some(path) = args.config else {
        eprintln!("polaris-tunnel: --config is required\n{USAGE}");
        return ExitCode::from(2);
    };
    let text = match std::fs::read_to_string(&path) {
        Ok(t) => t,
        Err(e) => {
            eprintln!("polaris-tunnel: cannot read {path}: {e}");
            return ExitCode::from(1);
        }
    };
    let config = match config::parse(&text) {
        Ok(c) => c,
        Err(e) => {
            eprintln!("polaris-tunnel: {path}: {e}");
            return ExitCode::from(1);
        }
    };
    if args.configtest {
        println!("configuration ok");
        return ExitCode::SUCCESS;
    }
    let runtime = match tokio::runtime::Builder::new_current_thread()
        .enable_all()
        .build()
    {
        Ok(r) => r,
        Err(e) => {
            eprintln!("polaris-tunnel: {e}");
            return ExitCode::from(1);
        }
    };
    runtime.block_on(async move {
        let handle = match engine::start(config, engine::Limits::default()).await {
            Ok(h) => h,
            Err(e) => {
                eprintln!("polaris-tunnel: cannot start: {e}");
                return ExitCode::from(1);
            }
        };
        if let Some(addr) = args.info {
            match status::bind(addr).await {
                Ok(listener) => {
                    tokio::spawn(status::serve(listener, handle.status.clone()));
                }
                Err(e) => {
                    eprintln!("polaris-tunnel: cannot serve status on {addr}: {e}");
                    return ExitCode::from(1);
                }
            }
        }
        engine::log(&format!("up on {}", handle.wire_addr));
        terminated().await;
        handle.stop().await;
        ExitCode::SUCCESS
    })
}

/// SIGTERM or SIGINT on Unix, Ctrl-C elsewhere.
async fn terminated() {
    #[cfg(unix)]
    {
        use tokio::signal::unix::{signal, SignalKind};
        let (Ok(mut term), Ok(mut int)) = (
            signal(SignalKind::terminate()),
            signal(SignalKind::interrupt()),
        ) else {
            let _ = tokio::signal::ctrl_c().await;
            return;
        };
        tokio::select! {
            _ = term.recv() => {}
            _ = int.recv() => {}
        }
    }
    #[cfg(not(unix))]
    {
        let _ = tokio::signal::ctrl_c().await;
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn args(list: &[&str]) -> Result<Args, String> {
        parse_args(list.iter().map(|s| s.to_string()))
    }

    #[test]
    fn flags() {
        let a = args(&["--config", "/c", "--info", "127.0.0.1:9080", "-s", "-n"]).unwrap();
        assert_eq!(a.config.as_deref(), Some("/c"));
        assert_eq!(a.info, Some("127.0.0.1:9080".parse().unwrap()));
        assert!(a.silent && a.configtest);
        assert_eq!(
            args(&["--config=/x"]).unwrap().config.as_deref(),
            Some("/x")
        );
        assert!(
            args(&["-c", "/c", "-i", "127.0.0.1:1", "-v", "-h"])
                .unwrap()
                .version
        );
        assert!(args(&["--info", "nope"]).is_err());
        assert!(args(&["--config"]).is_err());
        assert!(args(&["-d"]).is_err());
        assert!(args(&["--bogus"]).is_err());
    }
}
