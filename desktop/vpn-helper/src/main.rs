//! The part of the VPN that needs the system's permission: it owns the tunnel and
//! its key. The app only sends it orders (see `server.rs`), and this runs as a
//! service so that connecting asks for nothing once it is installed.

mod auth;
mod config;
mod server;
mod service;
mod tunnel;

use std::process::ExitCode;

fn main() -> ExitCode {
    let arguments: Vec<String> = std::env::args().skip(1).collect();
    let arguments: Vec<&str> = arguments.iter().map(String::as_str).collect();
    let outcome = match arguments.as_slice() {
        ["serve"] => service::run_service(),
        ["install", secret_file] => service::install(secret_file),
        _ => {
            eprintln!("usage: polaris-vpn-helper serve | install <secret-file>");
            return ExitCode::from(2);
        }
    };
    match outcome {
        Ok(()) => ExitCode::SUCCESS,
        Err(error) => {
            eprintln!("polaris-vpn: {error}");
            ExitCode::FAILURE
        }
    }
}
