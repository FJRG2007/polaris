/**
 * The Windows install script, run for real against a stand-in for GitHub's API:
 * it finds the newest extension release a short page at a time, installs it only
 * when it matches its published digest, and unpacks it without Expand-Archive,
 * whose progress bar per file made the one-press install take seconds longer
 * than its download. The scheduled task is stubbed, so nothing is registered on
 * the machine that runs the test.
 */

import { join } from "node:path";
import { tmpdir } from "node:os";
import { promisify } from "node:util";
import { createHash } from "node:crypto";
import { execFile } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import { createServer, type Server } from "node:http";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";

const run = promisify(execFile);
const SCRIPT = join(__dirname, "..", "scripts", "install.ps1");
const VERSION = "9.9.9";
const PAGE = 25;

/**
 * Ahead of the task's own commands: nothing reaches the real scheduler. The
 * module is loaded first because its commands are functions, and loading it
 * later (the script's first New-ScheduledTask* does) would replace the stubs.
 */
const STUBS = [
    "Import-Module ScheduledTasks",
    "function global:Register-ScheduledTask { [Console]::Out.WriteLine('polaris: [stub] registered') }",
    "function global:Unregister-ScheduledTask { }",
    "if ((Get-Command Register-ScheduledTask).Definition -notmatch 'stub') { exit 3 }"
].join("; ");

const sha256 = (bytes: Uint8Array) => createHash("sha256").update(bytes).digest("hex");

let root = "";
let server: Server;
let api = "";
let zip: Uint8Array = new Uint8Array();
let zipDigest = "";
let requested: string[] = [];

const dashboardRelease = (index: number) => ({ tag_name: `dashboard-v0.0.${index}`, draft: false, prerelease: false, assets: [] });

function extensionRelease() {
    const script = readFileSync(SCRIPT);
    return {
        tag_name: `extension-v${VERSION}`,
        draft: false,
        prerelease: false,
        assets: [
            { name: `polaris-${VERSION}-chrome.zip`, digest: `sha256:${zipDigest}`, browser_download_url: `${api}/download/chrome.zip` },
            { name: "install.ps1", digest: `sha256:${sha256(script)}`, browser_download_url: `${api}/download/install.ps1` }
        ]
    };
}

beforeAll(async () => {
    if (process.platform !== "win32") return;
    root = await mkdtemp(join(tmpdir(), "polaris-ext-install-"));
    // A package with a few hundred files, like the real one.
    const source = join(root, "package");
    await mkdir(join(source, "assets"), { recursive: true });
    await writeFile(join(source, "manifest.json"), JSON.stringify({ manifest_version: 3, version: VERSION, background: { service_worker: "background.js" } }));
    await writeFile(join(source, "background.js"), "// fixture\n");
    for (let index = 0; index < 300; index++) await writeFile(join(source, "assets", `chunk-${index}.js`), `// fixture ${index}\n`);
    const archive = join(root, "chrome.zip");
    await run("powershell.exe", [
        "-NoLogo",
        "-NoProfile",
        "-NonInteractive",
        "-Command",
        "Add-Type -AssemblyName System.IO.Compression.FileSystem; [IO.Compression.ZipFile]::CreateFromDirectory($env:FIXTURE_SOURCE, $env:FIXTURE_ZIP)"
    ], { env: { ...process.env, FIXTURE_SOURCE: source, FIXTURE_ZIP: archive }, windowsHide: true });
    zip = new Uint8Array(await readFile(archive));
    zipDigest = sha256(zip);

    server = createServer((request, response) => {
        const url = request.url ?? "";
        requested.push(url);
        const listed = /^\/repos\/example\/polaris\/releases\?per_page=(\d+)&page=(\d+)$/.exec(url);
        if (listed) {
            // The extension sits on the second page, behind a full first one.
            const page = Number(listed[2]);
            const body = page === 1 ? Array.from({ length: PAGE }, (_, index) => dashboardRelease(index)) : page === 2 ? [extensionRelease()] : [];
            response.writeHead(200, { "content-type": "application/json" });
            response.end(JSON.stringify(body, null, 2));
            return;
        }
        if (url === "/download/chrome.zip") {
            response.writeHead(200);
            response.end(zip);
            return;
        }
        if (url === "/download/install.ps1") {
            response.writeHead(200);
            response.end(readFileSync(SCRIPT));
            return;
        }
        response.writeHead(404);
        response.end();
    });
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
    const address = server.address();
    api = `http://127.0.0.1:${typeof address === "object" && address ? address.port : 0}`;
});

afterAll(async () => {
    if (process.platform !== "win32") return;
    await new Promise<void>((resolve) => server.close(() => resolve()));
    await rm(root, { recursive: true, force: true });
});

/** The script the way the one-line install runs it: piped into `iex`. Resolves
 *  when PowerShell exits, whatever it printed. */
async function install(dir: string) {
    const env = { ...process.env, POLARIS_REPO: "example/polaris", POLARIS_GITHUB_API: api, POLARIS_EXTENSION_DIR: dir, POLARIS_TEST_SCRIPT: SCRIPT };
    delete env.POLARIS_EXTENSION_TAG;
    const command = `${STUBS}; iex ([IO.File]::ReadAllText($env:POLARIS_TEST_SCRIPT))`;
    const { stdout } = await run("powershell.exe", ["-NoLogo", "-NoProfile", "-NonInteractive", "-Command", command], { env, windowsHide: true });
    return stdout;
}

describe.skipIf(process.platform !== "win32")("install.ps1", { timeout: 120_000 }, () => {
    it("installs the newest extension release, a short page at a time", async () => {
        requested = [];
        const dir = join(root, "installed", "chrome");
        const output = await install(dir);
        expect(output).toContain(`installed ${VERSION}`);
        expect(output).toContain("First time: open chrome://extensions");
        expect(output).toContain("[stub] registered");
        const manifest = JSON.parse(readFileSync(join(dir, "manifest.json"), "utf8")) as { version: string };
        expect(manifest.version).toBe(VERSION);
        expect(existsSync(join(dir, "assets", "chunk-299.js"))).toBe(true);
        expect(existsSync(join(root, "installed", "update.ps1"))).toBe(true);
        const lists = requested.filter((url) => url.includes("/releases?"));
        expect(lists).toEqual([
            `/repos/example/polaris/releases?per_page=${PAGE}&page=1`,
            `/repos/example/polaris/releases?per_page=${PAGE}&page=2`
        ]);
    });

    it("leaves an install that is current as it is", async () => {
        const dir = join(root, "installed", "chrome");
        const output = await install(dir);
        expect(output).toContain(`${VERSION} is already installed`);
        expect(requested.filter((url) => url === "/download/chrome.zip")).toHaveLength(1);
    });

    it("installs nothing that does not match its published digest", async () => {
        const kept = zipDigest;
        zipDigest = "0".repeat(64);
        try {
            const dir = join(root, "refused", "chrome");
            const output = await install(dir);
            expect(output).toContain("does not match its published digest");
            expect(existsSync(dir)).toBe(false);
        } finally {
            zipDigest = kept;
        }
    });
});

describe("install.ps1 as written", () => {
    const text = readFileSync(SCRIPT, "utf8");

    it("draws no progress bars and unpacks without Expand-Archive", () => {
        expect(text).toContain('$ProgressPreference = "SilentlyContinue"');
        expect(text).not.toMatch(/^\s*Expand-Archive\b/m);
    });

    it("waits on nothing but its own steps", () => {
        expect(text).not.toMatch(/Start-Sleep/);
    });
});
