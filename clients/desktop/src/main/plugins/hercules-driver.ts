/**
 * The Stream 100's own driver package, made on this PC: WinUSB for
 * `USB\VID_06F8&PID_E053`, so Polaris reads the controller with no Hercules
 * software at all (docs/devices/hercules-stream100.md, "Polaris' WinUSB driver").
 *
 * The approach is Zadig / libwdi's, studied as a reference and reimplemented
 * with Windows' own tools: an INF that includes Windows' inbox `winusb.inf`, a
 * catalog for it, a self-signed code-signing certificate created for this PC
 * only, trusted in the machine's Root and TrustedPublisher stores, the catalog
 * signed with it, and its private key deleted right after, so nothing else can
 * ever be signed with it. Everything that needs administrator rights runs in
 * one elevated PowerShell (one prompt), from a script whose SHA-256 the
 * elevated side checks on the very bytes it then runs.
 */

import { z } from "zod";
import { join } from "node:path";
import { createHash } from "node:crypto";
import { DECLINED, runElevated, type OfficialHost } from "./hercules-official-run";

/** The device interface the INF registers; the same value as `DEVICE_INTERFACE_GUID` in crates/polaris-stream100/src/session.rs. */
export const DRIVER_INTERFACE_GUID = "{24a30efc-7c61-4f1a-baaa-f87f84a38ce1}";
export const HARDWARE_ID = "USB\\VID_06F8&PID_E053";
/** The certificate's subject: named for Polaris and for this one package. */
export const CERT_SUBJECT = "CN=Polaris Stream 100 driver (this PC only), O=Polaris";
export const INF_NAME = "polaris-stream100.inf";
export const CAT_NAME = "polaris-stream100.cat";
/** Windows' class for USB devices that are not of a standard class (Microsoft's WinUSB INF template). */
const USB_DEVICE_CLASS = "{88BAE032-5A81-49f0-BC3D-A4FF138216D6}";

/** Exit codes of the elevated script. */
export const EXIT = { ok: 0, certificate: 10, signing: 11, binding: 13, unplugged: 14, removing: 20, integrity: 87, declined: DECLINED } as const;

export type DriverFailure = "declined" | "unplugged" | "certificate" | "signing" | "binding" | "removing" | "failed";

export function failureOf(code: number): DriverFailure | null {
    switch (code) {
        case EXIT.ok:
            return null;
        case EXIT.declined:
            return "declined";
        case EXIT.unplugged:
            return "unplugged";
        case EXIT.certificate:
            return "certificate";
        case EXIT.signing:
            return "signing";
        case EXIT.binding:
            return "binding";
        case EXIT.removing:
            return "removing";
        default:
            return "failed";
    }
}

/** `MM/DD/YYYY`, as an INF's `DriverVer` wants it. */
function infDate(date: Date): string {
    const pad = (value: number) => String(value).padStart(2, "0");
    return `${pad(date.getUTCMonth() + 1)}/${pad(date.getUTCDate())}/${date.getUTCFullYear()}`;
}

/**
 * The INF, after Microsoft's WinUSB template ("WinUSB (Winusb.sys) installation
 * for developers"): the whole device to WinUSB, with our interface GUID. CRLF
 * and ASCII only, as INFs are read.
 */
export function renderInf(date: Date, version = "1.0.0.0"): string {
    if (!/^\d+\.\d+\.\d+\.\d+$/.test(version)) throw new Error("bad driver version");
    const lines = [
        "; Polaris' WinUSB driver for the Hercules Stream 100, made on this PC.",
        "[Version]",
        "Signature = \"$Windows NT$\"",
        "Class = USBDevice",
        `ClassGUID = ${USB_DEVICE_CLASS}`,
        "Provider = %Provider%",
        `CatalogFile = ${CAT_NAME}`,
        `DriverVer = ${infDate(date)},${version}`,
        "PnpLockdown = 1",
        "",
        "[Manufacturer]",
        "%Provider% = Polaris, NTamd64, NTarm64",
        "",
        "[Polaris.NTamd64]",
        `%DeviceName% = Stream100_Install, ${HARDWARE_ID}`,
        "",
        "[Polaris.NTarm64]",
        `%DeviceName% = Stream100_Install, ${HARDWARE_ID}`,
        "",
        "[Stream100_Install]",
        "Include = winusb.inf",
        "Needs = WINUSB.NT",
        "",
        "[Stream100_Install.Services]",
        "Include = winusb.inf",
        "Needs = WINUSB.NT.Services",
        "",
        "[Stream100_Install.HW]",
        "AddReg = Stream100_AddReg",
        "",
        "[Stream100_AddReg]",
        `HKR,,DeviceInterfaceGUIDs,0x10000,"${DRIVER_INTERFACE_GUID}"`,
        "",
        "[Strings]",
        "Provider = \"Polaris\"",
        "DeviceName = \"Hercules Stream 100 (Polaris)\"",
        ""
    ];
    return lines.join("\r\n");
}

/**
 * The elevated script. It takes nothing from the unelevated side but the
 * action: the INF is inside it and every path is derived from `%ProgramData%`.
 * It prints one exit code as its last output line.
 */
export function driverScript(inf: string): string {
    if (inf.includes("'@")) throw new Error("the INF cannot hold a here-string end");
    return `param([ValidateSet('install','remove')][string]$Action)
$ErrorActionPreference = 'Stop'
$hw = '${HARDWARE_ID}'
$subject = '${CERT_SUBJECT}'
$parent = Join-Path $env:ProgramData 'Polaris'
$root = Join-Path $parent 'stream100-driver'
$statePath = Join-Path $root 'state.json'
$pnputil = Join-Path $env:SystemRoot 'System32\\pnputil.exe'
$infText = @'
${inf}
'@
Add-Type -Namespace PolarisStream100 -Name Setup -MemberDefinition @'
[DllImport("newdev.dll", CharSet = CharSet.Unicode, SetLastError = true)]
public static extern bool UpdateDriverForPlugAndPlayDevicesW(IntPtr parent, string hardwareId, string infPath, uint flags, out bool reboot);
'@
function Get-Stream { Get-PnpDevice -PresentOnly -ErrorAction SilentlyContinue | Where-Object { $_.HardwareID -contains $hw } | Select-Object -First 1 }
function Get-InfOf([string]$id) { [string](Get-PnpDeviceProperty -InstanceId $id -KeyName 'DEVPKEY_Device_DriverInfPath' -ErrorAction SilentlyContinue).Data }
function Read-State { if (Test-Path -LiteralPath $statePath) { try { Get-Content -LiteralPath $statePath -Raw | ConvertFrom-Json } catch { $null } } else { $null } }
function Clear-Link([string]$path) { if (Test-Path -LiteralPath $path) { $item = Get-Item -LiteralPath $path -Force; if ($item.Attributes -band [IO.FileAttributes]::ReparsePoint) { $item.Delete() } } }
function Lock-Root {
    Clear-Link $parent
    if (-not (Test-Path -LiteralPath $parent)) { New-Item -ItemType Directory -Path $parent | Out-Null }
    Clear-Link $root
    if (-not (Test-Path -LiteralPath $root)) { New-Item -ItemType Directory -Path $root | Out-Null }
    $acl = New-Object System.Security.AccessControl.DirectorySecurity
    $acl.SetAccessRuleProtection($true, $false)
    $admins = New-Object System.Security.Principal.SecurityIdentifier('S-1-5-32-544')
    $acl.SetOwner($admins)
    foreach ($rule in @(@('S-1-5-18', 'FullControl'), @('S-1-5-32-544', 'FullControl'), @('S-1-5-32-545', 'ReadAndExecute'))) {
        $sid = New-Object System.Security.Principal.SecurityIdentifier($rule[0])
        $acl.AddAccessRule((New-Object System.Security.AccessControl.FileSystemAccessRule($sid, $rule[1], 'ContainerInherit,ObjectInherit', 'None', 'Allow')))
    }
    Set-Acl -LiteralPath $root -AclObject $acl
}
function Remove-OurCerts { foreach ($store in 'My', 'Root', 'TrustedPublisher') { Get-ChildItem -LiteralPath ('Cert:\\LocalMachine\\' + $store) | Where-Object { $_.Subject -eq $subject } | ForEach-Object { Remove-Item -LiteralPath $_.PSPath -DeleteKey -ErrorAction SilentlyContinue } } }
function Add-Trust($cert) {
    $public = [System.Security.Cryptography.X509Certificates.X509Certificate2]::new($cert.RawData)
    foreach ($name in 'Root', 'TrustedPublisher') {
        $store = [System.Security.Cryptography.X509Certificates.X509Store]::new($name, 'LocalMachine')
        $store.Open('ReadWrite'); $store.Add($public); $store.Close()
    }
}
function Install-Driver {
    $device = Get-Stream
    if (-not $device) { return ${EXIT.unplugged} }
    Lock-Root
    $old = Read-State
    $previous = Get-InfOf $device.InstanceId
    if ($old -and $previous -eq $old.published) { $previous = [string]$old.previous }
    $package = Join-Path $root ('package-' + [guid]::NewGuid().ToString('N'))
    New-Item -ItemType Directory -Path $package | Out-Null
    $inf = Join-Path $package '${INF_NAME}'
    $cat = Join-Path $package '${CAT_NAME}'
    [IO.File]::WriteAllText($inf, $infText, [Text.Encoding]::ASCII)
    Remove-OurCerts
    $code = 0
    $cert = $null
    try {
        try { $cert = New-SelfSignedCertificate -Type CodeSigningCert -Subject $subject -CertStoreLocation 'Cert:\\LocalMachine\\My' -KeyAlgorithm RSA -KeyLength 3072 -HashAlgorithm SHA256 -KeyExportPolicy NonExportable -NotAfter (Get-Date).AddYears(10) -TextExtension @('2.5.29.19={critical}{text}ca=false') } catch { $code = ${EXIT.certificate} }
        if ($code -eq 0) {
            try {
                Add-Trust $cert
                New-FileCatalog -Path $package -CatalogFilePath $cat -CatalogVersion 2.0 | Out-Null
                $signed = Set-AuthenticodeSignature -FilePath $cat -Certificate $cert -HashAlgorithm SHA256
                if ($signed.Status -ne 'Valid') { $code = ${EXIT.signing} }
            } catch { $code = ${EXIT.signing} }
        }
    } finally {
        if ($cert) { Remove-Item -LiteralPath ('Cert:\\LocalMachine\\My\\' + $cert.Thumbprint) -DeleteKey -ErrorAction SilentlyContinue }
    }
    if ($code -eq 0) {
        $reboot = $false
        $bound = [PolarisStream100.Setup]::UpdateDriverForPlugAndPlayDevicesW([IntPtr]::Zero, $hw, $inf, 1, [ref]$reboot)
        $published = Get-InfOf $device.InstanceId
        if (-not $bound -or -not $published -or $published -eq $previous) { $code = ${EXIT.binding} }
    }
    if ($code -eq 0) {
        [pscustomobject]@{ version = 1; published = $published; thumbprint = $cert.Thumbprint; previous = $previous; at = (Get-Date).ToUniversalTime().ToString('o') } | ConvertTo-Json -Compress | Set-Content -LiteralPath $statePath -Encoding ASCII
    } else {
        Remove-OurCerts
    }
    Remove-Item -LiteralPath $package -Recurse -Force -ErrorAction SilentlyContinue
    return $code
}
function Remove-Driver {
    $state = Read-State
    if (-not $state) { Remove-OurCerts; return 0 }
    if ([string]$state.published -match '^oem\\d+\\.inf$') {
        & $pnputil /delete-driver ([string]$state.published) /uninstall /force | Out-Null
        if ($LASTEXITCODE -ne 0 -and $LASTEXITCODE -ne 3010) { return ${EXIT.removing} }
    }
    Remove-OurCerts
    if ([string]$state.previous -match '^oem\\d+\\.inf$') {
        $previousInf = Join-Path $env:SystemRoot ('INF\\' + [string]$state.previous)
        if (Test-Path -LiteralPath $previousInf) { $reboot = $false; [void][PolarisStream100.Setup]::UpdateDriverForPlugAndPlayDevicesW([IntPtr]::Zero, $hw, $previousInf, 0, [ref]$reboot) }
    }
    & $pnputil /scan-devices | Out-Null
    Remove-Item -LiteralPath $statePath -Force -ErrorAction SilentlyContinue
    return 0
}
try { if ($Action -eq 'install') { Install-Driver } else { Remove-Driver } } catch { 1 }
`;
}

export type DriverAction = "install" | "remove";

/**
 * The `-Command` the elevated PowerShell runs: read the script once, check
 * its hash on those bytes, run those same bytes, exit with its code.
 */
export function launcherCommand(scriptPath: string, sha256: string, action: DriverAction): string {
    if (!/^[0-9A-F]{64}$/.test(sha256)) throw new Error("bad script hash");
    const literal = `'${scriptPath.replace(/'/g, "''")}'`;
    return [
        `$b = [IO.File]::ReadAllBytes(${literal});`,
        "$h = [BitConverter]::ToString([Security.Cryptography.SHA256]::Create().ComputeHash($b)).Replace('-', '');",
        `if ($h -ne '${sha256}') { exit ${EXIT.integrity} };`,
        `$r = & ([scriptblock]::Create([Text.Encoding]::UTF8.GetString($b))) '${action}' | Select-Object -Last 1;`,
        "exit [int]$r"
    ].join(" ");
}

/** What Windows says about the controller right now (unelevated). */
export const LOOK_SCRIPT = [
    "$ErrorActionPreference = 'SilentlyContinue';",
    `$d = Get-PnpDevice -PresentOnly | Where-Object { $_.HardwareID -contains '${HARDWARE_ID}' } | Select-Object -First 1;`,
    "if ($d) { [pscustomobject]@{ present = $true; service = [string]$d.Service } | ConvertTo-Json -Compress } else { '{\"present\":false,\"service\":\"\"}' }"
].join(" ");

const lookSchema = z.object({ present: z.boolean(), service: z.string().max(200).nullable().catch("") });
const recordSchema = z.object({ version: z.literal(1), published: z.string().regex(/^oem\d+\.inf$/i), previous: z.string().max(100).nullable().catch(null), thumbprint: z.string().max(100).optional(), at: z.string().max(40).optional() });

export type DriverRecord = z.infer<typeof recordSchema>;
export interface DriverLook {
    readonly present: boolean;
    readonly service: string;
}

/** What the plugin page shows. */
export type DriverState =
    /** Not Windows, or WinUSB is already on the device by some other tool: nothing to set up. */
    | { readonly state: "notNeeded"; }
    /** Polaris' driver is on the device. */
    | { readonly state: "installed"; }
    /** The one-time setup has not been done: offer Install. `hercules` when Hercules' driver holds it today. */
    | { readonly state: "needed"; readonly hercules: boolean; }
    /** It was set up, but the device is on another driver now (a Hercules reinstall, Windows Update): offer it again. */
    | { readonly state: "repair"; }
    /** Not plugged in: setup needs the controller there. `installed` when it was set up before. */
    | { readonly state: "unplugged"; readonly installed: boolean; };

export function decideDriver(platform: NodeJS.Platform, look: DriverLook | null, record: DriverRecord | null): DriverState {
    if (platform !== "win32") return { state: "notNeeded" };
    if (!look || !look.present) return { state: "unplugged", installed: record !== null };
    const service = look.service.toLowerCase();
    if (service === "winusb") return record ? { state: "installed" } : { state: "notNeeded" };
    if (record) return { state: "repair" };
    return { state: "needed", hercules: service === "hercstreammixdevice" };
}

export interface DriverPaths {
    readonly systemRoot: string;
    readonly programData: string;
    /** Where the script is written before the elevated side checks and runs it. */
    readonly dataDir: string;
}

export const recordPath = (paths: DriverPaths) => join(paths.programData, "Polaris", "stream100-driver", "state.json");

export type DriverOutcome = { readonly ok: true; } | { readonly ok: false; readonly reason: DriverFailure; };

export function createDriverRunner(host: OfficialHost, paths: DriverPaths, platform: NodeJS.Platform = process.platform, now: () => Date = () => new Date()) {
    const powershell = `${paths.systemRoot}\\System32\\WindowsPowerShell\\v1.0\\powershell.exe`;

    async function record(): Promise<DriverRecord | null> {
        const text = await host.readText(recordPath(paths), 16 * 1024);
        if (!text) return null;
        try {
            const parsed = recordSchema.safeParse(JSON.parse(text.replace(/^﻿/, "")));
            return parsed.success ? parsed.data : null;
        } catch {
            return null;
        }
    }

    async function look(): Promise<DriverLook | null> {
        const out = await host.run(powershell, ["-NoProfile", "-NonInteractive", "-ExecutionPolicy", "Bypass", "-Command", LOOK_SCRIPT]);
        if (out.code !== 0) return null;
        try {
            const parsed = lookSchema.safeParse(JSON.parse(out.stdout.trim()));
            return parsed.success ? { present: parsed.data.present, service: parsed.data.service ?? "" } : null;
        } catch {
            return null;
        }
    }

    async function elevate(action: DriverAction): Promise<DriverOutcome> {
        const script = Buffer.from(driverScript(renderInf(now())), "utf8");
        const sha256 = createHash("sha256").update(script).digest("hex").toUpperCase();
        const scriptPath = join(paths.dataDir, "stream100-driver.ps1");
        await host.writeText(scriptPath, script.toString("utf8"));
        const args = ["-NoProfile", "-NonInteractive", "-ExecutionPolicy", "Bypass", "-Command", launcherCommand(scriptPath, sha256, action)];
        const code = await runElevated(host, paths.systemRoot, powershell, args);
        const reason = failureOf(code);
        return reason ? { ok: false, reason } : { ok: true };
    }

    return {
        async state(): Promise<DriverState> {
            if (platform !== "win32") return { state: "notNeeded" };
            const [seen, kept] = await Promise.all([look(), record()]);
            return decideDriver(platform, seen, kept);
        },
        /** Polaris' driver was set up on this PC (its record exists). */
        installed: async () => platform === "win32" && (await record()) !== null,
        install: () => elevate("install"),
        remove: () => elevate("remove")
    };
}

export type DriverRunner = ReturnType<typeof createDriverRunner>;
