/**
 * How the settings screen groups an update's changelog. `@polaris/core` already
 * drops commits whose type is internal (`test`, `ci`, `chore`...); what still
 * gets through is a `fix(ci)` or a `fix(test)` - a real type on an internal
 * scope - and subjects about the repository itself ("the guards that broke
 * main"). Those go into a "maintenance" group of their own, folded by default,
 * so they never compete with what changed for whoever runs Polaris.
 *
 * Pure, so the rule is asserted in a test rather than eyeballed on screen.
 */

import { CHANGE_KINDS, type ChangeKind, type ChangelogEntry } from "@polaris/core";

export const CHANGELOG_GROUPS = [...CHANGE_KINDS, "maintenance"] as const;

export type ChangelogGroup = (typeof CHANGELOG_GROUPS)[number];

/** Scopes that name the repository's own machinery, not a part of Polaris. */
const MAINTENANCE_SCOPES = new Set([
    "test",
    "tests",
    "ci",
    "chore",
    "build",
    "deps",
    "lint",
    "tooling",
    "guards",
    "gate",
    "release",
    "docs",
    "repo"
]);

/** Subjects about the state of the main branch or the test suite. */
const MAINTENANCE_SUBJECT =
    /\b(?:broke|breaks|unbreak|unbreaks) main\b|\bmain (?:is )?(?:green|red)\b|\bflaky (?:tests?|specs?)\b|\bguard tests?\b|\bguards? (?:that|which) broke\b/i;

/**
 * Scopes that ship somewhere other than this server: the public website, the
 * desktop app, the browser extension, the Stream Deck plugin and the companion.
 * Each has its own release, so a change to one changes nothing an update of
 * Polaris installs and is not listed as if it did.
 */
const ELSEWHERE_SCOPES = new Set([
    "site",
    "website",
    "desktop",
    "extension",
    "streamdeck",
    "companion"
]);

function scopesOf(entry: Pick<ChangelogEntry, "scope">): string[] {
    return (entry.scope ?? "")
        .toLowerCase()
        .split(/[\s,/]+/)
        .filter(Boolean);
}

/** Whether a change ships with something other than this server. A security
 *  fix is always listed: it is the one entry nobody should have to look for. */
export function shipsElsewhere(entry: Pick<ChangelogEntry, "scope" | "security">): boolean {
    if (entry.security) return false;
    const scopes = scopesOf(entry);
    return scopes.length > 0 && scopes.every((scope) => ELSEWHERE_SCOPES.has(scope));
}

/** Whether an entry is internal upkeep. A security fix never is. */
export function isMaintenance(entry: Pick<ChangelogEntry, "scope" | "title" | "security">): boolean {
    if (entry.security) return false;
    const scopes = scopesOf(entry);
    if (scopes.length > 0 && scopes.every((scope) => MAINTENANCE_SCOPES.has(scope))) return true;
    return MAINTENANCE_SUBJECT.test(entry.title);
}

/** The entries by group, in `CHANGELOG_GROUPS` order, empty groups left out. */
export function groupChangelog(
    entries: readonly ChangelogEntry[]
): { group: ChangelogGroup; entries: ChangelogEntry[] }[] {
    const byGroup = new Map<ChangelogGroup, ChangelogEntry[]>();
    for (const entry of entries) {
        if (shipsElsewhere(entry)) continue;
        const group: ChangelogGroup = isMaintenance(entry) ? "maintenance" : (entry.kind as ChangeKind);
        const list = byGroup.get(group);
        if (list) list.push(entry);
        else byGroup.set(group, [entry]);
    }
    return CHANGELOG_GROUPS.flatMap((group) => {
        const list = byGroup.get(group);
        return list ? [{ group, entries: list }] : [];
    });
}
