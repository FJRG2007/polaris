/**
 * Which GitHub App installation a token is minted from, and what it may reach.
 *
 * Pure, so the two rules that keep an agent's credential small can be asserted
 * without GitHub: an owner nobody installed the App on gets no token at all -
 * never the first installation's, which belongs to somebody else - and a token
 * for an agent names the one repository and the one permission it needs.
 */

export interface InstallationRow {
    readonly id: number;
    readonly login: string;
}

export interface InstallationScope {
    /** Repository names without the owner, as GitHub's access_tokens call takes them. */
    readonly repositories: readonly string[];
    readonly permissions: Readonly<Record<string, "read" | "write">>;
}

/** The installation on `owner`, or null. Never a fallback to another account's. */
export function installationFor<T extends InstallationRow>(
    installs: readonly T[],
    owner: string
): T | null {
    const wanted = owner.trim().toLowerCase();
    if (!wanted) return null;
    return installs.find((row) => row.login.toLowerCase() === wanted) ?? null;
}

/** The body of the access_tokens call: nothing for an instance-wide token, the
 *  repositories and permissions for a scoped one. */
export function installationTokenBody(scope?: InstallationScope): string | undefined {
    if (!scope) return undefined;
    return JSON.stringify({
        repositories: [...scope.repositories],
        permissions: { ...scope.permissions }
    });
}

/** `owner/name` split for a scope, or null when it is not one repository. */
export function repositoryScope(
    fullName: string,
    permissions: InstallationScope["permissions"]
): { owner: string; scope: InstallationScope } | null {
    const match = /^([A-Za-z0-9_.-]+)\/([A-Za-z0-9_.-]+)$/.exec(fullName.trim());
    if (!match) return null;
    return { owner: match[1]!, scope: { repositories: [match[2]!], permissions } };
}

/** What an agent's git needs, and nothing it does not: clone, fetch, push. */
export const AGENT_GIT_PERMISSIONS = { contents: "write" } as const;
/** What a clone needs. */
export const CLONE_PERMISSIONS = { contents: "read" } as const;

/** A token in git's credential-helper format. A token is a GitHub-issued string
 *  with no newline, and one that had one is refused rather than let it write a
 *  second key into git's answer. */
export function gitCredentialAnswer(token: string): string {
    if (/[\r\n\0]/.test(token)) return "";
    return `username=x-access-token\npassword=${token}\n`;
}
