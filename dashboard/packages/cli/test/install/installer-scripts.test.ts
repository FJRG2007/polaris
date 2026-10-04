/**
 * The install scripts themselves, run for real against a stand-in for GitHub's
 * API: they install the newest `cli-v*` release only when it matches the digest
 * GitHub published, and they refuse - before downloading anything - on a
 * computer that runs a Polaris server.
 *
 * The shell script runs wherever `sh` does (CI, macOS, Linux, Git Bash, with
 * `uname` answering Linux so Git Bash is not turned away as Windows). The
 * PowerShell one runs on Windows, and only up to the point where it would
 * write the user's PATH: the refusals and the failed lookups.
 */

import { join } from "node:path";
import { promisify } from "node:util";
import { tempDir } from "../helpers/context.js";
import { existsSync, readFileSync } from "node:fs";
import { createServer, type Server } from "node:http";
import { sha256 } from "../../src/commands/install.js";
import { execFile, spawnSync } from "node:child_process";
import { chmod, mkdir, writeFile } from "node:fs/promises";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

const run = promisify(execFile);
const SCRIPTS = join(__dirname, "..", "..", "scripts");
const BUNDLE = new TextEncoder().encode("#!/usr/bin/env node\nconsole.log('plr fixture');\n");

/** What the stand-in lists: the newest CLI release behind a dashboard one. */
let releases: unknown[] = [];
let server: Server;
let api = "";

function cliRelease(digest: string) {
    return {
        tag_name: "cli-v0.6.0",
        draft: false,
        prerelease: false,
        assets: [
            {
                name: "polaris.mjs",
                digest: `sha256:${digest}`,
                browser_download_url: `${api}/download/cli-v0.6.0/polaris.mjs`
            }
        ]
    };
}

const dashboardRelease = () => ({
    tag_name: "dashboard-v0.5.0",
    draft: false,
    prerelease: false,
    assets: [
        {
            name: "polaris.mjs",
            digest: `sha256:${"0".repeat(64)}`,
            browser_download_url: `${api}/download/dashboard/polaris.mjs`
        }
    ]
});

beforeAll(async () => {
    server = createServer((request, response) => {
        if (request.url?.startsWith("/repos/example/polaris/releases")) {
            // Pretty-printed, one field per line, the way api.github.com answers.
            response.writeHead(200, { "content-type": "application/json" });
            response.end(JSON.stringify(releases, null, 2));
            return;
        }
        if (request.url === "/download/cli-v0.6.0/polaris.mjs") {
            response.writeHead(200);
            response.end(BUNDLE);
            return;
        }
        response.writeHead(404);
        response.end();
    });
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
    const address = server.address();
    api = `http://127.0.0.1:${typeof address === "object" && address ? address.port : 0}`;
});

afterAll(() => new Promise<void>((resolve) => server.close(() => resolve())));

/** A path both a POSIX shell and Windows' own Node read the same way. */
const portable = (path: string) => path.replace(/\\/g, "/");

const hasSh = spawnSync("sh", ["-c", "exit 0"]).status === 0;

/** A fresh home, a fake `uname` that answers Linux, and the environment the
 *  script reads, with nothing of this machine's own Polaris in it. */
async function shellHome(extra: Record<string, string> = {}) {
    const home = portable(await tempDir("plr-installer-"));
    const fakeBin = `${home}/fake-bin`;
    await mkdir(fakeBin, { recursive: true });
    await writeFile(`${fakeBin}/uname`, "#!/bin/sh\necho Linux\n");
    await chmod(`${fakeBin}/uname`, 0o755);
    const env: NodeJS.ProcessEnv = {
        ...process.env,
        PATH: `${fakeBin}${process.platform === "win32" ? ";" : ":"}${process.env.PATH ?? ""}`,
        HOME: home,
        SHELL: "/bin/sh",
        POLARIS_REPO: "example/polaris",
        POLARIS_GITHUB_API: api,
        POLARIS_INSTALL_DIR: `${home}/no-server-here`,
        POLARIS_SECRETS_FILE: `${home}/no-secrets-here`
    };
    delete env.XDG_DATA_HOME;
    delete env.POLARIS_URL;
    return { home, env: { ...env, ...extra } };
}

async function runShell(env: NodeJS.ProcessEnv) {
    try {
        const { stdout, stderr } = await run("sh", [`${portable(SCRIPTS)}/install.sh`], { env });
        return { code: 0, stdout, stderr };
    } catch (caught) {
        const failed = caught as { code: number; stdout: string; stderr: string };
        return { code: failed.code, stdout: failed.stdout, stderr: failed.stderr };
    }
}

describe.skipIf(!hasSh)("install.sh", { timeout: 180_000 }, () => {
    it("installs the newest CLI release, checked against its digest", async () => {
        releases = [dashboardRelease(), cliRelease(sha256(BUNDLE))];
        const { home, env } = await shellHome();
        const result = await runShell(env);
        expect(result.stderr).toBe("");
        expect(result.code).toBe(0);
        const installed = `${home}/.local/share/polaris-cli`;
        expect(new Uint8Array(readFileSync(`${installed}/polaris.mjs`))).toEqual(BUNDLE);
        const marker = JSON.parse(readFileSync(`${installed}/polaris-cli.json`, "utf8")) as Record<
            string,
            string
        >;
        expect(marker).toMatchObject({
            marker: "polaris-developer-cli",
            origin: "https://github.com/example/polaris",
            repo: "example/polaris",
            sha256: sha256(BUNDLE)
        });
        expect(readFileSync(`${home}/.local/bin/plr`, "utf8")).toContain("polaris-developer-cli");
        // With no Polaris named, the next step says to name one.
        expect(result.stdout).toContain("next: plr login --url https://your-polaris");
    });

    it("names the Polaris that served it as the one to sign in to", async () => {
        releases = [cliRelease(sha256(BUNDLE))];
        const { env } = await shellHome({ POLARIS_URL: "https://polaris.example.com" });
        const result = await runShell(env);
        expect(result.code).toBe(0);
        expect(result.stdout).toContain("next: plr login --url https://polaris.example.com");
    });

    it("installs nothing when the download does not match its digest", async () => {
        releases = [cliRelease("1".repeat(64))];
        const { home, env } = await shellHome();
        const result = await runShell(env);
        expect(result.code).toBe(1);
        expect(result.stderr).toContain("did not match its checksum");
        expect(existsSync(`${home}/.local/share/polaris-cli/polaris.mjs`)).toBe(false);
    });

    it("refuses on a computer with a Polaris server checkout, before downloading", async () => {
        releases = [cliRelease(sha256(BUNDLE))];
        const { home, env } = await shellHome();
        const checkout = `${home}/server`;
        await mkdir(`${checkout}/dashboard/docker`, { recursive: true });
        await writeFile(`${checkout}/dashboard/docker/docker-compose.yml`, "services: {}\n");
        const result = await runShell({ ...env, POLARIS_INSTALL_DIR: checkout });
        expect(result.code).toBe(1);
        expect(result.stderr).toContain(
            `this computer runs a Polaris server (a server checkout at ${checkout})`
        );
        expect(result.stdout).not.toContain("downloading");
        expect(existsSync(`${home}/.local/share/polaris-cli`)).toBe(false);
    });

    it("refuses on a computer with the server's secrets store", async () => {
        const { home, env } = await shellHome();
        const secrets = `${home}/secrets.env`;
        await writeFile(secrets, "fixture=1\n");
        const result = await runShell({ ...env, POLARIS_SECRETS_FILE: secrets });
        expect(result.code).toBe(1);
        expect(result.stderr).toContain("the server's secrets store");
    });
});

describe.skipIf(process.platform !== "win32")("install.ps1", () => {
    async function runPowerShell(extra: Record<string, string>) {
        const home = await tempDir("plr-installer-ps-");
        const env: NodeJS.ProcessEnv = {
            ...process.env,
            LOCALAPPDATA: join(home, "local"),
            ProgramData: join(home, "programdata"),
            POLARIS_INSTALL_DIR: join(home, "no-server-here"),
            POLARIS_REPO: "example/polaris",
            POLARIS_GITHUB_API: api
        };
        delete env.POLARIS_URL;
        Object.assign(env, extra);
        const { stdout } = await run(
            "powershell.exe",
            [
                "-NoLogo",
                "-NoProfile",
                "-NonInteractive",
                "-ExecutionPolicy",
                "Bypass",
                "-File",
                join(SCRIPTS, "install.ps1")
            ],
            { env }
        );
        return { home, stdout };
    }

    it("refuses on a computer with a Polaris server checkout, before downloading", async () => {
        const checkout = await tempDir("plr-server-");
        await mkdir(join(checkout, "dashboard", "docker"), { recursive: true });
        await writeFile(
            join(checkout, "dashboard", "docker", "docker-compose.yml"),
            "services: {}\n"
        );
        const { home, stdout } = await runPowerShell({ POLARIS_INSTALL_DIR: checkout });
        expect(stdout).toContain(
            `this computer runs a Polaris server (a server checkout at ${checkout})`
        );
        expect(stdout).not.toContain("downloading");
        expect(existsSync(join(home, "local", "Programs", "polaris-cli"))).toBe(false);
    }, 60_000);

    it("refuses on a computer with the server's own command", async () => {
        const local = await tempDir("plr-local-");
        await mkdir(join(local, "Polaris", "bin"), { recursive: true });
        await writeFile(
            join(local, "Polaris", "bin", "polaris.ps1"),
            "# polaris - manage a Polaris dashboard deployment\n"
        );
        const { stdout } = await runPowerShell({ LOCALAPPDATA: local });
        expect(stdout).toContain(
            "this computer runs a Polaris server (the server's own command at"
        );
    }, 60_000);

    it("installs nothing when the download does not match its digest", async () => {
        releases = [cliRelease("1".repeat(64))];
        const { home, stdout } = await runPowerShell({});
        expect(stdout).toContain("did not match its checksum");
        expect(existsSync(join(home, "local", "Programs", "polaris-cli", "polaris.mjs"))).toBe(
            false
        );
    }, 60_000);

    it("says so when there is no CLI release to install", async () => {
        releases = [dashboardRelease()];
        const { stdout } = await runPowerShell({});
        expect(stdout).toContain("could not find a CLI release on github.com/example/polaris");
    }, 60_000);
});
