//! The UPSes this host can reach, read and driven through Network UPS Tools.
//!
//! NUT (`usbhid-ups`, `snmp-ups` and `upsd`, installed in this daemon's image)
//! is what speaks to the hardware: it already knows the HID Power Device and
//! SNMP MIB dialects of every vendor, which a parser of our own would have to
//! relearn one UPS at a time. This module only finds the devices, writes NUT's
//! configuration into a private runtime directory, keeps one driver per UPS and
//! one `upsd` (bound to 127.0.0.1 only) running, and talks to `upsd` over its
//! line protocol.
//!
//! Discovery needs no configuration: every USB device whose HID report
//! descriptor declares the Power Device (0x84) or Battery System (0x85) usage
//! page is a UPS, and a few vendors whose firmware hides that page behind a
//! vendor page are recognised by their vendor id.
//!
//! An SNMP UPS has no cable to find; the dashboard names its address, and the
//! daemon runs `snmp-ups` for it beside the USB drivers.

use std::collections::BTreeMap;
use std::fs;
use std::io::{self, BufRead, BufReader, Write};
use std::net::{SocketAddr, TcpStream};
use std::path::{Path, PathBuf};
use std::process::{Child, Command, Stdio};
use std::sync::{Mutex, OnceLock};
use std::time::{Duration, Instant};

use serde::{Deserialize, Serialize};

/// Where NUT's configuration and state live; recreated on every start.
pub const RUNTIME_DIR: &str = "/run/polaris-ups";
/// The one address `upsd` listens on. Never anything but loopback.
pub const UPSD_PORT: u16 = 3493;
const DRIVER_DIR: &str = "/usr/lib/nut";
const UPSD_BIN: &str = "/usr/sbin/upsd";
const ADMIN_USER: &str = "polaris";
const IO_TIMEOUT: Duration = Duration::from_secs(5);
/// Most lines one `LIST` answer may have; a real UPS has about a hundred.
const MAX_LIST_LINES: usize = 2048;

/// Vendors whose UPSes are HID Power Devices even when the descriptor is not
/// readable from here (no `report_descriptor` exposed by the kernel).
const UPS_VENDORS: &[&str] = &[
    "0764", // CyberPower (and OEMs such as Atlantis)
    "051d", // APC
    "0463", // Eaton / MGE
    "09ae", // Tripp Lite
    "06da", // Phoenixtec / Liebert OEMs
    "10af", // Liebert
    "050d", // Belkin
];

/// The commands the dashboard may run. Anything else is refused before it
/// reaches `upsd`, so this daemon never becomes a generic NUT proxy.
pub const ALLOWED_COMMANDS: &[&str] = &[
    "beeper.enable",
    "beeper.disable",
    "beeper.mute",
    "test.battery.start.quick",
    "test.battery.start.deep",
    "test.battery.stop",
];

// ---------------------------------------------------------------------------
// HID report descriptor
// ---------------------------------------------------------------------------

/// Every Usage Page a HID report descriptor declares, walking it item by item
/// (HID 1.11, 6.2.2). Long items are skipped by their declared size; a
/// truncated item ends the walk rather than reading past the buffer.
pub fn usage_pages(descriptor: &[u8]) -> Vec<u32> {
    let mut pages = Vec::new();
    let mut i = 0;
    while i < descriptor.len() {
        let prefix = descriptor[i];
        if prefix == 0xFE {
            // Long item: bDataSize, bLongItemTag, data.
            let Some(&size) = descriptor.get(i + 1) else {
                break;
            };
            i += 3 + size as usize;
            continue;
        }
        let size = match prefix & 0x03 {
            3 => 4,
            n => n as usize,
        };
        let item_type = (prefix >> 2) & 0x03;
        let tag = prefix >> 4;
        let Some(data) = descriptor.get(i + 1..i + 1 + size) else {
            break;
        };
        // Global item (type 1), tag 0: Usage Page.
        if item_type == 1 && tag == 0 {
            let value = data
                .iter()
                .rev()
                .fold(0u32, |acc, byte| (acc << 8) | u32::from(*byte));
            if !pages.contains(&value) {
                pages.push(value);
            }
        }
        i += 1 + size;
    }
    pages
}

/// Whether a descriptor is a Power Device's.
pub fn is_power_descriptor(descriptor: &[u8]) -> bool {
    usage_pages(descriptor)
        .iter()
        .any(|page| *page == 0x84 || *page == 0x85)
}

// ---------------------------------------------------------------------------
// USB discovery
// ---------------------------------------------------------------------------

/// One UPS on this host's USB bus.
#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct UsbUps {
    /// Stable for the cable: vendor, product and serial (or the port when the
    /// firmware reports no serial). Also the NUT name it runs under.
    pub id: String,
    pub vendor_id: String,
    pub product_id: String,
    pub manufacturer: String,
    pub product: String,
    pub serial: String,
    #[serde(skip)]
    pub bus: String,
}

fn read_trimmed(path: &Path) -> String {
    fs::read_to_string(path)
        .map(|s| s.trim().to_string())
        .unwrap_or_default()
}

/// Whether any HID interface of the device at `dir` declares a power page.
fn declares_power(dir: &Path) -> Option<bool> {
    let mut seen = false;
    for entry in fs::read_dir(dir).ok()?.flatten() {
        let intf = entry.path();
        if !entry.file_name().to_string_lossy().contains(':') {
            continue;
        }
        for hid in fs::read_dir(&intf).into_iter().flatten().flatten() {
            let descriptor = hid.path().join("report_descriptor");
            if let Ok(bytes) = fs::read(&descriptor) {
                seen = true;
                if is_power_descriptor(&bytes) {
                    return Some(true);
                }
            }
        }
    }
    seen.then_some(false)
}

/// Keep only what NUT accepts in a quoted value and a name.
fn safe_token(value: &str) -> String {
    value
        .chars()
        .filter(|c| c.is_ascii_alphanumeric() || matches!(c, '-' | '_' | '.'))
        .take(64)
        .collect()
}

/// Every UPS under `sys_usb` (normally `/sys/bus/usb/devices`).
pub fn discover_usb(sys_usb: &Path) -> Vec<UsbUps> {
    let mut found = Vec::new();
    let Ok(entries) = fs::read_dir(sys_usb) else {
        return found;
    };
    for entry in entries.flatten() {
        let dir = entry.path();
        let vendor = read_trimmed(&dir.join("idVendor")).to_ascii_lowercase();
        if vendor.len() != 4 {
            continue; // an interface, not a device
        }
        let power = match declares_power(&dir) {
            Some(answer) => answer,
            None => UPS_VENDORS.contains(&vendor.as_str()),
        };
        if !power {
            continue;
        }
        let product_id = read_trimmed(&dir.join("idProduct")).to_ascii_lowercase();
        let serial = safe_token(&read_trimmed(&dir.join("serial")));
        let port = safe_token(&entry.file_name().to_string_lossy());
        let id = format!(
            "usb-{}-{}-{}",
            safe_token(&vendor),
            safe_token(&product_id),
            if serial.is_empty() {
                port
            } else {
                serial.clone()
            }
        )
        .to_ascii_lowercase();
        found.push(UsbUps {
            id,
            vendor_id: vendor,
            product_id,
            manufacturer: read_trimmed(&dir.join("manufacturer")),
            product: read_trimmed(&dir.join("product")),
            serial,
            bus: format!("{:0>3}", read_trimmed(&dir.join("busnum"))),
        });
    }
    found.sort_by(|a, b| a.id.cmp(&b.id));
    found
}

// ---------------------------------------------------------------------------
// SNMP source
// ---------------------------------------------------------------------------

/// An SNMP UPS the dashboard asks this daemon to run a driver for.
#[derive(Debug, Clone, PartialEq, Eq, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct SnmpSource {
    /// IPv4/IPv6 address or host name, optionally with `:port`.
    pub address: String,
    /// `v1`, `v2c` or `v3`.
    pub version: String,
    #[serde(default)]
    pub community: Option<String>,
    #[serde(default)]
    pub user: Option<String>,
    #[serde(default)]
    pub auth_password: Option<String>,
    #[serde(default)]
    pub priv_password: Option<String>,
}

/// A value safe to put inside a quoted `ups.conf` value: printable ASCII with
/// no quote or backslash, so it can never close the quote or open a new key.
fn conf_safe(value: &str) -> bool {
    !value.is_empty()
        && value.len() <= 128
        && value
            .chars()
            .all(|c| c.is_ascii_graphic() && c != '"' && c != '\\')
}

impl SnmpSource {
    pub fn validate(&self) -> Result<(), &'static str> {
        if !conf_safe(&self.address) {
            return Err("invalid address");
        }
        match self.version.as_str() {
            "v1" | "v2c" => match &self.community {
                Some(c) if conf_safe(c) => Ok(()),
                _ => Err("a community is required"),
            },
            "v3" => {
                let user_ok = self.user.as_deref().is_some_and(conf_safe);
                let auth_ok = self.auth_password.as_deref().is_none_or(conf_safe);
                let priv_ok = self.priv_password.as_deref().is_none_or(conf_safe);
                if self.priv_password.is_some() && self.auth_password.is_none() {
                    return Err("privacy needs an authentication password");
                }
                if user_ok && auth_ok && priv_ok {
                    Ok(())
                } else {
                    Err("invalid SNMPv3 credentials")
                }
            }
            _ => Err("unknown SNMP version"),
        }
    }

    /// The NUT name this source runs under: stable for the address.
    pub fn name(&self) -> String {
        let mut hash: u64 = 0xcbf2_9ce4_8422_2325;
        for byte in self.address.bytes() {
            hash ^= u64::from(byte);
            hash = hash.wrapping_mul(0x0100_0000_01b3);
        }
        format!("snmp-{:016x}", hash)
    }
}

// ---------------------------------------------------------------------------
// NUT configuration
// ---------------------------------------------------------------------------

fn usb_section(ups: &UsbUps) -> String {
    let mut out = format!(
        "\n[{}]\n  driver = usbhid-ups\n  port = auto\n  vendorid = {}\n  productid = {}\n  bus = \"{}\"\n",
        ups.id,
        safe_token(&ups.vendor_id),
        safe_token(&ups.product_id),
        safe_token(&ups.bus)
    );
    if !ups.serial.is_empty() {
        out.push_str(&format!("  serial = \"{}\"\n", ups.serial));
    }
    out
}

fn snmp_section(source: &SnmpSource) -> String {
    let mut out = format!(
        "\n[{}]\n  driver = snmp-ups\n  port = \"{}\"\n  snmp_version = {}\n",
        source.name(),
        source.address,
        source.version
    );
    if let Some(c) = &source.community {
        out.push_str(&format!("  community = \"{c}\"\n"));
    }
    if let Some(u) = &source.user {
        out.push_str(&format!("  secName = \"{u}\"\n"));
        let level = match (&source.auth_password, &source.priv_password) {
            (Some(_), Some(_)) => "authPriv",
            (Some(_), None) => "authNoPriv",
            _ => "noAuthNoPriv",
        };
        out.push_str(&format!("  secLevel = {level}\n"));
    }
    if let Some(a) = &source.auth_password {
        out.push_str(&format!("  authPassword = \"{a}\"\n"));
    }
    if let Some(p) = &source.priv_password {
        out.push_str(&format!("  privPassword = \"{p}\"\n"));
    }
    out
}

/// Every UPS to drive: its NUT name, its driver and its `ups.conf` section.
fn sections(usb: &[UsbUps], snmp: &[SnmpSource]) -> Vec<(String, &'static str, String)> {
    usb.iter()
        .map(|u| (u.id.clone(), "usbhid-ups", usb_section(u)))
        .chain(snmp.iter().map(|s| (s.name(), "snmp-ups", snmp_section(s))))
        .collect()
}

/// `ups.conf` for the devices found and the SNMP sources asked for.
pub fn render_ups_conf(usb: &[UsbUps], snmp: &[SnmpSource]) -> String {
    let mut out = String::from("maxretry = 3\n");
    for (_, _, section) in sections(usb, snmp) {
        out.push_str(&section);
    }
    out
}

pub fn render_upsd_conf() -> String {
    format!("LISTEN 127.0.0.1 {UPSD_PORT}\n")
}

pub fn render_upsd_users(password: &str) -> String {
    format!("[{ADMIN_USER}]\n  password = {password}\n  instcmds = ALL\n")
}

// ---------------------------------------------------------------------------
// The NUT line protocol
// ---------------------------------------------------------------------------

/// Undo NUT's quoting of a value (`"a \"b\""` -> `a "b"`).
fn unquote(raw: &str) -> String {
    let raw = raw.trim();
    let inner = raw
        .strip_prefix('"')
        .and_then(|r| r.strip_suffix('"'))
        .unwrap_or(raw);
    let mut out = String::with_capacity(inner.len());
    let mut chars = inner.chars();
    while let Some(c) = chars.next() {
        if c == '\\' {
            if let Some(next) = chars.next() {
                out.push(next);
            }
        } else {
            out.push(c);
        }
    }
    out
}

/// Variables from either `upsd`'s `LIST VAR` answer (`VAR ups name "value"`)
/// or `upsc`'s output (`name: value`). Anything else is ignored.
pub fn parse_vars(text: &str) -> BTreeMap<String, String> {
    let mut vars = BTreeMap::new();
    for line in text.lines() {
        let line = line.trim_end_matches('\r');
        if let Some(rest) = line.strip_prefix("VAR ") {
            let mut parts = rest.splitn(3, ' ');
            let (_, Some(name), Some(value)) = (parts.next(), parts.next(), parts.next()) else {
                continue;
            };
            vars.insert(name.to_string(), unquote(value));
        } else if let Some((name, value)) = line.split_once(": ") {
            if !name.is_empty()
                && name
                    .chars()
                    .all(|c| c.is_ascii_alphanumeric() || c == '.' || c == '_')
            {
                vars.insert(name.to_string(), value.trim().to_string());
            }
        }
    }
    vars
}

/// Command names from a `LIST CMD` answer (`CMD ups beeper.enable`).
pub fn parse_cmds(text: &str) -> Vec<String> {
    text.lines()
        .filter_map(|line| line.trim_end_matches('\r').strip_prefix("CMD "))
        .filter_map(|rest| rest.split_whitespace().nth(1))
        .map(str::to_string)
        .collect()
}

/// One connection to a NUT server.
pub struct NutSession {
    reader: BufReader<TcpStream>,
    writer: TcpStream,
}

impl NutSession {
    pub fn connect(addr: SocketAddr) -> io::Result<Self> {
        let stream = TcpStream::connect_timeout(&addr, IO_TIMEOUT)?;
        stream.set_read_timeout(Some(IO_TIMEOUT))?;
        stream.set_write_timeout(Some(IO_TIMEOUT))?;
        Ok(Self {
            reader: BufReader::new(stream.try_clone()?),
            writer: stream,
        })
    }

    fn line(&mut self) -> io::Result<String> {
        let mut line = String::new();
        if self.reader.read_line(&mut line)? == 0 {
            return Err(io::Error::new(io::ErrorKind::UnexpectedEof, "closed"));
        }
        Ok(line.trim_end().to_string())
    }

    fn ask(&mut self, command: &str) -> io::Result<String> {
        self.writer.write_all(format!("{command}\n").as_bytes())?;
        self.line()
    }

    /// The whole answer to a `LIST` command, `BEGIN` to `END`.
    pub fn list(&mut self, what: &str) -> io::Result<String> {
        let first = self.ask(&format!("LIST {what}"))?;
        if first.starts_with("ERR") {
            return Err(io::Error::other(first));
        }
        let mut out = String::new();
        for _ in 0..MAX_LIST_LINES {
            let line = self.line()?;
            if line.starts_with("END LIST") {
                return Ok(out);
            }
            out.push_str(&line);
            out.push('\n');
        }
        Err(io::Error::new(
            io::ErrorKind::InvalidData,
            "answer too long",
        ))
    }

    pub fn instcmd(&mut self, ups: &str, user: &str, password: &str, cmd: &str) -> io::Result<()> {
        for (verb, arg) in [("USERNAME", user), ("PASSWORD", password)] {
            let answer = self.ask(&format!("{verb} {arg}"))?;
            if !answer.starts_with("OK") {
                return Err(io::Error::new(io::ErrorKind::PermissionDenied, answer));
            }
        }
        let answer = self.ask(&format!("INSTCMD {ups} {cmd}"))?;
        if answer.starts_with("OK") {
            Ok(())
        } else {
            Err(io::Error::other(answer))
        }
    }
}

// ---------------------------------------------------------------------------
// Supervision
// ---------------------------------------------------------------------------

struct Supervisor {
    password: String,
    usb: Vec<UsbUps>,
    snmp: Vec<SnmpSource>,
    /// Each running driver and the `ups.conf` section it was started with.
    drivers: BTreeMap<String, (Child, String)>,
    upsd: Option<Child>,
    /// The `ups.conf` last written, and read by `upsd` when it has anything to serve.
    applied_conf: Option<String>,
    last_check: Option<Instant>,
}

fn supervisor() -> &'static Mutex<Supervisor> {
    static SUP: OnceLock<Mutex<Supervisor>> = OnceLock::new();
    SUP.get_or_init(|| {
        Mutex::new(Supervisor {
            password: crate::security::generate_token(),
            usb: Vec::new(),
            snmp: Vec::new(),
            drivers: BTreeMap::new(),
            upsd: None,
            applied_conf: None,
            last_check: None,
        })
    })
}

/// Whether NUT is in this image at all (an image built before it was added).
pub fn nut_installed() -> bool {
    Path::new(UPSD_BIN).exists()
}

fn nut_command(program: &Path) -> Command {
    let mut command = Command::new(program);
    command
        .env("NUT_CONFPATH", RUNTIME_DIR)
        .env("NUT_STATEPATH", PathBuf::from(RUNTIME_DIR).join("state"))
        .env("NUT_ALTPIDPATH", PathBuf::from(RUNTIME_DIR).join("state"))
        .stdin(Stdio::null())
        .stdout(Stdio::null())
        .stderr(Stdio::null());
    command
}

fn alive(child: &mut Child) -> bool {
    matches!(child.try_wait(), Ok(None))
}

fn stop(mut child: Child) {
    let _ = child.kill();
    let _ = child.wait();
}

/// One source per NUT name, the last one given winning.
fn dedupe(sources: Vec<SnmpSource>) -> Vec<SnmpSource> {
    let mut out: Vec<SnmpSource> = Vec::new();
    for source in sources {
        let name = source.name();
        out.retain(|s| s.name() != name);
        out.push(source);
    }
    out
}

impl Supervisor {
    fn write_config(&self, conf: &str) -> io::Result<()> {
        let dir = Path::new(RUNTIME_DIR);
        fs::create_dir_all(dir.join("state"))?;
        fs::write(dir.join("nut.conf"), "MODE=standalone\n")?;
        fs::write(dir.join("ups.conf"), conf)?;
        fs::write(dir.join("upsd.conf"), render_upsd_conf())?;
        fs::write(dir.join("upsd.users"), render_upsd_users(&self.password))?;
        #[cfg(unix)]
        {
            use std::os::unix::fs::PermissionsExt;
            fs::set_permissions(dir.join("upsd.users"), fs::Permissions::from_mode(0o600))?;
            fs::set_permissions(dir.join("ups.conf"), fs::Permissions::from_mode(0o600))?;
        }
        Ok(())
    }

    /// Make the running drivers and `upsd` match `self.usb` and `self.snmp`: a
    /// driver whose section changed is restarted with the new one, one no
    /// longer wanted is stopped, and `upsd` restarts to read a changed list.
    fn reconcile(&mut self) -> io::Result<()> {
        let wanted = sections(&self.usb, &self.snmp);
        let conf = render_ups_conf(&self.usb, &self.snmp);
        let changed = self.applied_conf.as_deref() != Some(conf.as_str());
        if changed {
            self.write_config(&conf)?;
        }
        let stale: Vec<String> = self
            .drivers
            .iter()
            .filter(|(name, (_, started))| {
                !wanted
                    .iter()
                    .any(|(w, _, section)| w == *name && section == started)
            })
            .map(|(name, _)| name.clone())
            .collect();
        for name in stale {
            if let Some((child, _)) = self.drivers.remove(&name) {
                stop(child);
            }
        }
        for (name, driver, section) in &wanted {
            let running = self
                .drivers
                .get_mut(name)
                .is_some_and(|(child, _)| alive(child));
            if !running {
                let child = nut_command(&Path::new(DRIVER_DIR).join(driver))
                    .args(["-F", "-u", "root", "-a", name])
                    .spawn()?;
                self.drivers.insert(name.clone(), (child, section.clone()));
            }
        }
        let upsd_running = self.upsd.as_mut().is_some_and(alive);
        if wanted.is_empty() {
            if let Some(child) = self.upsd.take() {
                stop(child);
            }
            self.applied_conf = Some(conf);
        } else if !upsd_running || changed {
            if let Some(child) = self.upsd.take() {
                stop(child);
            }
            self.applied_conf = None;
            self.upsd = Some(
                nut_command(Path::new(UPSD_BIN))
                    .args(["-F", "-u", "root"])
                    .spawn()?,
            );
            self.applied_conf = Some(conf);
            // upsd answers within a moment of starting; a read right after
            // this one is what sees it.
            std::thread::sleep(Duration::from_millis(500));
        }
        Ok(())
    }
}

fn local_upsd() -> SocketAddr {
    SocketAddr::from(([127, 0, 0, 1], UPSD_PORT))
}

/// One UPS's reading as the dashboard gets it.
#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Reading {
    pub vars: BTreeMap<String, String>,
    pub commands: Vec<String>,
}

fn read_one(name: &str) -> io::Result<Reading> {
    let mut session = NutSession::connect(local_upsd())?;
    let vars = parse_vars(&session.list(&format!("VAR {name}"))?);
    let commands = session
        .list(&format!("CMD {name}"))
        .map(|t| parse_cmds(&t))
        .unwrap_or_default();
    Ok(Reading { vars, commands })
}

/// Every UPS on this host's USB bus, with its reading where the driver has
/// one yet. Drivers are started and restarted here, at most once a second.
pub fn list_usb(sys_usb: &Path) -> io::Result<Vec<(UsbUps, Result<Reading, String>)>> {
    let found = discover_usb(sys_usb);
    {
        let mut sup = supervisor().lock().unwrap_or_else(|p| p.into_inner());
        let due = sup
            .last_check
            .is_none_or(|t| t.elapsed() >= Duration::from_secs(1));
        if due {
            sup.last_check = Some(Instant::now());
            sup.usb = found.clone();
            sup.reconcile()?;
        }
    }
    Ok(found
        .into_iter()
        .map(|ups| {
            let reading =
                read_one(&ups.id).map_err(|_| "the UPS driver has no reading yet".to_string());
            (ups, reading)
        })
        .collect())
}

/// The reading of an SNMP UPS, starting its driver the first time it is asked
/// and restarting it when its version or credentials changed.
pub fn read_snmp(source: SnmpSource) -> io::Result<Result<Reading, String>> {
    let name = source.name();
    {
        let mut sup = supervisor().lock().unwrap_or_else(|p| p.into_inner());
        if !sup.snmp.contains(&source) {
            let mut snmp = sup.snmp.clone();
            snmp.push(source);
            sup.snmp = dedupe(snmp);
            sup.reconcile()?;
        }
    }
    Ok(read_one(&name).map_err(|_| "the SNMP UPS has not answered yet".to_string()))
}

/// Make the SNMP UPSes this daemon drives exactly `sources`: one left out has
/// its driver stopped and its credentials dropped from `ups.conf`.
pub fn set_snmp(sources: Vec<SnmpSource>) -> io::Result<()> {
    let sources = dedupe(sources);
    let mut sup = supervisor().lock().unwrap_or_else(|p| p.into_inner());
    if sup.snmp != sources {
        sup.snmp = sources;
        sup.reconcile()?;
    }
    Ok(())
}

/// Run one allowed command on a UPS this daemon drives.
pub fn command(name: &str, cmd: &str) -> Result<(), String> {
    if !ALLOWED_COMMANDS.contains(&cmd) {
        return Err("command not allowed".into());
    }
    let password = {
        let sup = supervisor().lock().unwrap_or_else(|p| p.into_inner());
        let known =
            sup.usb.iter().any(|u| u.id == name) || sup.snmp.iter().any(|s| s.name() == name);
        if !known {
            return Err("unknown UPS".into());
        }
        sup.password.clone()
    };
    let mut session =
        NutSession::connect(local_upsd()).map_err(|_| "upsd is not running".to_string())?;
    session
        .instcmd(name, ADMIN_USER, &password, cmd)
        .map_err(|e| {
            if e.to_string().contains("CMD-NOT-SUPPORTED") {
                "this UPS does not support that command".to_string()
            } else {
                "the UPS refused the command".to_string()
            }
        })
}

#[cfg(test)]
mod tests {
    use super::*;

    /// The start of a CyberPower HID Power Device descriptor (as reported by
    /// `usbhid-dump` for a 0764:0601): Usage Page (Power Device), Usage (UPS),
    /// Collection (Application), Report ID, Usage Page (Battery System).
    const CYBERPOWER: &[u8] = &[
        0x05, 0x84, 0x09, 0x04, 0xA1, 0x01, 0x85, 0x01, 0x05, 0x85, 0x09, 0x66, 0x15, 0x00, 0x25,
        0x64, 0x75, 0x08, 0x95, 0x01, 0xB1, 0x02, 0xC0,
    ];
    /// A keyboard: Generic Desktop, Keyboard, and a 2-byte Usage Page (0x0007).
    const KEYBOARD: &[u8] = &[0x05, 0x01, 0x09, 0x06, 0xA1, 0x01, 0x06, 0x07, 0x00, 0xC0];

    #[test]
    fn a_power_device_descriptor_is_found_by_its_usage_page() {
        assert_eq!(usage_pages(CYBERPOWER), vec![0x84, 0x85]);
        assert!(is_power_descriptor(CYBERPOWER));
        assert_eq!(usage_pages(KEYBOARD), vec![0x01, 0x07]);
        assert!(!is_power_descriptor(KEYBOARD));
    }

    #[test]
    fn a_truncated_or_long_item_never_reads_past_the_buffer() {
        assert_eq!(usage_pages(&[0x06, 0x84]), Vec::<u32>::new());
        // Long item of 2 data bytes, then Usage Page (Power Device).
        assert_eq!(
            usage_pages(&[0xFE, 0x02, 0x10, 0xAA, 0xBB, 0x05, 0x84]),
            vec![0x84]
        );
        assert!(usage_pages(&[]).is_empty());
    }

    #[cfg(unix)]
    fn fake_device(root: &Path, port: &str, vendor: &str, descriptor: Option<&[u8]>) {
        let dir = root.join(port);
        fs::create_dir_all(&dir).unwrap();
        fs::write(dir.join("idVendor"), format!("{vendor}\n")).unwrap();
        fs::write(dir.join("idProduct"), "0601\n").unwrap();
        fs::write(dir.join("product"), "A03-OP2002-RC\n").unwrap();
        fs::write(dir.join("busnum"), "1\n").unwrap();
        if let Some(bytes) = descriptor {
            let hid = dir.join(format!("{port}:1.0")).join("0003:0764:0601.0001");
            fs::create_dir_all(&hid).unwrap();
            fs::write(hid.join("report_descriptor"), bytes).unwrap();
        }
    }

    // The sysfs names carry ':' (`1-2:1.0`), which only a Unix filesystem takes.
    #[cfg(unix)]
    #[test]
    fn discovery_reads_the_descriptor_and_falls_back_to_the_vendor() {
        let root = std::env::temp_dir().join(format!("polaris-ups-{}", std::process::id()));
        let _ = fs::remove_dir_all(&root);
        fake_device(&root, "1-2", "0764", Some(CYBERPOWER));
        fake_device(&root, "1-3", "046d", Some(KEYBOARD));
        fake_device(&root, "1-4", "051d", None);
        fake_device(&root, "1-5", "1234", None);
        let found = discover_usb(&root);
        let ids: Vec<&str> = found.iter().map(|u| u.id.as_str()).collect();
        assert_eq!(ids, ["usb-051d-0601-1-4", "usb-0764-0601-1-2"]);
        assert_eq!(found[1].product, "A03-OP2002-RC");
        assert_eq!(found[1].bus, "001");
        fs::remove_dir_all(&root).unwrap();
    }

    #[test]
    fn upsd_and_upsc_output_parse_to_the_same_variables() {
        let list = "VAR ups battery.charge \"100\"\nVAR ups ups.status \"OL CHRG\"\nVAR ups ups.model \"A03 \\\"OP\\\"\"\n";
        let upsc =
            "battery.charge: 100\nups.status: OL CHRG\nInit SSL without certificate database\n";
        let a = parse_vars(list);
        let b = parse_vars(upsc);
        assert_eq!(a.get("battery.charge"), b.get("battery.charge"));
        assert_eq!(a.get("ups.status").map(String::as_str), Some("OL CHRG"));
        assert_eq!(a.get("ups.model").map(String::as_str), Some("A03 \"OP\""));
        assert_eq!(b.len(), 2);
        assert_eq!(
            parse_cmds("CMD ups beeper.enable\nCMD ups test.battery.start.quick\n"),
            ["beeper.enable", "test.battery.start.quick"]
        );
    }

    #[test]
    fn a_full_upsc_listing_of_the_cyberpower_chipset_parses() {
        let text = include_str!("../tests/fixtures/upsc-usbhid-0764-0601.txt");
        let vars = parse_vars(text);
        // The SSL banner is not a variable; every `name: value` line is.
        assert!(!vars.keys().any(|name| name.contains(' ')));
        assert_eq!(
            vars.len(),
            text.lines().filter(|line| line.contains(": ")).count()
        );
        assert_eq!(vars.get("ups.status").map(String::as_str), Some("OL CHRG"));
        assert_eq!(
            vars.get("battery.runtime").map(String::as_str),
            Some("1260")
        );
        assert_eq!(
            vars.get("driver.parameter.vendorid").map(String::as_str),
            Some("0764")
        );
        assert_eq!(
            vars.get("ups.timer.shutdown").map(String::as_str),
            Some("-60")
        );
        assert_eq!(
            vars.get("ups.test.result").map(String::as_str),
            Some("Done and passed")
        );
        // The same variables over the wire, quoted, parse to the same values.
        let wire: String = vars
            .iter()
            .map(|(name, value)| format!("VAR ups {name} \"{value}\"\n"))
            .collect();
        assert_eq!(parse_vars(&wire), vars);
    }

    #[test]
    fn snmp_sources_are_validated_and_cannot_break_out_of_the_config() {
        let ok = SnmpSource {
            address: "192.168.1.50".into(),
            version: "v2c".into(),
            community: Some("public".into()),
            user: None,
            auth_password: None,
            priv_password: None,
        };
        assert!(ok.validate().is_ok());
        let quote = SnmpSource {
            community: Some("x\"\n[evil]".into()),
            ..ok.clone()
        };
        assert!(quote.validate().is_err());
        let no_user = SnmpSource {
            version: "v3".into(),
            community: None,
            ..ok.clone()
        };
        assert!(no_user.validate().is_err());
        let conf = render_ups_conf(&[], std::slice::from_ref(&ok));
        assert!(conf.contains("driver = snmp-ups"));
        assert!(conf.contains("port = \"192.168.1.50\""));
        assert!(conf.contains("community = \"public\""));
        assert_eq!(ok.name(), ok.clone().name());
        assert!(
            serde_json::from_str::<SnmpSource>(r#"{"address":"a","version":"v1","x":1}"#).is_err()
        );
    }

    #[test]
    fn a_changed_credential_is_a_changed_driver_and_an_address_is_one_name() {
        let first = SnmpSource {
            address: "192.168.1.50".into(),
            version: "v2c".into(),
            community: Some("public".into()),
            user: None,
            auth_password: None,
            priv_password: None,
        };
        let fixed = SnmpSource {
            community: Some("private".into()),
            ..first.clone()
        };
        let other = SnmpSource {
            address: "192.168.1.51".into(),
            ..first.clone()
        };
        let before = sections(&[], std::slice::from_ref(&first));
        let after = sections(&[], std::slice::from_ref(&fixed));
        assert_eq!(before[0].0, after[0].0);
        assert_ne!(before[0].2, after[0].2);
        let kept = dedupe(vec![first.clone(), other.clone(), fixed.clone()]);
        assert_eq!(kept, vec![other.clone(), fixed.clone()]);
        assert_eq!(
            render_ups_conf(&[], &kept),
            format!(
                "maxretry = 3\n{}{}",
                snmp_section(&other),
                snmp_section(&fixed)
            )
        );
    }

    #[test]
    fn upsd_only_listens_on_loopback_and_commands_are_allowlisted() {
        assert_eq!(render_upsd_conf(), "LISTEN 127.0.0.1 3493\n");
        assert!(render_upsd_users("s3cret").contains("instcmds = ALL"));
        assert!(command("usb-x", "load.off").is_err());
        assert!(command("usb-x", "shutdown.return").is_err());
    }

    #[test]
    fn the_usb_config_names_the_exact_device() {
        let ups = UsbUps {
            id: "usb-0764-0601-ct0".into(),
            vendor_id: "0764".into(),
            product_id: "0601".into(),
            manufacturer: String::new(),
            product: "A03-OP2002-RC".into(),
            serial: "CT0".into(),
            bus: "001".into(),
        };
        let conf = render_ups_conf(&[ups], &[]);
        assert!(conf.contains("[usb-0764-0601-ct0]\n  driver = usbhid-ups\n  port = auto\n  vendorid = 0764\n  productid = 0601\n  bus = \"001\"\n  serial = \"CT0\"\n"));
    }
}

// ---------------------------------------------------------------------------
// Powering the host off
// ---------------------------------------------------------------------------

/// The one name a power-off runs under, so two never overlap.
pub const POWEROFF_CONTAINER: &str = "polaris-ups-poweroff";

/// What powers the host off, run on the host itself (the same short-lived
/// container shape as the GPU reading): systemd's clean shutdown where there is
/// one, the classic commands otherwise. Takes no input.
pub const POWEROFF_SCRIPT: &str =
    "sync; systemctl poweroff 2>/dev/null || shutdown -h now 2>/dev/null || poweroff";

/// The arguments after `docker`.
pub fn poweroff_argv() -> Vec<String> {
    [
        "run",
        "--rm",
        "--name",
        POWEROFF_CONTAINER,
        "--privileged",
        "--pid",
        "host",
        "--network",
        "none",
        "-v",
        "/:/host",
        crate::host_security::TOOLS_IMAGE,
        "chroot",
        "/host",
        "/bin/sh",
        "-c",
        POWEROFF_SCRIPT,
    ]
    .iter()
    .map(|s| s.to_string())
    .collect()
}

/// Start the power-off and return: the daemon goes down with the host.
pub fn power_off() -> io::Result<()> {
    Command::new("docker")
        .args(poweroff_argv())
        .stdin(Stdio::null())
        .stdout(Stdio::null())
        .stderr(Stdio::null())
        .spawn()
        .map(|_| ())
}

#[cfg(test)]
mod poweroff_tests {
    use super::*;

    #[test]
    fn the_power_off_is_fixed_and_offline() {
        let args = poweroff_argv();
        assert!(args.windows(2).any(|w| w == ["--network", "none"]));
        assert!(args.windows(2).any(|w| w == ["--name", POWEROFF_CONTAINER]));
        assert_eq!(args.last().map(String::as_str), Some(POWEROFF_SCRIPT));
    }
}
