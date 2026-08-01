/**
 * Reading a pool's scope back off the row, and naming the places it comes to.
 *
 * Kept apart from the resolution that needs GitHub and the database, because this
 * half is pure and is the half worth being certain about: a scope column is
 * written by one version of Polaris and read by the next, and a row that cannot be
 * read must cost a pool its pass rather than take the whole reconciler down.
 */

import { runnerScopeSchema, type RunnerScopeInput } from "@polaris/core";

/** The key a target is known by, here and in the placement logic: "owner/repo",
 *  or just the account for an organization registration. */
export function targetKey(owner: string, repo: string | null): string {
    return repo ? `${owner}/${repo}` : owner;
}

/**
 * Read a stored scope back, or null when the row does not hold one.
 *
 * A column is not a type. The kind lives in its own column so a pool can be found
 * by it, and the rest is JSON, so the two are checked together here - a row saying
 * `repo` whose body names no repository would otherwise become a REST path with an
 * empty segment.
 */
export function parseStoredScope(scope: string, scopeConfig: string): RunnerScopeInput | null {
    let raw: unknown;
    try {
        raw = JSON.parse(scopeConfig);
    } catch {
        return null;
    }
    if (raw === null || typeof raw !== "object" || Array.isArray(raw)) return null;
    const parsed = runnerScopeSchema.safeParse({ ...(raw as Record<string, unknown>), kind: scope });
    return parsed.success ? parsed.data : null;
}

/** The scope split the way it is stored: the kind in its own column, the rest as
 *  JSON beside it. */
export function storeScope(scope: RunnerScopeInput): { scope: string; scopeConfig: string } {
    const { kind, ...rest } = scope;
    return { scope: kind, scopeConfig: JSON.stringify(rest) };
}
