/**
 * The command-line client as this Polaris still hands it out.
 *
 * The CLI is installed from the project's GitHub releases now (the downloads
 * screen shows that line), but these three files stay served without a session
 * at `/cli/<file>` so that what was published before keeps working: install
 * lines pasted from older docs (`/cli/install.sh`, `/cli/install.ps1`, which
 * now fetch the release from GitHub and name this Polaris as the one to sign in
 * to), and `plr update --url`, which takes the bundle built into this image
 * (`/cli/polaris.mjs`) - the way to get a CLI that matches an older Polaris, or
 * one for a computer that cannot reach GitHub.
 *
 * Server-only.
 */

import { existsSync } from "node:fs";
import { dirname, join } from "node:path";
import { createRequire } from "node:module";

/** The files, by the name they are asked for. */
export const CLI_FILES = {
    "polaris.mjs": {
        source: ["dist", "polaris.mjs"],
        type: "application/javascript; charset=utf-8",
        template: false
    },
    "install.sh": {
        source: ["scripts", "install.sh"],
        type: "text/x-shellscript; charset=utf-8",
        template: true
    },
    "install.ps1": {
        source: ["scripts", "install.ps1"],
        type: "text/plain; charset=utf-8",
        template: true
    }
} as const;

export type CliFile = keyof typeof CLI_FILES;

export function isCliFile(name: string): name is CliFile {
    return Object.hasOwn(CLI_FILES, name);
}

/** What the install scripts carry in place of the address. */
export const URL_PLACEHOLDER = "__POLARIS_URL__";

/**
 * Where the CLI package is, in a way that survives being packaged: the resolver
 * when it answers, then where Next's standalone layout puts a workspace package
 * (the same fallback the agent runtime's bundle route needs, for the same
 * reason - the tracer copies the files but lays down no `node_modules` entry).
 */
export function cliPackageDir(): string | null {
    const candidates: string[] = [];
    try {
        const require = createRequire(import.meta.url);
        candidates.push(dirname(require.resolve("@polaris/cli/package.json")));
    } catch {
        // Packaged, not installed. The paths below are the answer.
    }
    candidates.push(join(process.cwd(), "packages", "cli"));
    candidates.push(join(process.cwd(), "..", "..", "packages", "cli"));
    return candidates.find((dir) => existsSync(join(dir, "scripts", "install.sh"))) ?? null;
}

/** A host as it may appear in an address: a name or IPv4 address, or a
 *  bracketed IPv6 one, with an optional port. Nothing a shell or PowerShell
 *  would read as anything but text. */
const HOST =
    /^(?:[A-Za-z0-9](?:[A-Za-z0-9.-]{0,251}[A-Za-z0-9])?|\[[0-9A-Fa-f:.]{2,45}\])(?::\d{1,5})?$/;

/**
 * The address a request reached this Polaris on, as an origin to write into a
 * script - or null when the headers do not describe one cleanly.
 *
 * The person running the install line typed this address a moment ago, so it is
 * the one that works from their machine; the forwarded headers carry it past
 * the proxy. Whatever comes back is checked to a strict shape before it is
 * written into a script, because the script is run by a shell.
 */
export function requestOrigin(headers: Headers): string | null {
    const proto =
        (headers.get("x-forwarded-proto") ?? "").split(",")[0]?.trim().toLowerCase() || "http";
    const host =
        (headers.get("x-forwarded-host") ?? headers.get("host") ?? "").split(",")[0]?.trim() ?? "";
    if (proto !== "http" && proto !== "https") return null;
    if (!HOST.test(host)) return null;
    // 0.0.0.0 is the address the server binds, never one anybody can reach.
    if (host.startsWith("0.0.0.0")) return null;
    try {
        const origin = new URL(`${proto}://${host}`).origin;
        return origin === "null" ? null : origin;
    } catch {
        return null;
    }
}

/** A script with this Polaris's address written in. The origin has passed
 *  `requestOrigin`'s check (or is the configured app address). */
export function fillScript(script: string, origin: string): string {
    return script.split(URL_PLACEHOLDER).join(origin.replace(/\/+$/, ""));
}
