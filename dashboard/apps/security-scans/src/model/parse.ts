/**
 * Reading what the one-off containers printed. Pure, so every format is held
 * to a test without a container in sight.
 */

import { scanMount } from "./specs";

/* -------------------------------------------------------------------------- */
/* Malware                                                                     */
/* -------------------------------------------------------------------------- */

export interface MalwareHit {
    /** Which of the scanned volumes, by its place in the scan. */
    readonly volume: number;
    /** The file's path inside that volume. */
    readonly path: string;
    /** The signature that matched. */
    readonly signature: string;
}

export interface MalwareReport {
    readonly hits: MalwareHit[];
    /** The scan ran on signatures the refresh could not update. */
    readonly staleSignatures: boolean;
    readonly noSignatures: boolean;
    /** The scanner's exit code; null when it never printed one. */
    readonly exitCode: number | null;
}

const FOUND = /^\/scan\/(\d+)\/(.+): (.+) FOUND$/;

export function parseMalwareLog(text: string): MalwareReport {
    const hits: MalwareHit[] = [];
    let exitCode: number | null = null;
    for (const raw of text.split("\n")) {
        const line = raw.replace(/\r$/, "");
        const found = FOUND.exec(line);
        if (found) {
            hits.push({ volume: Number(found[1]), path: found[2]!, signature: found[3]!.trim() });
            continue;
        }
        const exit = /^POLARIS_EXIT code=(\d+)$/.exec(line);
        if (exit) exitCode = Number(exit[1]);
    }
    return {
        hits,
        staleSignatures: text.includes("POLARIS_SIGNATURES_STALE"),
        noSignatures: text.includes("POLARIS_NO_SIGNATURES"),
        exitCode
    };
}

/** Whether a mount prefix is one of a scan's (guards a stray line). */
export function isScanPath(path: string, volumes: number): boolean {
    return Array.from({ length: volumes }, (_, index) => scanMount(index)).some((mount) =>
        path.startsWith(`${mount}/`)
    );
}

/* -------------------------------------------------------------------------- */
/* File integrity                                                              */
/* -------------------------------------------------------------------------- */

/** Path -> sha256, sorted by path. */
export type Manifest = ReadonlyMap<string, string>;

export interface FilesReport {
    readonly manifest: Manifest;
    readonly counted: number | null;
    readonly complete: boolean;
}

const HASH_LINE = /^([0-9a-f]{64}) [ *]\.\/(.+)$/;

export function parseFilesLog(text: string): FilesReport {
    const entries: [string, string][] = [];
    let counted: number | null = null;
    for (const raw of text.split("\n")) {
        const line = raw.replace(/\r$/, "");
        const hash = HASH_LINE.exec(line);
        if (hash) {
            entries.push([hash[2]!, hash[1]!]);
            continue;
        }
        const count = /^POLARIS_FILES n=(\d+)$/.exec(line);
        if (count) counted = Number(count[1]);
    }
    entries.sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0));
    return { manifest: new Map(entries), counted, complete: text.includes("POLARIS_DONE") };
}

/** A manifest as stored: one JSON array of [path, hash], compressed by the caller. */
export function encodeManifest(manifest: Manifest): string {
    return JSON.stringify([...manifest.entries()]);
}

export function decodeManifest(json: string): Manifest {
    const value: unknown = JSON.parse(json);
    if (!Array.isArray(value)) return new Map();
    const entries = value.filter(
        (entry): entry is [string, string] =>
            Array.isArray(entry) &&
            entry.length === 2 &&
            typeof entry[0] === "string" &&
            typeof entry[1] === "string"
    );
    return new Map(entries);
}

export interface ManifestDiff {
    readonly added: string[];
    readonly removed: string[];
    readonly changed: string[];
    /** The real totals; the lists above stop at the cap. */
    readonly totals: { readonly added: number; readonly removed: number; readonly changed: number };
}

export function diffManifests(baseline: Manifest, now: Manifest, cap = 200): ManifestDiff {
    const added: string[] = [];
    const removed: string[] = [];
    const changed: string[] = [];
    for (const [path, hash] of now) {
        const before = baseline.get(path);
        if (before === undefined) added.push(path);
        else if (before !== hash) changed.push(path);
    }
    for (const path of baseline.keys()) if (!now.has(path)) removed.push(path);
    const sorted = (list: string[]) => list.sort().slice(0, cap);
    return {
        added: sorted(added),
        removed: sorted(removed),
        changed: sorted(changed),
        totals: { added: added.length, removed: removed.length, changed: changed.length }
    };
}

/* -------------------------------------------------------------------------- */
/* Host audit                                                                  */
/* -------------------------------------------------------------------------- */

export interface AuditItem {
    readonly kind: "warning" | "suggestion";
    /** The check's id (`SSH-7408`), which also groups items for a label. */
    readonly test: string;
    readonly text: string;
    readonly detail: string | null;
}

export interface AuditReport {
    /** 0-100, higher is better; null when the report carried none. */
    readonly score: number | null;
    readonly os: string | null;
    readonly testsRun: number | null;
    readonly items: AuditItem[];
}

function field(value: string | undefined): string | null {
    const trimmed = (value ?? "").trim();
    return trimmed === "" || trimmed === "-" ? null : trimmed;
}

export function parseAuditReport(text: string): AuditReport {
    const start = text.indexOf("POLARIS_REPORT");
    const body = start >= 0 ? text.slice(start + "POLARIS_REPORT".length) : text;
    const values = new Map<string, string>();
    const items: AuditItem[] = [];
    for (const raw of body.split("\n")) {
        const line = raw.replace(/\r$/, "");
        const eq = line.indexOf("=");
        if (eq <= 0) continue;
        const key = line.slice(0, eq);
        const value = line.slice(eq + 1);
        if (key === "warning[]" || key === "suggestion[]") {
            const [test, message, detail] = value.split("|");
            if (!field(test) || !field(message)) continue;
            items.push({
                kind: key === "warning[]" ? "warning" : "suggestion",
                test: field(test)!,
                text: field(message)!,
                detail: field(detail)
            });
            continue;
        }
        if (!key.endsWith("[]")) values.set(key, value);
    }
    const score = Number(values.get("hardening_index"));
    const tests = Number(values.get("lynis_tests_done"));
    const os = [values.get("os_name"), values.get("os_version")]
        .map(field)
        .filter(Boolean)
        .join(" ");
    return {
        score:
            Number.isFinite(score) && values.has("hardening_index")
                ? Math.max(0, Math.min(100, score))
                : null,
        os: os || null,
        testsRun: Number.isFinite(tests) && values.has("lynis_tests_done") ? tests : null,
        items
    };
}

/** The check groups an audit id belongs to, as a reader names them. Keyed by
 *  the id's prefix; anything else is "Other". */
export const AUDIT_AREAS: Readonly<Record<string, string>> = {
    AUTH: "accounts",
    BOOT: "boot",
    FILE: "files",
    FINT: "files",
    FIRE: "firewall",
    KRNL: "kernel",
    LOGG: "logging",
    MAIL: "mail",
    NETW: "network",
    PKGS: "packages",
    SSH: "ssh",
    STRG: "storage",
    TIME: "time",
    TOOL: "tools",
    USB: "usb",
    ACCT: "accounts",
    HRDN: "hardening",
    MALW: "malware",
    CONT: "containers",
    DEB: "packages",
    PHP: "web",
    HTTP: "web",
    NAME: "network",
    SCHD: "scheduling",
    SHLL: "accounts",
    BANN: "accounts",
    CRYP: "crypto"
};

export function auditArea(test: string): string {
    return AUDIT_AREAS[test.split("-")[0] ?? ""] ?? "other";
}

export type UpdatesState = "on" | "off" | "unsupported";

export interface UpdatesReport {
    readonly state: UpdatesState | null;
    readonly distro: string | null;
}

export function parseUpdatesLog(text: string): UpdatesReport {
    const state = /POLARIS_UPDATES=(on|off|unsupported)/.exec(text)?.[1] as
        | UpdatesState
        | undefined;
    const distro = /POLARIS_DISTRO id=([A-Za-z0-9._-]*)/.exec(text)?.[1];
    return { state: state ?? null, distro: distro ? distro : null };
}

/* -------------------------------------------------------------------------- */
/* Images                                                                      */
/* -------------------------------------------------------------------------- */

export const SEVERITIES = ["critical", "high", "medium", "low", "negligible", "unknown"] as const;
export type Severity = (typeof SEVERITIES)[number];

export interface Vulnerability {
    readonly id: string;
    readonly severity: Severity;
    readonly packageName: string;
    readonly version: string;
    readonly fixedIn: string | null;
    readonly url: string | null;
}

export interface VulnReport {
    readonly counts: Readonly<Record<Severity, number>>;
    /** Worst first, capped. */
    readonly items: Vulnerability[];
    readonly total: number;
}

/** The JSON a container printed, from its first brace to its last. */
export function jsonOf(text: string): unknown {
    const start = text.indexOf("{");
    const end = text.lastIndexOf("}");
    if (start < 0 || end <= start) return null;
    try {
        return JSON.parse(text.slice(start, end + 1));
    } catch {
        return null;
    }
}

function severityOf(value: unknown): Severity {
    const lower = typeof value === "string" ? value.toLowerCase() : "";
    return (SEVERITIES as readonly string[]).includes(lower) ? (lower as Severity) : "unknown";
}

function str(value: unknown): string | null {
    return typeof value === "string" && value.length > 0 ? value.slice(0, 300) : null;
}

export function parseVulnJson(value: unknown, cap = 500): VulnReport | null {
    if (
        !value ||
        typeof value !== "object" ||
        !Array.isArray((value as { matches?: unknown }).matches)
    ) {
        return null;
    }
    const counts = Object.fromEntries(SEVERITIES.map((s) => [s, 0])) as Record<Severity, number>;
    const seen = new Set<string>();
    const items: Vulnerability[] = [];
    for (const match of (value as { matches: unknown[] }).matches) {
        if (!match || typeof match !== "object") continue;
        const vuln = (match as { vulnerability?: Record<string, unknown> }).vulnerability ?? {};
        const artifact = (match as { artifact?: Record<string, unknown> }).artifact ?? {};
        const id = str(vuln.id);
        const name = str(artifact.name);
        if (!id || !name) continue;
        const version = str(artifact.version) ?? "";
        const key = `${id}|${name}|${version}`;
        if (seen.has(key)) continue;
        seen.add(key);
        const severity = severityOf(vuln.severity);
        counts[severity] += 1;
        const fix = (vuln.fix ?? {}) as { versions?: unknown };
        const fixed = Array.isArray(fix.versions)
            ? fix.versions.filter((v): v is string => typeof v === "string").join(", ")
            : "";
        items.push({
            id,
            severity,
            packageName: name,
            version,
            fixedIn: fixed ? fixed.slice(0, 200) : null,
            url: httpsLink(vuln.dataSource)
        });
    }
    const rank = (s: Severity) => SEVERITIES.indexOf(s);
    items.sort((a, b) => rank(a.severity) - rank(b.severity) || a.id.localeCompare(b.id));
    return { counts, items: items.slice(0, cap), total: items.length };
}

/** Only an https link is kept: it is drawn as a link. */
function httpsLink(value: unknown): string | null {
    const text = str(value);
    if (!text) return null;
    try {
        return new URL(text).protocol === "https:" ? text : null;
    } catch {
        return null;
    }
}

export interface SbomSummary {
    readonly format: "CycloneDX";
    readonly specVersion: string | null;
    readonly components: number;
}

export function summarizeSbom(value: unknown): SbomSummary | null {
    if (!value || typeof value !== "object") return null;
    const doc = value as { bomFormat?: unknown; specVersion?: unknown; components?: unknown };
    if (doc.bomFormat !== "CycloneDX") return null;
    return {
        format: "CycloneDX",
        specVersion: str(doc.specVersion),
        components: Array.isArray(doc.components) ? doc.components.length : 0
    };
}

/** An image reference as the host may be asked to save it: no shell words, no
 *  spaces, the shape `name[:tag][@sha256:...]`. */
const IMAGE_REF = /^[a-z0-9][a-z0-9._\-/:]{0,250}(@sha256:[0-9a-f]{64})?$/;

export function isImageRef(ref: string): boolean {
    return IMAGE_REF.test(ref) && !ref.includes("//");
}
