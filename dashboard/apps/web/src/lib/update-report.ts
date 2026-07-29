/**
 * Reporting a failed update.
 *
 * An update that dies mid-build leaves the operator with a wall of Docker output
 * and no idea which part of it matters, and leaves the project with a bug report
 * that omits the one detail that would have explained it - which builder, which
 * kernel, which edition. So the report is assembled here instead: the running
 * build, where the box lives, the domain if it has one, and the tail of the log.
 *
 * It opens a prefilled issue rather than posting anything. The operator sees
 * exactly what is about to be published and can edit or abandon it, which is the
 * only honest way to send a host's logs somewhere public - `redactSecrets` narrows
 * what lands there, but it cannot promise a build log holds nothing private.
 */

import { readFile } from "node:fs/promises";
import { arch, cpus, platform, release, totalmem } from "node:os";
import { getCapabilities, loadEnv, type Edition } from "@polaris/config";
import type { ServerEnvironment } from "@polaris/core";
import { getUpdateStatus } from "./update-service";
import { getLocalEnvironment } from "./network-service";
import { polarisZoneHost } from "./domain-zones";
import { getSetting } from "./setting-store";

const LOG_PATH = process.env.POLARIS_UPDATE_LOG ?? "/run/polaris/update.log";
/** How much of the log's tail to carry. The failure is always at the end, and the
 *  whole thing would not survive a URL anyway. */
const LOG_CHARS = 4000;
/** Ceiling for the whole link. Browsers differ on where they cut a URL off, and a
 *  silently truncated one opens a half-written issue. */
const MAX_URL = 7500;

export interface UpdateReport {
    /** Short SHA of the build that was running, and the one it was moving to. */
    readonly build: string | null;
    readonly target: string | null;
    readonly edition: Edition;
    /** Where the box lives - the same taxonomy the domain advice is keyed on. */
    readonly environment: ServerEnvironment;
    /** The configured domain, when there is one. */
    readonly domain: string | null;
    readonly kernel: string;
    readonly arch: string;
    readonly node: string;
    readonly cpus: number;
    readonly memoryGb: number;
    readonly exitCode: number | null;
    readonly log: string;
}

/**
 * Blank the things a build log is known to carry in the clear. Assignments named
 * like a credential, the userinfo in a URL, and bare addresses - the last because
 * a connection string prints the operator's own database user.
 *
 * Deliberately not a filter on anything that merely looks random: image digests
 * and layer ids are the most useful lines in a Docker log, and blanking those to
 * chase a hypothetical secret would leave a report nobody can act on.
 */
export function redactSecrets(text: string): string {
    return (
        text
            // Matched as a whole name and then tested, rather than as one pattern with
            // the interesting words buried between two open-ended runs: that shape
            // backtracks catastrophically on a long unbroken token, which a build log
            // produces routinely. The length bound keeps the worst case linear.
            .replace(/\b[A-Za-z0-9_]{1,64}\s*=\s*\S+/g, (match) => {
                const name = match.slice(0, match.indexOf("=")).trim();
                return /KEY|TOKEN|SECRET|PASSWORD|PASSWD|CREDENTIAL|AUTH/i.test(name) ? `${name}=[redacted]` : match;
            })
            .replace(/([a-z][a-z0-9+.-]{0,32}:\/\/)[^/\s:@]{1,256}:[^/\s@]{1,256}@/gi, "$1[redacted]@")
            .replace(/\b[\w.+-]{1,64}@[\w-]{1,64}\.[\w.-]{1,64}\b/g, "[redacted]")
    );
}

/**
 * Keep the end of the log: a build fails at the point it stops. The first line of
 * what is kept is dropped, because slicing by character lands mid-line - and half a
 * line is both unreadable and the one place redaction could miss a value it would
 * otherwise have matched whole.
 */
function tail(text: string, limit: number): string {
    if (text.length <= limit) return text;
    const cut = text.slice(-limit);
    const start = cut.indexOf("\n");
    return `[... earlier output trimmed ...]\n${start === -1 ? cut : cut.slice(start + 1)}`;
}

/** The issue body, as Markdown. */
export function issueBody(report: UpdateReport, logLimit = LOG_CHARS): string {
    const rows: Array<[string, string]> = [
        ["Running build", report.build ?? "unknown"],
        ["Updating to", report.target ?? "unknown"],
        ["Edition", report.edition],
        ["Server", report.environment],
        ["Domain", report.domain ?? "none configured"],
        ["Kernel", `${report.kernel} (${report.arch})`],
        ["Node", report.node],
        ["Hardware", `${report.cpus} CPU, ${report.memoryGb} GB RAM`],
        ["Exit code", report.exitCode === null ? "unknown" : String(report.exitCode)]
    ];
    return [
        "## What happened",
        "",
        "The in-band update failed. Details collected by Polaris:",
        "",
        ...rows.map(([label, value]) => `- **${label}:** ${value}`),
        "",
        "## Update log",
        "",
        "```",
        // Trim first, redact second: only what is published needs scrubbing, and
        // scrubbing a whole build log to then throw all but its tail away is work
        // done once per attempt at fitting the URL.
        redactSecrets(tail(report.log, logLimit)).trim() || "(the updater wrote no log)",
        "```",
        "",
        "## Anything else",
        "",
        "<!-- What you were doing, and anything the log does not show. -->"
    ].join("\n");
}

/**
 * A link that opens the issue form with all of it filled in. The log is trimmed
 * until the whole URL fits, so the form always opens complete rather than however
 * much of it survived the address bar.
 */
export function issueUrl(repo: string, report: UpdateReport): string {
    const title = `Update failed on ${report.environment}${report.build ? ` at ${report.build}` : ""}`;
    for (let limit = LOG_CHARS; limit > 250; limit = Math.floor(limit / 2)) {
        const url =
            `https://github.com/${repo}/issues/new` +
            `?title=${encodeURIComponent(title)}` +
            `&labels=${encodeURIComponent("bug")}` +
            `&body=${encodeURIComponent(issueBody(report, limit))}`;
        if (url.length <= MAX_URL) return url;
    }
    return (
        `https://github.com/${repo}/issues/new` +
        `?title=${encodeURIComponent(title)}` +
        `&labels=${encodeURIComponent("bug")}` +
        `&body=${encodeURIComponent(issueBody(report, 250))}`
    );
}

/** The updater's exit marker, the same one the log tail endpoint reads. */
const MARKER = /POLARIS_UPDATE_EXIT=(-?\d+)/;

/** Everything worth knowing about the box the update failed on. Every lookup is
 *  best-effort: a report missing one field beats no report at all. */
export async function collectUpdateReport(): Promise<UpdateReport> {
    const [status, environment, zone, appDomain, log] = await Promise.all([
        getUpdateStatus().catch(() => null),
        getLocalEnvironment()
            .then((local) => local.environment)
            .catch((): ServerEnvironment => "unknown"),
        polarisZoneHost().catch(() => null),
        getSetting("domain.app").catch(() => null),
        readFile(LOG_PATH, "utf8").catch(() => "")
    ]);
    const match = log.match(MARKER);
    return {
        build: status?.current ?? (loadEnv().POLARIS_BUILD_SHA || null),
        target: status?.latest ?? null,
        edition: getCapabilities().edition,
        environment,
        domain: appDomain || zone,
        kernel: `${platform()} ${release()}`,
        arch: arch(),
        node: process.version,
        cpus: cpus().length,
        memoryGb: Math.round((totalmem() / 1024 ** 3) * 10) / 10,
        exitCode: match ? Number(match[1]) : null,
        log
    };
}
