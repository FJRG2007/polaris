/**
 * The install scripts' updater, run for real against a stand-in release feed.
 *
 * What is pinned is what the extension relies on (BUG-0022): every run writes
 * what it found into the folder (`check` in polaris-updater.json) - installed,
 * current, or failed and why - and a run never replaces the folder with a
 * download that does not match its published digest. The Windows script also
 * brings a task an older release registered (every six hours) up to this
 * release's hourly schedule.
 *
 * The scheduler is never touched: the PowerShell run is given stand-in
 * scheduled-task commands (a function shadows a cmdlet of the same name), and
 * the shell run only rewrites a job that names its own updater, which a
 * temporary folder never is. Each script runs only where its shell exists.
 */

import { tmpdir } from "node:os";
import { join } from "node:path";
import { createHash } from "node:crypto";
import { execFile, spawnSync } from "node:child_process";
import { promisify } from "node:util";
import { createServer, type Server } from "node:http";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { mkdtempSync, readFileSync, rmSync, writeFileSync, existsSync } from "node:fs";

const SCRIPTS = join(__dirname, "..", "scripts");

/** A zip with its entries stored, which every unzip reads. */
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

const sha = (data: Buffer | string) => `sha256:${createHash("sha256").update(data).digest("hex")}`;

/** The stand-in for GitHub: the releases it lists, and the files it serves. */
class Feed {
    server: Server | null = null;
    port = 0;
    files = new Map<string, Buffer>();
    releases: object[] = [];

    publish(version: string, options: { digest?: string; script: string; scriptName: string }): void {
        const tag = `extension-v${version}`;
        const manifest = JSON.stringify({
            manifest_version: 3,
            version,
            background: { service_worker: "background.js" }
        });
        const pack = zip({ "manifest.json": manifest, "background.js": "// stand-in" });
        this.files.set(`${tag}/polaris-extension-chrome.zip`, pack);
        const script = readFileSync(join(SCRIPTS, options.script));
        this.files.set(`${tag}/${options.scriptName}`, script);
        const url = (name: string) => `http://127.0.0.1:${this.port}/dl/${tag}/${name}`;
        // Newest first, as GitHub lists them, with a dashboard release on top.
        this.releases.unshift({
            tag_name: tag,
            draft: false,
            prerelease: false,
            assets: [
                {
                    name: "polaris-extension-chrome.zip",
                    digest: options.digest ?? sha(pack),
                    browser_download_url: url("polaris-extension-chrome.zip")
                },
                { name: options.scriptName, digest: sha(script), browser_download_url: url(options.scriptName) }
            ]
        });
    }

    async start(): Promise<void> {
        this.server = createServer((request, response) => {
            const path = (request.url ?? "").split("?")[0]!;
            const listed = [{ tag_name: "v9.9.9", draft: false, prerelease: false, assets: [] }, ...this.releases];
            if (path === "/repos/test/polaris/releases") {
                response.setHeader("content-type", "application/json");
                return void response.end(JSON.stringify(listed, null, 2));
            }
            const tag = /^\/repos\/test\/polaris\/releases\/tags\/(.+)$/.exec(path)?.[1];
            const release = this.releases.find((one) => (one as { tag_name: string }).tag_name === tag);
            if (release) {
                response.setHeader("content-type", "application/json");
                return void response.end(JSON.stringify(release, null, 2));
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

    get api(): string {
        return `http://127.0.0.1:${this.port}`;
    }
}

function readNote(dir: string): Record<string, unknown> & { check?: Record<string, unknown> } {
    return JSON.parse(readFileSync(join(dir, "polaris-updater.json"), "utf8").replace(/^﻿/, ""));
}

function installed(dir: string): string {
    return JSON.parse(readFileSync(join(dir, "manifest.json"), "utf8")).version;
}

function has(command: string, probe: string[]): boolean {
    return spawnSync(command, probe, { windowsHide: true, stdio: "ignore", timeout: 20_000 }).status === 0;
}

const POWERSHELL = ["powershell.exe", "pwsh"].find((one) => has(one, ["-NoProfile", "-Command", "exit 0"]));
const SH = process.platform !== "win32" || has("sh", ["-c", "command -v curl && command -v unzip"]);

/** Stand-ins for the scheduled-task commands, so no run reaches the real scheduler. */
const TASK_STUBS = `
function Get-ScheduledTask {
    if ($env:POLARIS_TEST_OLD_TASK) {
        return [pscustomobject]@{
            Triggers = @([pscustomobject]@{ Repetition = [pscustomobject]@{ Interval = "PT6H" }; CimClass = [pscustomobject]@{ CimClassName = "MSFT_TaskTimeTrigger" } })
            Actions = @([pscustomobject]@{ Execute = "old"; Arguments = "old" })
        }
    }
    return $null
}
function New-ScheduledTaskAction { "action" }
function New-ScheduledTaskTrigger { param([switch]$Once, $At, $RepetitionInterval) Add-Content -Path $env:POLARIS_TEST_TASKS -Value ("every " + [System.Xml.XmlConvert]::ToString($RepetitionInterval)) }
function New-ScheduledTaskSettingsSet { "settings" }
function New-ScheduledTaskPrincipal { "principal" }
function Register-ScheduledTask { Add-Content -Path $env:POLARIS_TEST_TASKS -Value "registered" }
function Unregister-ScheduledTask { Add-Content -Path $env:POLARIS_TEST_TASKS -Value "unregistered" }
`;

describe.skipIf(!POWERSHELL)("the Windows updater", () => {
    const feed = new Feed();
    let root = "";
    let dir = "";
    let runner = "";
    let tasks = "";

    beforeAll(async () => {
        await feed.start();
        root = mkdtempSync(join(tmpdir(), "polaris-ps1-"));
        dir = join(root, "extension", "chrome");
        tasks = join(root, "tasks.log");
        runner = join(root, "run.ps1");
        writeFileSync(
            runner,
            `${TASK_STUBS}\n& '${join(SCRIPTS, "install.ps1").replace(/'/g, "''")}' scheduled $args[0] 'test/polaris' $args[1]\n`
        );
    });
    afterAll(async () => {
        await feed.stop();
        rmSync(root, { recursive: true, force: true });
    });

    const run = (extra: Record<string, string> = {}, api = feed.api) =>
        promisify(execFile)(
            POWERSHELL!,
            ["-NoProfile", "-NonInteractive", "-ExecutionPolicy", "Bypass", "-File", runner, dir, api],
            { encoding: "utf8", timeout: 60_000, env: { ...process.env, POLARIS_TEST_TASKS: tasks, ...extra } }
        ).catch(() => undefined);

    it("installs the newest extension release and says so in the folder", async () => {
        feed.publish("0.1.300", { script: "install.ps1", scriptName: "install.ps1" });
        await run();
        expect(installed(dir)).toBe("0.1.300");
        const note = readNote(dir);
        expect(note.updater).toBe("windows-task");
        expect(note.check).toMatchObject({ outcome: "installed", reason: null, everyMinutes: 60 });
        expect(Number.isFinite(Date.parse(String(note.check?.at)))).toBe(true);
        expect(existsSync(join(root, "extension", "update.ps1"))).toBe(true);
    }, 90_000);

    it("records a run that found nothing new as current", async () => {
        await run();
        expect(readNote(dir).check).toMatchObject({ outcome: "current", reason: null });
    }, 90_000);

    it("keeps the folder and records why when a download does not match its digest", async () => {
        feed.publish("0.1.301", { digest: sha("something else"), script: "install.ps1", scriptName: "install.ps1" });
        await run();
        expect(installed(dir)).toBe("0.1.300");
        expect(readNote(dir).check).toMatchObject({ outcome: "failed", reason: "digest", detail: "extension-v0.1.301" });
    }, 90_000);

    it("records GitHub out of reach", async () => {
        await run({}, "http://127.0.0.1:9");
        expect(readNote(dir).check).toMatchObject({ outcome: "failed", reason: "unreachable" });
    }, 90_000);

    it("moves a task an older release registered onto the hourly schedule", async () => {
        writeFileSync(tasks, "");
        feed.publish("0.1.302", { script: "install.ps1", scriptName: "install.ps1" });
        await run({ POLARIS_TEST_OLD_TASK: "1" });
        const log = readFileSync(tasks, "utf8");
        expect(log).toContain("every PT1H");
        expect(log).toContain("registered");
    }, 90_000);
});

describe.skipIf(!SH)("the macOS and Linux updater", () => {
    const feed = new Feed();
    let root = "";
    let dir = "";

    beforeAll(async () => {
        await feed.start();
        root = mkdtempSync(join(tmpdir(), "polaris-sh-"));
        dir = join(root, "extension", "chrome").replace(/\\/g, "/");
    });
    afterAll(async () => {
        await feed.stop();
        rmSync(root, { recursive: true, force: true });
    });

    const run = (api = feed.api) =>
        promisify(execFile)("sh", [join(SCRIPTS, "install.sh").replace(/\\/g, "/"), "scheduled"], {
            encoding: "utf8",
            timeout: 60_000,
            env: {
                ...process.env,
                HOME: root,
                XDG_CONFIG_HOME: join(root, "config"),
                POLARIS_EXTENSION_DIR: dir,
                POLARIS_REPO: "test/polaris",
                POLARIS_GITHUB_API: api
            }
        }).catch(() => undefined);

    it("installs the newest extension release and says so in the folder", async () => {
        feed.publish("0.1.300", { script: "install.sh", scriptName: "install.sh" });
        await run();
        expect(installed(dir)).toBe("0.1.300");
        expect(readNote(dir).check).toMatchObject({ outcome: "installed", reason: null, everyMinutes: 60 });
    }, 90_000);

    it("records a run that found nothing new as current", async () => {
        await run();
        expect(readNote(dir).check).toMatchObject({ outcome: "current", reason: null });
    }, 90_000);

    it("keeps the folder and records why when a download does not match its digest", async () => {
        feed.publish("0.1.301", { digest: sha("something else"), script: "install.sh", scriptName: "install.sh" });
        await run();
        expect(installed(dir)).toBe("0.1.300");
        const note = readNote(dir);
        expect(note.check).toMatchObject({ outcome: "failed", reason: "digest", detail: "extension-v0.1.301" });
        expect(note.tag).toBe("extension-v0.1.300");
    }, 90_000);

    it("records GitHub out of reach", async () => {
        await run("http://127.0.0.1:9");
        expect(readNote(dir).check).toMatchObject({ outcome: "failed", reason: "unreachable" });
    }, 90_000);
});
