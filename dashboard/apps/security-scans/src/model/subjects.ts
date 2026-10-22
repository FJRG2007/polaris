/**
 * What a scan was about, in the words a reader knows today, and its outcome in
 * one line. A scan stores the name its subject had when it ran; an app renamed
 * since - or one Polaris installs for itself and has since renamed, like the
 * Network filter's DNS server - is shown and announced under its current name.
 * Pure.
 */

/** The severities a vulnerability scan counts, worst first. */
export const COUNTED = ["critical", "high", "medium", "low"] as const;
export type Counted = (typeof COUNTED)[number];

/** The parts of a catalog manifest a name is resolved from. */
export interface ManifestName {
    readonly name: string;
    /** Installed by Polaris for another app, never named by the operator. */
    readonly internal?: boolean;
    /** The app whose screen manages it. */
    readonly ownedBy?: string;
    readonly opensAt?: string;
}

export interface AppRow {
    readonly id: string;
    readonly name: string;
    /** The Deploy project the app lives in, for a link to it. */
    readonly projectId: string | null;
    /** The installed app this Deploy app backs, if any. */
    readonly installed: { readonly id: string; readonly catalogId: string } | null;
}

export interface CurrentApp {
    readonly name: string;
    /** Where the app is managed; null when it has no screen of its own. */
    readonly href: string | null;
}

/**
 * The name and screen of an app as of now. An app Polaris installed for itself
 * carries the catalog's current name, since nobody chose the one it was stored
 * under; any other keeps the name it has (the operator's).
 */
export function currentApp(
    row: AppRow,
    findManifest: (catalogId: string) => ManifestName | undefined
): CurrentApp {
    const manifest = row.installed ? findManifest(row.installed.catalogId) : undefined;
    const name = manifest?.internal ? manifest.name : row.name;
    if (manifest?.internal && manifest.ownedBy) {
        const owner = findManifest(manifest.ownedBy);
        return { name, href: owner?.opensAt ?? null };
    }
    if (row.installed)
        return { name, href: manifest?.opensAt ?? `/apps/installed/${row.installed.id}` };
    return {
        name,
        href: row.projectId ? `/apps/deploy/${row.projectId}?service=${row.id}` : null
    };
}

/** The app a scan's stored input names, for the kinds that have one. */
export function applicationIdOf(input: Readonly<Record<string, unknown>>): string | null {
    return typeof input.applicationId === "string" && input.applicationId.length > 0
        ? input.applicationId
        : null;
}

/** A scan's subject name now: the app's current name, else what was stored. */
export function subjectName(
    scan: { readonly label: string; readonly input: Readonly<Record<string, unknown>> },
    apps: ReadonlyMap<string, CurrentApp>
): string {
    const appId = applicationIdOf(scan.input);
    return (appId ? apps.get(appId)?.name : undefined) ?? scan.label;
}

export type SubjectKind = "appImage" | "image" | "deps";

/** Which kind of thing a vulnerability scan looked at. */
export function subjectKind(scan: {
    readonly kind: string;
    readonly input: Readonly<Record<string, unknown>>;
}): SubjectKind {
    if (scan.kind === "deps") return "deps";
    return applicationIdOf(scan.input) ? "appImage" : "image";
}

export interface Verdict {
    readonly total: number;
    /** Counts above zero, worst first. */
    readonly parts: readonly { readonly severity: Counted; readonly count: number }[];
    /** How many have a fixed version; null when the findings are not read yet. */
    readonly fixable: number | null;
}

/** A finished vulnerability scan's outcome, from its stored counts and, once read, its findings. */
export function verdictOf(
    summary: Readonly<Record<string, unknown>>,
    findings?: readonly { readonly severity: string; readonly fixedIn: string | null }[] | null
): Verdict {
    const parts = COUNTED.map((severity) => ({
        severity,
        count: Math.max(0, Math.trunc(Number(summary[severity] ?? 0)) || 0)
    })).filter((part) => part.count > 0);
    const counted = parts.reduce((sum, part) => sum + part.count, 0);
    const stored = Number(summary.total);
    const total = Number.isFinite(stored) && stored >= counted ? Math.trunc(stored) : counted;
    const fixable = findings
        ? findings.filter((f) => (COUNTED as readonly string[]).includes(f.severity) && f.fixedIn)
              .length
        : null;
    return { total: Math.max(total, counted), parts, fixable };
}

/** What the reader should do about a verdict. */
export type NextStep = "none" | "update" | "updateSome" | "wait";

export function nextStep(verdict: Verdict): NextStep {
    const serious = verdict.parts.reduce((sum, part) => sum + part.count, 0);
    if (serious === 0) return "none";
    if (verdict.fixable === null) return "update";
    if (verdict.fixable === 0) return "wait";
    return verdict.fixable >= serious ? "update" : "updateSome";
}
