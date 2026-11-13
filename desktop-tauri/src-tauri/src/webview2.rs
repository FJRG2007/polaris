//! WebView2 events Tauri does not expose, reached through `with_webview`:
//! permission requests (`permissions.ts`), failed loads (`did-fail-load` in
//! `index.ts`) and certificate errors (`local-ca-pin.ts`). Windows only; macOS
//! and Linux keep the engine's own behaviour (see the parity ledger).

use std::sync::Arc;
use tauri::WebviewWindow;
use webview2_com::Microsoft::Web::WebView2::Win32::*;
use webview2_com::{
    take_pwstr, NavigationCompletedEventHandler, PermissionRequestedEventHandler,
    ServerCertificateErrorDetectedEventHandler,
};
use windows_core::{Interface, BOOL, PWSTR};

type PermissionHook = Box<dyn Fn(&str, &str, &[&str]) -> bool + Send + Sync>;
type FailedLoadHook = Box<dyn Fn(i32, &str, String) + Send + Sync>;
type CertificateHook = Box<dyn Fn(&str, &[Vec<u8>]) -> bool + Send + Sync>;

/// What a window decides, given the page's own words for each event.
pub struct Hooks {
    /// Whether `permission` (Chromium's name) may be granted to `url`, with the
    /// media types asked for.
    pub permission: PermissionHook,
    /// A failed main-frame load: Chromium's code and name, and the URL.
    pub failed_load: FailedLoadHook,
    /// Whether an untrusted-authority chain (leaf first, DER) is accepted for a host.
    pub certificate: CertificateHook,
}

/// Chromium's name for a WebView2 permission, with the media type it stands for.
fn permission_name(kind: COREWEBVIEW2_PERMISSION_KIND) -> (&'static str, Option<&'static str>) {
    match kind {
        COREWEBVIEW2_PERMISSION_KIND_MICROPHONE => ("media", Some("audio")),
        COREWEBVIEW2_PERMISSION_KIND_CAMERA => ("media", Some("video")),
        COREWEBVIEW2_PERMISSION_KIND_NOTIFICATIONS => ("notifications", None),
        COREWEBVIEW2_PERMISSION_KIND_CLIPBOARD_READ => ("clipboard-read", None),
        // Geolocation, sensors, MIDI, fonts, downloads, files, autoplay, window
        // management: nothing Polaris is given.
        _ => ("unknown", None),
    }
}

fn read(get: impl FnOnce(*mut PWSTR) -> windows_core::Result<()>) -> Option<String> {
    let mut value = PWSTR::null();
    get(&mut value).ok()?;
    Some(take_pwstr(value))
}

/// The issuer chain WebView2 hands over, as DER, leaf first.
fn chain_of(certificate: &ICoreWebView2Certificate) -> Vec<Vec<u8>> {
    let mut chain: Vec<Vec<u8>> = Vec::new();
    let pem = read(|out| unsafe { certificate.ToPemEncoding(out) }).unwrap_or_default();
    chain.extend(polaris_client::local_ca_pin::pem_certificates(&pem));
    let Ok(issuers) = (unsafe { certificate.PemEncodedIssuerCertificateChain() }) else {
        return chain;
    };
    let mut count = 0u32;
    if unsafe { issuers.Count(&mut count) }.is_err() {
        return chain;
    }
    for index in 0..count {
        if let Some(pem) = read(|out| unsafe { issuers.GetValueAtIndex(index, out) }) {
            chain.extend(polaris_client::local_ca_pin::pem_certificates(&pem));
        }
    }
    chain
}

/// Chromium's code for a failed load, as `did-fail-load` reports it.
pub fn chromium_error(status: COREWEBVIEW2_WEB_ERROR_STATUS) -> (i32, &'static str) {
    match status {
        COREWEBVIEW2_WEB_ERROR_STATUS_OPERATION_CANCELED => (-3, "ERR_ABORTED"),
        COREWEBVIEW2_WEB_ERROR_STATUS_HOST_NAME_NOT_RESOLVED => (-105, "ERR_NAME_NOT_RESOLVED"),
        COREWEBVIEW2_WEB_ERROR_STATUS_DISCONNECTED => (-106, "ERR_INTERNET_DISCONNECTED"),
        COREWEBVIEW2_WEB_ERROR_STATUS_CANNOT_CONNECT => (-104, "ERR_CONNECTION_FAILED"),
        COREWEBVIEW2_WEB_ERROR_STATUS_CONNECTION_RESET => (-101, "ERR_CONNECTION_RESET"),
        COREWEBVIEW2_WEB_ERROR_STATUS_CONNECTION_ABORTED => (-100, "ERR_CONNECTION_CLOSED"),
        COREWEBVIEW2_WEB_ERROR_STATUS_SERVER_UNREACHABLE => (-109, "ERR_ADDRESS_UNREACHABLE"),
        COREWEBVIEW2_WEB_ERROR_STATUS_TIMEOUT => (-7, "ERR_TIMED_OUT"),
        COREWEBVIEW2_WEB_ERROR_STATUS_CERTIFICATE_COMMON_NAME_IS_INCORRECT => {
            (-200, "ERR_CERT_COMMON_NAME_INVALID")
        }
        COREWEBVIEW2_WEB_ERROR_STATUS_CERTIFICATE_EXPIRED => (-201, "ERR_CERT_DATE_INVALID"),
        COREWEBVIEW2_WEB_ERROR_STATUS_CERTIFICATE_IS_INVALID => {
            (-202, "ERR_CERT_AUTHORITY_INVALID")
        }
        COREWEBVIEW2_WEB_ERROR_STATUS_CERTIFICATE_REVOKED => (-206, "ERR_CERT_REVOKED"),
        COREWEBVIEW2_WEB_ERROR_STATUS_CLIENT_CERTIFICATE_CONTAINS_ERRORS => {
            (-117, "ERR_BAD_SSL_CLIENT_AUTH_CERT")
        }
        COREWEBVIEW2_WEB_ERROR_STATUS_VALID_PROXY_AUTHENTICATION_REQUIRED => {
            (-130, "ERR_PROXY_CONNECTION_FAILED")
        }
        _ => (-2, "ERR_FAILED"),
    }
}

/// Attaches the hooks to a window's WebView2.
pub fn attach(window: &WebviewWindow, hooks: Hooks) -> tauri::Result<()> {
    let hooks = Arc::new(hooks);
    window.with_webview(move |platform| unsafe {
        let Ok(core) = platform.controller().CoreWebView2() else {
            return;
        };
        let mut token = 0i64;
        let permission = hooks.clone();
        let _ = core.add_PermissionRequested(
            &PermissionRequestedEventHandler::create(Box::new(move |_, args| {
                let Some(args) = args else { return Ok(()) };
                let mut kind = COREWEBVIEW2_PERMISSION_KIND::default();
                args.PermissionKind(&mut kind)?;
                let url = read(|out| args.Uri(out)).unwrap_or_default();
                let (name, media) = permission_name(kind);
                let media: Vec<&str> = media.into_iter().collect();
                let allowed = (permission.permission)(name, &url, &media);
                args.SetState(if allowed {
                    COREWEBVIEW2_PERMISSION_STATE_ALLOW
                } else {
                    COREWEBVIEW2_PERMISSION_STATE_DENY
                })
            })),
            &mut token,
        );
        let failed = hooks.clone();
        let _ = core.add_NavigationCompleted(
            &NavigationCompletedEventHandler::create(Box::new(move |sender, args| {
                let (Some(sender), Some(args)) = (sender, args) else {
                    return Ok(());
                };
                let mut success = BOOL::default();
                args.IsSuccess(&mut success)?;
                if success.as_bool() {
                    return Ok(());
                }
                let mut status = COREWEBVIEW2_WEB_ERROR_STATUS::default();
                args.WebErrorStatus(&mut status)?;
                let (code, name) = chromium_error(status);
                let url = read(|out| sender.Source(out)).unwrap_or_default();
                (failed.failed_load)(code, name, url);
                Ok(())
            })),
            &mut token,
        );
        // ICoreWebView2_14 (WebView2 Runtime 1.0.1245+): older runtimes keep the
        // engine's refusal, which is the safe side.
        if let Ok(core) = core.cast::<ICoreWebView2_14>() {
            let certificate = hooks.clone();
            let _ = core.add_ServerCertificateErrorDetected(
                &ServerCertificateErrorDetectedEventHandler::create(Box::new(move |_, args| {
                    let Some(args) = args else { return Ok(()) };
                    let mut status = COREWEBVIEW2_WEB_ERROR_STATUS::default();
                    args.ErrorStatus(&mut status)?;
                    let url = read(|out| args.RequestUri(out)).unwrap_or_default();
                    let host = url::Url::parse(&url)
                        .ok()
                        .and_then(|url| url.host_str().map(str::to_owned))
                        .unwrap_or_default();
                    let accept = status == COREWEBVIEW2_WEB_ERROR_STATUS_CERTIFICATE_IS_INVALID
                        && args
                            .ServerCertificate()
                            .is_ok_and(|chain| (certificate.certificate)(&host, &chain_of(&chain)));
                    args.SetAction(if accept {
                        COREWEBVIEW2_SERVER_CERTIFICATE_ERROR_ACTION_ALWAYS_ALLOW
                    } else {
                        COREWEBVIEW2_SERVER_CERTIFICATE_ERROR_ACTION_DEFAULT
                    })
                })),
                &mut token,
            );
        }
    })
}
