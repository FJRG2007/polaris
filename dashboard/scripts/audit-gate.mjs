/**
 * Decide whether an `npm audit --json` report is acceptable.
 *
 * A high or critical advisory fails the gate unless `audit-allowlist.json` accepts
 * it, by GHSA id and package, with a reason and an expiry date. An acceptance that
 * has expired fails like the advisory it covered, so nothing stays accepted because
 * nobody looked again. Moderate and low advisories are reported, never failed on.
 *
 *   npm audit --omit=dev --json > audit.json
 *   node scripts/audit-gate.mjs audit.json [--warn-only] [--title "Production dependencies"]
 *
 * Prints a Markdown summary on stdout. Exit code 1 when the gate fails, unless
 * --warn-only is given (the summary still says what would have failed).
 */

import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join, resolve } from "node:path";

const GATED = new Set(["high", "critical"]);
const SEVERITIES = ["critical", "high", "moderate", "low", "info"];
const GHSA = /^GHSA(-[23456789cfghjmpqrvwx]{4}){3}$/;
const DAY = /^\d{4}-\d{2}-\d{2}$/;

/** The GHSA id an advisory URL ends in, or null when it is not one. */
function advisoryId(url) {
    const id = String(url ?? "").split("/").pop();
    return GHSA.test(id) ? id : null;
}

/**
 * Read the allowlist and refuse a malformed one: an entry that does not say what,
 * why and until when is an acceptance nobody can review.
 */
export function parseAllowlist(value) {
    if (!value || !Array.isArray(value.accepted)) throw new Error("allowlist: expected { accepted: [...] }");
    return value.accepted.map((entry, index) => {
        const where = `allowlist entry ${index}`;
        if (typeof entry !== "object" || entry === null) throw new Error(`${where}: not an object`);
        const { id, package: name, reason, expires } = entry;
        if (!GHSA.test(String(id))) throw new Error(`${where}: id must be a GHSA id`);
        if (typeof name !== "string" || !name.trim()) throw new Error(`${where}: package is required`);
        if (typeof reason !== "string" || reason.trim().length < 20) throw new Error(`${where}: reason must say why`);
        if (!DAY.test(String(expires)) || Number.isNaN(Date.parse(`${expires}T00:00:00Z`))) {
            throw new Error(`${where}: expires must be YYYY-MM-DD`);
        }
        return { id, package: name, reason: reason.trim(), expires };
    });
}

/**
 * The advisories in a report, one per (GHSA id, package). npm lists every package
 * that depends on a vulnerable one too; only the entries carrying the advisory
 * itself are counted, so one advisory is one line however deep it sits.
 */
export function collectAdvisories(report) {
    if (!report || typeof report !== "object") throw new Error("audit report: not an object");
    if (report.error) throw new Error(`audit report: npm failed (${report.error.code ?? "unknown"}: ${report.error.summary ?? ""})`);
    const vulnerabilities = report.vulnerabilities;
    if (!vulnerabilities || typeof vulnerabilities !== "object") throw new Error("audit report: no vulnerabilities map");
    const found = new Map();
    for (const [name, vulnerability] of Object.entries(vulnerabilities)) {
        if (!Array.isArray(vulnerability?.via)) throw new Error(`audit report: ${name} has no via list`);
        for (const via of vulnerability.via) {
            if (typeof via !== "object" || via === null) continue;
            const id = advisoryId(via.url);
            if (!id || !SEVERITIES.includes(via.severity)) continue;
            const key = `${id} ${name}`;
            const previous = found.get(key);
            if (previous && SEVERITIES.indexOf(previous.severity) <= SEVERITIES.indexOf(via.severity)) continue;
            found.set(key, {
                id,
                package: name,
                severity: via.severity,
                title: String(via.title ?? ""),
                range: String(via.range ?? ""),
                nodes: Array.isArray(vulnerability.nodes) ? vulnerability.nodes : []
            });
        }
    }
    return [...found.values()].sort((a, b) => SEVERITIES.indexOf(a.severity) - SEVERITIES.indexOf(b.severity) || a.package.localeCompare(b.package, "en") || a.id.localeCompare(b.id, "en"));
}

/** Split the gated advisories into accepted, expired and failing, and find stale acceptances. */
export function evaluate(advisories, allowlist, today) {
    const day = today.toISOString().slice(0, 10);
    const failing = [];
    const accepted = [];
    const expired = [];
    for (const advisory of advisories.filter((a) => GATED.has(a.severity))) {
        const entry = allowlist.find((e) => e.id === advisory.id && e.package === advisory.package);
        if (!entry) failing.push(advisory);
        else if (entry.expires < day) expired.push({ ...advisory, entry });
        else accepted.push({ ...advisory, entry });
    }
    const present = new Set(advisories.map((a) => `${a.id} ${a.package}`));
    const stale = allowlist.filter((e) => !present.has(`${e.id} ${e.package}`));
    return { failing, accepted, expired, stale, pass: failing.length === 0 && expired.length === 0 };
}

const link = (id) => `[${id}](https://github.com/advisories/${id})`;

/** Markdown for the CI log and the maintenance issue. */
export function render(title, report, advisories, result) {
    const counts = report.metadata?.vulnerabilities ?? {};
    const lines = [`#### ${title}`, ""];
    lines.push(`Packages flagged: ${SEVERITIES.map((s) => `${counts[s] ?? 0} ${s}`).join(", ")}.`);
    lines.push(`Advisories: ${SEVERITIES.map((s) => `${advisories.filter((a) => a.severity === s).length} ${s}`).join(", ")}.`, "");
    const table = (rows, extra) => {
        lines.push(`| Severity | Package | Advisory | ${extra} |`, "| --- | --- | --- | --- |");
        for (const row of rows) lines.push(`| ${row.severity} | \`${row.package}\` | ${link(row.id)} ${row.title.replaceAll("|", "\\|")} | ${row.note.replaceAll("|", "\\|")} |`);
        lines.push("");
    };
    if (result.failing.length) {
        lines.push("**Not accepted - fix, or accept in `scripts/audit-allowlist.json` with a reason:**", "");
        table(result.failing.map((a) => ({ ...a, note: a.nodes.join(", ") })), "Installed at");
    }
    if (result.expired.length) {
        lines.push("**Acceptance expired - look again:**", "");
        table(result.expired.map((a) => ({ ...a, note: `expired ${a.entry.expires}: ${a.entry.reason}` })), "Acceptance");
    }
    if (result.accepted.length) {
        lines.push("Accepted:", "");
        table(result.accepted.map((a) => ({ ...a, note: `until ${a.entry.expires}: ${a.entry.reason}` })), "Why");
    }
    if (result.stale.length) {
        lines.push(`No longer reported, so these acceptances can be removed: ${result.stale.map((e) => `${e.id} (${e.package})`).join(", ")}.`, "");
    }
    lines.push(result.pass ? "Gate: pass." : "Gate: **fail**.", "");
    return lines.join("\n");
}

function main(argv) {
    const args = [...argv];
    const warnOnly = args.includes("--warn-only");
    const titleAt = args.indexOf("--title");
    const title = titleAt >= 0 ? args[titleAt + 1] : "npm audit";
    const file = args.find((a, i) => !a.startsWith("--") && args[i - 1] !== "--title");
    if (!file) throw new Error("usage: audit-gate.mjs <audit.json> [--warn-only] [--title <title>]");
    const here = dirname(fileURLToPath(import.meta.url));
    const allowlist = parseAllowlist(JSON.parse(readFileSync(join(here, "audit-allowlist.json"), "utf8")));
    const report = JSON.parse(readFileSync(file, "utf8"));
    const advisories = collectAdvisories(report);
    const result = evaluate(advisories, allowlist, new Date());
    process.stdout.write(`${render(title, report, advisories, result)}\n`);
    return result.pass || warnOnly ? 0 : 1;
}

if (process.argv[1] && fileURLToPath(import.meta.url) === resolve(process.argv[1])) {
    try {
        process.exitCode = main(process.argv.slice(2));
    } catch (error) {
        process.stderr.write(`audit-gate: ${error.message}\n`);
        process.exitCode = 2;
    }
}
