import { join } from "node:path";
import { readFileSync } from "node:fs";
import { createHash } from "node:crypto";
import { describe, expect, it } from "vitest";
import * as driver from "../../../src/main/plugins/hercules-driver";
import type { OfficialHost } from "../../../src/main/plugins/hercules-official-run";

const DATE = new Date(Date.UTC(2026, 10, 26));
const PATHS: driver.DriverPaths = { systemRoot: "C:\\Windows", programData: "C:\\ProgramData", dataDir: join("C:", "data", "official", "hercules-stream100") };

function fakeHost(answers: { look?: string; lookCode?: number; record?: string | null; elevated?: number; }) {
    const runs: { file: string; args: readonly string[]; env?: Readonly<Record<string, string>>; }[] = [];
    const written = new Map<string, string>();
    const host: OfficialHost = {
        run: async (file, args, env) => {
            runs.push({ file, args, env });
            if (env?.POLARIS_FILE) return { code: answers.elevated ?? 0, stdout: "" };
            return { code: answers.lookCode ?? 0, stdout: answers.look ?? "" };
        },
        launch: async () => false,
        readText: async (path) => (path === driver.recordPath(PATHS) ? (answers.record ?? null) : null),
        writeText: async (path, text) => void written.set(path, text),
        exists: async () => false,
        sleep: async () => undefined
    };
    return { host, runs, written };
}

const RECORD = JSON.stringify({ version: 1, published: "oem42.inf", previous: "oem7.inf", thumbprint: "AB", at: "2026-11-26T00:00:00.000Z" });

describe("the WinUSB INF", () => {
    const inf = driver.renderInf(DATE);

    it("binds the whole Stream 100 to Windows' own WinUSB, with our interface GUID", () => {
        expect(inf).toContain("Class = USBDevice");
        expect(inf).toContain("ClassGUID = {88BAE032-5A81-49f0-BC3D-A4FF138216D6}");
        expect(inf).toContain("CatalogFile = polaris-stream100.cat");
        expect(inf).toContain("DriverVer = 11/26/2026,1.0.0.0");
        expect(inf).toContain("%DeviceName% = Stream100_Install, USB\\VID_06F8&PID_E053\r\n");
        expect(inf).toContain("Include = winusb.inf\r\nNeeds = WINUSB.NT\r\n");
        expect(inf).toContain("Needs = WINUSB.NT.Services");
        expect(inf).toContain(`HKR,,DeviceInterfaceGUIDs,0x10000,"${driver.DRIVER_INTERFACE_GUID}"`);
        // No interface suffix: the whole device, as the Hercules package matches it.
        expect(inf).not.toContain("&MI_");
    });

    it("is plain ASCII with CRLF line ends", () => {
        expect(/^[\x20-\x7e\r\n]*$/.test(inf)).toBe(true);
        expect(inf.replace(/\r\n/g, "")).not.toContain("\n");
    });

    it("refuses a malformed version", () => {
        expect(() => driver.renderInf(DATE, "1.0")).toThrow();
    });

    it("uses the same interface GUID the Rust transport looks for", () => {
        const rust = readFileSync(join(__dirname, "../../../../../crates/polaris-stream100/src/session.rs"), "utf8");
        expect(rust).toContain(`pub const DEVICE_INTERFACE_GUID: &str = "${driver.DRIVER_INTERFACE_GUID}";`);
    });
});

describe("the elevated script", () => {
    const script = driver.driverScript(driver.renderInf(DATE));

    it("carries the INF inside it and takes nothing but the action", () => {
        expect(script).toContain("param([ValidateSet('install','remove')][string]$Action)");
        expect(script).toContain("Needs = WINUSB.NT");
        expect(script).not.toMatch(/\$env:POLARIS/);
    });

    it("limits the certificate to code signing, names it for Polaris, and deletes its private key", () => {
        expect(script).toContain("New-SelfSignedCertificate -Type CodeSigningCert -Subject $subject");
        expect(script).toContain("-KeyExportPolicy NonExportable");
        expect(script).toContain("ca=false");
        expect(driver.CERT_SUBJECT).toMatch(/^CN=Polaris /);
        expect(script).toMatch(/finally \{\s+if \(\$cert\) \{ Remove-Item -LiteralPath \('Cert:\\LocalMachine\\My\\' \+ \$cert\.Thumbprint\) -DeleteKey/);
    });

    it("trusts it in the machine's Root and TrustedPublisher stores only", () => {
        expect(script).toContain("foreach ($name in 'Root', 'TrustedPublisher')");
        expect(script).toContain("::new($name, 'LocalMachine')");
    });

    it("removes our package and certificate, and puts the previous driver back", () => {
        expect(script).toContain("/delete-driver ([string]$state.published) /uninstall /force");
        expect(script).toContain("Remove-OurCerts");
        expect(script).toContain("$previousInf = Join-Path $env:SystemRoot ('INF\\' + [string]$state.previous)");
        expect(script).toContain("'^oem\\d+\\.inf$'");
    });

    it("refuses an INF that would end its here-string", () => {
        expect(() => driver.driverScript("x\n'@\nWrite-Host hi")).toThrow();
    });
});

describe("the launcher", () => {
    const hash = "A".repeat(64);

    it("checks the hash on the bytes it runs and exits with the script's code", () => {
        const command = driver.launcherCommand("C:\\data\\it's here\\stream100-driver.ps1", hash, "install");
        expect(command).toContain("ReadAllBytes('C:\\data\\it''s here\\stream100-driver.ps1')");
        expect(command).toContain(`if ($h -ne '${hash}') { exit 87 }`);
        expect(command).toContain("[scriptblock]::Create([Text.Encoding]::UTF8.GetString($b))) 'install'");
        expect(command.endsWith("exit [int]$r")).toBe(true);
    });

    it("refuses a hash that is not one", () => {
        expect(() => driver.launcherCommand("C:\\x.ps1", "abc", "install")).toThrow();
    });
});

describe("deciding what the page offers", () => {
    it("asks for nothing off Windows", () => {
        expect(driver.decideDriver("linux", { present: true, service: "" }, null)).toEqual({ state: "notNeeded" });
    });

    it("offers the setup while Hercules' driver holds the controller", () => {
        expect(driver.decideDriver("win32", { present: true, service: "HercStreamMixDevice" }, null)).toEqual({ state: "needed", hercules: true });
        expect(driver.decideDriver("win32", { present: true, service: "" }, null)).toEqual({ state: "needed", hercules: false });
    });

    it("is set up once our driver is on the device", () => {
        expect(driver.decideDriver("win32", { present: true, service: "WinUSB" }, JSON.parse(RECORD))).toEqual({ state: "installed" });
    });

    it("leaves a WinUSB someone else installed alone", () => {
        expect(driver.decideDriver("win32", { present: true, service: "WinUSB" }, null)).toEqual({ state: "notNeeded" });
    });

    it("offers it again when another driver took the device back", () => {
        expect(driver.decideDriver("win32", { present: true, service: "HercStreamMixDevice" }, JSON.parse(RECORD))).toEqual({ state: "repair" });
    });

    it("needs the controller plugged in", () => {
        expect(driver.decideDriver("win32", { present: false, service: "" }, null)).toEqual({ state: "unplugged", installed: false });
        expect(driver.decideDriver("win32", null, JSON.parse(RECORD))).toEqual({ state: "unplugged", installed: true });
    });

    it("names every exit code of the elevated side", () => {
        expect(driver.failureOf(0)).toBeNull();
        expect(driver.failureOf(1223)).toBe("declined");
        expect(driver.failureOf(13)).toBe("binding");
        expect(driver.failureOf(87)).toBe("failed");
        expect(driver.failureOf(-1)).toBe("failed");
    });
});

describe("the runner", () => {
    it("reads the device and the record to answer the state", async () => {
        const { host } = fakeHost({ look: '{"present":true,"service":"WinUSB"}', record: RECORD });
        const runner = driver.createDriverRunner(host, PATHS, "win32", () => DATE);
        expect(await runner.state()).toEqual({ state: "installed" });
        expect(await runner.installed()).toBe(true);
    });

    it("ignores a record that does not name one of Windows' published INFs", async () => {
        const { host } = fakeHost({ look: '{"present":true,"service":"WinUSB"}', record: JSON.stringify({ version: 1, published: "..\\evil.inf", previous: null }) });
        const runner = driver.createDriverRunner(host, PATHS, "win32", () => DATE);
        expect(await runner.installed()).toBe(false);
    });

    it("elevates once, with the script's own hash, as an argument array", async () => {
        const { host, runs, written } = fakeHost({ elevated: 0 });
        const runner = driver.createDriverRunner(host, PATHS, "win32", () => DATE);
        expect(await runner.install()).toEqual({ ok: true });
        const elevated = runs.filter((run) => run.env?.POLARIS_FILE);
        expect(elevated).toHaveLength(1);
        const [run] = elevated;
        expect(run?.env?.POLARIS_FILE).toBe("C:\\Windows\\System32\\WindowsPowerShell\\v1.0\\powershell.exe");
        const scriptPath = join(PATHS.dataDir, "stream100-driver.ps1");
        const script = written.get(scriptPath) ?? "";
        const sha = createHash("sha256").update(Buffer.from(script, "utf8")).digest("hex").toUpperCase();
        expect(run?.env?.POLARIS_ARGS).toContain(sha);
        expect(run?.env?.POLARIS_ARGS).toContain("'install'");
    });

    it("says the prompt was declined", async () => {
        const { host } = fakeHost({ elevated: 1223 });
        const runner = driver.createDriverRunner(host, PATHS, "win32", () => DATE);
        expect(await runner.install()).toEqual({ ok: false, reason: "declined" });
    });

    it("does nothing off Windows", async () => {
        const { host, runs } = fakeHost({});
        const runner = driver.createDriverRunner(host, PATHS, "darwin", () => DATE);
        expect(await runner.state()).toEqual({ state: "notNeeded" });
        expect(await runner.installed()).toBe(false);
        expect(runs).toHaveLength(0);
    });
});
