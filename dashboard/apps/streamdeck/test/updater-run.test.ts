/**
 * The Windows install script's scheduled run, for real, against a stand-in
 * release feed: it installs the newest plugin into the folder it is given, and
 * brings a task an older release registered (every six hours) up to this
 * release's hourly schedule - only a task that runs this updater.
 *
 * Nothing real is touched. The run's AppData folders point into a temporary
 * one, and the scheduled-task and process commands are stand-ins (a function
 * shadows a command of the same name). It fails closed: a run whose stand-ins
 * did not take, or whose AppData is not the temporary one, stops before the
 * script starts, and the test fails.
 */

import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import { createHash } from "node:crypto";
import { createServer, type Server } from "node:http";
import { execFile, spawnSync } from "node:child_process";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";

const SCRIPT = join(__dirname, "..", "scripts", "install.ps1");
const UUID = "io.github.fjrg2007.polaris";

/** A zip with its entries stored, which .NET's ZipFile reads. */
function zip(files: Record<string, string>): Buffer {
    const table = new Uint32Array(256).map((_, n) => {
        let c = n;
        for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
        return c >>> 0;
    });
    const crc = (data: Buffer) => {
        let c = 0xffffffff;
        for (const byte of data) c = table[(c ^ byte) & 0xff]! ^ (c >>> 8);
        return (c ^ 0xffffffff) >>> 0;
    };
    const local: Buffer[] = [];
    const central: Buffer[] = [];
    let offset = 0;
    for (const [name, text] of Object.entries(files)) {
        const data = Buffer.from(text);
        const path = Buffer.from(name);
        const head = Buffer.alloc(30);
        head.writeUInt32LE(0x04034b50, 0);
        head.writeUInt16LE(20, 4);
        head.writeUInt32LE(crc(data), 14);
        head.writeUInt32LE(data.length, 18);
        head.writeUInt32LE(data.length, 22);
        head.writeUInt16LE(path.length, 26);
        const entry = Buffer.alloc(46);
        entry.writeUInt32LE(0x02014b50, 0);
        entry.writeUInt16LE(20, 4);
        entry.writeUInt16LE(20, 6);
        entry.writeUInt32LE(crc(data), 16);
        entry.writeUInt32LE(data.length, 20);
        entry.writeUInt32LE(data.length, 24);
        entry.writeUInt16LE(path.length, 28);
        entry.writeUInt32LE(offset, 42);
        local.push(head, path, data);
        central.push(entry, path);
        offset += head.length + path.length + data.length;
    }
    const size = central.reduce((sum, part) => sum + part.length, 0);
    const end = Buffer.alloc(22);
    end.writeUInt32LE(0x06054b50, 0);
    end.writeUInt16LE(Object.keys(files).length, 8);
    end.writeUInt16LE(Object.keys(files).length, 10);
    end.writeUInt32LE(size, 12);
    end.writeUInt32LE(offset, 16);
    return Buffer.concat([...local, ...central, end]);
}

const sha = (data: Buffer) => `sha256:${createHash("sha256").update(data).digest("hex")}`;

/** The stand-in for GitHub: the plugin releases it lists, and their files. */
class Feed {
    server: Server | null = null;
    port = 0;
    files = new Map<string, Buffer>();
    releases: object[] = [];

    publish(version: string): void {
        const tag = `streamdeck-v${version}`;
        const manifest = JSON.stringify({ UUID, Version: `${version}.0` });
        const pack = zip({ [`${UUID}.sdPlugin/manifest.json`]: manifest });
        const script = readFileSync(SCRIPT);
        const name = `${UUID}.streamDeckPlugin`;
        this.files.set(`${tag}/${name}`, pack);
        this.files.set(`${tag}/install.ps1`, script);
        const url = (file: string) => `http://127.0.0.1:${this.port}/dl/${tag}/${file}`;
        this.releases.unshift({
            tag_name: tag,
            draft: false,
            prerelease: false,
            assets: [
                { name, digest: sha(pack), browser_download_url: url(name) },
                { name: "install.ps1", digest: sha(script), browser_download_url: url("install.ps1") }
            ]
        });
    }

    async start(): Promise<void> {
        this.server = createServer((request, response) => {
            const path = (request.url ?? "").split("?")[0]!;
            if (path === "/repos/test/polaris/releases") {
                response.setHeader("content-type", "application/json");
                return void response.end(JSON.stringify(this.releases));
            }
            const file = this.files.get(path.replace(/^\/dl\//, ""));
            if (file) return void response.end(file);
            response.statusCode = 404;
            response.end("{}");
        });
        await new Promise<void>((done) => this.server!.listen(0, "127.0.0.1", done));
        this.port = (this.server!.address() as { port: number }).port;
    }

    stop(): Promise<void> {
        return new Promise((done) => (this.server ? this.server.close(() => done()) : done()));
    }
}

const POWERSHELL = process.platform === "win32"
    ? ["powershell.exe", "pwsh"].find(
        (one) => spawnSync(one, ["-NoProfile", "-Command", "exit 0"], { windowsHide: true, stdio: "ignore", timeout: 20_000 }).status === 0
    )
    : undefined;

/** The exit code a run gives when a stand-in did not take, before anything ran. */
const STUB_MISSING = 97;

const STUBBED = [
    "Get-ScheduledTask",
    "New-ScheduledTaskAction",
    "New-ScheduledTaskTrigger",
    "New-ScheduledTaskSettingsSet",
    "New-ScheduledTaskPrincipal",
    "Register-ScheduledTask",
    "Unregister-ScheduledTask",
    "Get-Process",
    "Stop-Process",
    "Start-Process"
];

/**
 * Stops a run before the script starts unless every command above is a
 * stand-in (the real scheduled-task ones are functions too, but belong to a
 * module) and AppData points into the test's own folder.
 */
const GUARD = `
foreach ($name in @(${STUBBED.map((name) => `"${name}"`).join(", ")})) {
    $found = Get-Command $name
    if ($found.CommandType -ne "Function" -or $found.Module) { [Console]::Error.WriteLine("stand-in did not take: $name"); exit ${STUB_MISSING} }
}
foreach ($folder in @($env:APPDATA, $env:LOCALAPPDATA)) {
    if (-not $env:POLARIS_TEST_ROOT -or -not "$folder".StartsWith($env:POLARIS_TEST_ROOT)) { [Console]::Error.WriteLine("AppData is not the test's: $folder"); exit ${STUB_MISSING} }
}
`;

/** Stand-ins: a held task reads the one the test describes, and every change is logged. */
const STUBS = `
function Get-ScheduledTask {
    if (-not $env:POLARIS_TEST_OLD_TASK) { return $null }
    return [pscustomobject]@{
        Triggers = @([pscustomobject]@{ Repetition = [pscustomobject]@{ Interval = "PT6H" } })
        Actions = @([pscustomobject]@{ Execute = "powershell.exe"; Arguments = ('-File "{0}" scheduled' -f $env:POLARIS_TEST_OLD_TASK) })
    }
}
function New-ScheduledTaskAction { "action" }
function New-ScheduledTaskTrigger { param([switch]$Once, $At, $RepetitionInterval) Add-Content -Path $env:POLARIS_TEST_TASKS -Value ("every " + [System.Xml.XmlConvert]::ToString($RepetitionInterval)) }
function New-ScheduledTaskSettingsSet { "settings" }
function New-ScheduledTaskPrincipal { "principal" }
function Register-ScheduledTask { Add-Content -Path $env:POLARIS_TEST_TASKS -Value "registered" }
function Unregister-ScheduledTask { Add-Content -Path $env:POLARIS_TEST_TASKS -Value "unregistered" }
function Get-Process { $null }
function Stop-Process { Add-Content -Path $env:POLARIS_TEST_TASKS -Value "stopped a process" }
function Start-Process { Add-Content -Path $env:POLARIS_TEST_TASKS -Value "started a process" }
${GUARD}`;

describe.skipIf(!POWERSHELL)("the Windows updater's scheduled run", () => {
    const feed = new Feed();
    let root = "";
    let plugins = "";
    let updater = "";
    let tasks = "";
    let runner = "";

    beforeAll(async () => {
        await feed.start();
        root = mkdtempSync(join(tmpdir(), "polaris-sd-"));
        plugins = join(root, "plugins");
        updater = join(root, "local", "Polaris", "streamdeck", "update.ps1");
        tasks = join(root, "tasks.log");
        runner = join(root, "run.ps1");
        writeFileSync(runner, `${STUBS}\n& '${SCRIPT.replace(/'/g, "''")}' scheduled 'test/polaris' $args[0] $args[1]\n`);
    });
    afterAll(async () => {
        await feed.stop();
        rmSync(root, { recursive: true, force: true });
    });

    const run = (extra: Record<string, string> = {}) => {
        writeFileSync(tasks, "");
        return promisify(execFile)(
            POWERSHELL!,
            ["-NoProfile", "-NonInteractive", "-ExecutionPolicy", "Bypass", "-File", runner, `http://127.0.0.1:${feed.port}`, plugins],
            {
                encoding: "utf8",
                timeout: 60_000,
                env: {
                    ...process.env,
                    POLARIS_TEST_ROOT: root,
                    APPDATA: join(root, "roaming"),
                    LOCALAPPDATA: join(root, "local"),
                    POLARIS_TEST_TASKS: tasks,
                    ...extra
                }
            }
        ).catch((error: { code?: unknown; stderr?: unknown }) => {
            if (error.code === STUB_MISSING) throw new Error(`the stand-ins did not take: ${String(error.stderr)}`);
        });
    };

    it("installs the newest plugin and leaves the task alone when there is none", async () => {
        feed.publish("0.1.300");
        await run();
        const manifest = JSON.parse(readFileSync(join(plugins, `${UUID}.sdPlugin`, "manifest.json"), "utf8"));
        expect(manifest.Version).toBe("0.1.300.0");
        expect(existsSync(updater)).toBe(true);
        expect(readFileSync(tasks, "utf8")).toBe("");
    }, 90_000);

    it("moves a six-hour task that runs this updater onto the hourly schedule", async () => {
        await run({ POLARIS_TEST_OLD_TASK: updater });
        const log = readFileSync(tasks, "utf8");
        expect(log).toContain("every PT1H");
        expect(log).toContain("registered");
    }, 90_000);

    it("leaves a task that runs some other updater alone", async () => {
        await run({ POLARIS_TEST_OLD_TASK: join(root, "elsewhere", "update.ps1") });
        expect(readFileSync(tasks, "utf8")).toBe("");
    }, 90_000);

    it("refuses to start when a stand-in did not take", async () => {
        const probe = promisify(execFile)(POWERSHELL!, ["-NoProfile", "-NonInteractive", "-Command", `${GUARD}; "ran"`], {
            encoding: "utf8",
            timeout: 60_000,
            env: { ...process.env, POLARIS_TEST_ROOT: root, APPDATA: join(root, "roaming"), LOCALAPPDATA: join(root, "local") }
        });
        await expect(probe).rejects.toMatchObject({ code: STUB_MISSING });
    }, 90_000);
});
