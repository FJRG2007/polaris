/**
 * The installed copy looking after itself: `plr update` and `plr uninstall`.
 *
 * `update` fetches the newest CLI release from the project's GitHub repository
 * (the one the install line used), checks it against the digest GitHub
 * publishes for it, and swaps it in with a rename - so a truncated download
 * never replaces a working one. `--url` takes the CLI a particular Polaris
 * serves instead (`/cli/polaris.mjs`), for a Polaris that is older than the
 * newest CLI or a computer that cannot reach GitHub.
 *
 * `uninstall` signs every profile out (revoking each key on its server where it
 * can be reached), deletes the CLI's config and the launchers it installed, and
 * deletes its own folder. It only removes files that carry its own marker:
 * nothing of a Polaris server's is ever touched.
 */

import { send } from "../api.js";
import { line } from "../output.js";
import { createHash } from "node:crypto";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { loadConfig } from "../config.js";
import type { Context } from "../context.js";
import { CliError, usage } from "../errors.js";
import { normalizeUrl, type Flags } from "../args.js";
import { spawnRunner, type Runner } from "../secrets.js";
import { readFile, rename, rm, writeFile } from "node:fs/promises";
import { DEFAULT_REPO, installCommand, newestRelease, type CliRelease } from "../releases.js";
import { CLI_MARKER, INSTALL_MARKER_FILE, binDir, installDir, launcherNames } from "../paths.js";

/** Bigger than any bundle this will ever be, small enough to refuse a page of junk. */
const MAX_BUNDLE_BYTES = 20 * 1024 * 1024;

/** What the installer writes beside the bundle. */
interface InstallMarker {
    readonly marker: string;
    /** Where the bundle came from: the repository's page, or a Polaris address
     *  for a copy installed from (or updated with --url against) a server. */
    readonly origin: string;
    /** The GitHub repository it updates from; absent on a copy installed from a
     *  Polaris before the CLI was released on GitHub. */
    readonly repo?: string;
    readonly sha256?: string;
}

/** Where the running bundle is. */
export function bundlePath(): string {
    return fileURLToPath(import.meta.url);
}

/** The marker beside a bundle, or null when this copy was not installed by the
 *  Polaris installer (a checkout, a test run). */
export async function readMarker(bundle: string): Promise<InstallMarker | null> {
    try {
        const parsed = JSON.parse(
            await readFile(join(dirname(bundle), INSTALL_MARKER_FILE), "utf8")
        ) as Partial<InstallMarker>;
        if (parsed.marker !== CLI_MARKER || typeof parsed.origin !== "string") return null;
        return {
            marker: parsed.marker,
            origin: parsed.origin,
            repo: typeof parsed.repo === "string" ? parsed.repo : undefined,
            sha256: typeof parsed.sha256 === "string" ? parsed.sha256 : undefined
        };
    } catch {
        return null;
    }
}

export function sha256(bytes: Uint8Array): string {
    return createHash("sha256").update(bytes).digest("hex");
}

/** A downloaded bundle, refused unless it is a CLI and matches its digest. */
function checkedBundle(bytes: Uint8Array, expected: string | null): Uint8Array {
    if (bytes.byteLength === 0 || bytes.byteLength > MAX_BUNDLE_BYTES)
        throw new CliError("The download was not a CLI. Nothing was changed.");
    if (!expected || sha256(bytes) !== expected.trim().toLowerCase())
        throw new CliError(
            "The download did not match its checksum. Nothing was changed; try again."
        );
    if (!new TextDecoder().decode(bytes.slice(0, 32)).startsWith("#!/usr/bin/env node")) {
        throw new CliError("The download was not a CLI. Nothing was changed.");
    }
    return bytes;
}

/** The bundle a Polaris serves, verified against the digest it sends. */
export async function fetchBundle(context: Context, origin: string): Promise<Uint8Array> {
    const response = await send({ url: origin, token: null }, "GET", "/cli/polaris.mjs", {
        fetch: context.fetch,
        timeoutMs: 120_000
    });
    if (!response.ok) {
        throw new CliError(
            `${origin} did not hand out the CLI (HTTP ${response.status}). Its Polaris may predate the CLI; update it from Settings first.`
        );
    }
    return checkedBundle(
        new Uint8Array(await response.arrayBuffer()),
        response.headers.get("x-content-sha256")
    );
}

/** A release's bundle, verified against the digest GitHub published for it. */
export async function fetchRelease(context: Context, release: CliRelease): Promise<Uint8Array> {
    let response: Response;
    try {
        response = await context.fetch(release.url, { signal: AbortSignal.timeout(120_000) });
    } catch {
        throw new CliError(
            "Could not download the CLI from GitHub. Nothing was changed; try again."
        );
    }
    if (!response.ok) {
        throw new CliError(
            `GitHub did not hand out the CLI (HTTP ${response.status}). Nothing was changed; try again.`
        );
    }
    return checkedBundle(new Uint8Array(await response.arrayBuffer()), release.sha256);
}

export async function update(context: Context, flags: Flags): Promise<void> {
    const bundle = bundlePath();
    const marker = await readMarker(bundle);
    if (!marker) {
        throw new CliError(
            `This copy was not installed with the install line, so it cannot update itself. Install it with: ${installCommand(context.host.platform)}`
        );
    }
    const repo = marker.repo ?? DEFAULT_REPO;
    let bytes: Uint8Array;
    let origin: string;
    let named: string;
    if (flags.url) {
        origin = normalizeUrl(flags.url);
        bytes = await fetchBundle(context, origin);
        named = `the CLI ${origin} serves`;
    } else {
        const release = await newestRelease(context.fetch, repo);
        bytes = await fetchRelease(context, release);
        origin = `https://github.com/${repo}`;
        named = `CLI ${release.version}`;
    }

    const digest = sha256(bytes);
    const current = sha256(new Uint8Array(await readFile(bundle)));
    if (digest === current) {
        line(context.io, `Already up to date (${named}).`);
        return;
    }
    // Written beside the old one and renamed over it: the rename is atomic, so
    // an interrupted update leaves the old CLI rather than half of the new one.
    const next = `${bundle}.${process.pid}.new`;
    await writeFile(next, bytes, { mode: 0o755 });
    await rename(next, bundle);
    await writeFile(
        join(dirname(bundle), INSTALL_MARKER_FILE),
        `${JSON.stringify({ marker: CLI_MARKER, origin, repo, sha256: digest, installedAt: new Date().toISOString() }, null, 4)}
`
    );
    line(context.io, `Updated to ${named}.`);
}

/** Lines the installer added to a shell startup file, which carry the marker. */
export function withoutMarkedLines(text: string): string {
    return text
        .split("\n")
        .filter((entry) => !entry.includes(CLI_MARKER))
        .join("\n");
}

/** The Windows script that takes the install folder off the user's PATH. Fixed
 *  text; the folder arrives in the environment. */
const WINDOWS_UNPATH = `
$key = [Microsoft.Win32.Registry]::CurrentUser.OpenSubKey('Environment', $true)
if ($key) {
    $value = [string]$key.GetValue('Path', '', [Microsoft.Win32.RegistryValueOptions]::DoNotExpandEnvironmentNames)
    $parts = @($value -split ';')
    # Written back only when the folder is there to take out, and with every
    # other entry exactly as it was.
    if ($parts -contains $env:POLARIS_CLI_DIR) {
        $kind = $key.GetValueKind('Path')
        $kept = @($parts | Where-Object { $_ -ne $env:POLARIS_CLI_DIR })
        $key.SetValue('Path', ($kept -join ';'), $kind)
    }
    $key.Close()
}
`;

export async function uninstall(
    context: Context,
    flags: Flags,
    run: Runner = spawnRunner
): Promise<void> {
    const config = await loadConfig(context.configDir);
    const names = Object.keys(config.profiles);
    if (!flags.yes) {
        const answer = await context.prompt(
            `Remove the Polaris CLI from this computer${names.length ? ` and sign out ${names.length} profile(s)` : ""}? [y/N] `
        );
        if (answer === null)
            throw usage("Run plr uninstall --yes to remove it without being asked.");
        if (!/^y(es)?$/i.test(answer)) {
            line(context.io, "Nothing was removed.");
            return;
        }
    }

    // Each sign-in ended on its server, so no key is left working for a CLI
    // that no longer exists.
    for (const name of names) {
        const profile = config.profiles[name]!;
        const token = await context.secrets.read(name, profile.storage);
        if (token) {
            await send({ url: profile.url, token }, "DELETE", "/api/cli/session", {
                fetch: context.fetch,
                timeoutMs: 15_000
            }).catch(() =>
                line(
                    context.io,
                    `Could not reach ${profile.url} to revoke profile ${name}'s key; revoke it under API keys there.`
                )
            );
        }
        await context.secrets.forget(name);
    }
    await rm(context.configDir, { recursive: true, force: true });

    const host = context.host;
    for (const name of launcherNames(host)) {
        const launcher = join(binDir(host), name);
        const text = await readFile(launcher, "utf8").catch(() => null);
        if (text?.includes(CLI_MARKER)) await rm(launcher, { force: true });
    }
    if (host.platform !== "win32") {
        for (const rc of [".profile", ".bashrc", ".zshrc"]) {
            const file = join(host.home, rc);
            const text = await readFile(file, "utf8").catch(() => null);
            if (text?.includes(CLI_MARKER)) await writeFile(file, withoutMarkedLines(text));
        }
    } else {
        await run(
            "powershell.exe",
            [
                "-NoProfile",
                "-NonInteractive",
                "-EncodedCommand",
                Buffer.from(WINDOWS_UNPATH, "utf16le").toString("base64")
            ],
            {
                env: { POLARIS_CLI_DIR: installDir(host) }
            }
        );
    }

    // The folder goes only if it is the one the installer made: it carries the
    // marker. A copy run from anywhere else is left where it is.
    const folder = installDir(host);
    if (await readMarker(join(folder, "polaris.mjs")))
        await rm(folder, { recursive: true, force: true });
    line(context.io, "The Polaris CLI was removed from this computer.");
}
