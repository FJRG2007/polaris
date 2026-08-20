/**
 * Whose GitHub credentials a call is made with.
 *
 * This is the module that decides the question the rest of Deploy used to get
 * wrong: a repository list is personal. Anything somebody asks for interactively
 * is asked as them, using an account they linked themselves, and never falls back
 * to the instance's credentials - a fallback is how one operator's token ends up
 * showing their private repositories to every account on the box.
 *
 * Work that runs with nobody watching - the auto-deploy poll, a webhook, a build
 * cloning a repository - has no session to ask as. It uses the credentials of
 * whoever owns the project being deployed, and falls back to the instance's App
 * installation, which is a credential an administrator deliberately installed on
 * those repositories. That fallback is what keeps services deployed before any of
 * this existed building exactly as they did.
 */

import { listConnections, readCredential, updateCredential } from "@/lib/connections/store";
import {
    cloneAuthHeader,
    githubAppInstallationToken,
    listReposForPat,
    listReposForUserToken,
    refreshGithubUserToken,
    type GithubRepo
} from "@/lib/github-service";

const PROVIDER = "github";

/** One linked GitHub account, with a token that currently speaks for it. */
export interface GithubCredential {
    connectionId: string;
    login: string;
    method: "oauth" | "token";
    token: string;
}

/**
 * Every GitHub account this person has linked, each with a usable token.
 *
 * An account whose credential cannot be read - never stored, undecryptable after
 * a key rotation, or a refresh GitHub has stopped honouring - is left out rather
 * than throwing: one stale link should cost that link, not the whole list.
 */
export async function githubCredentialsForUser(userId: string): Promise<GithubCredential[]> {
    const links = await listConnections(userId, PROVIDER);
    const usable: GithubCredential[] = [];
    for (const link of links) {
        const token = await usableToken(link.id).catch(() => null);
        if (token) usable.push({ connectionId: link.id, login: link.label, method: link.method, token });
    }
    return usable;
}

/**
 * A token for a call this person is making about `owner`'s repositories, or null
 * when they have linked nothing. Their account for that owner is preferred, so
 * somebody with a work account and a personal one reaches each of them.
 */
export async function githubTokenForUser(userId: string, owner?: string): Promise<string | null> {
    return (await credentialForUser(userId, owner))?.token ?? null;
}

/** The linked account a call about `owner` is made as: theirs for that owner if
 *  they have one, otherwise the first they linked. */
async function credentialForUser(userId: string, owner?: string): Promise<GithubCredential | null> {
    const credentials = await githubCredentialsForUser(userId);
    const wanted = owner?.toLowerCase();
    const match = wanted ? credentials.find((entry) => entry.login.toLowerCase() === wanted) : undefined;
    return match ?? credentials[0] ?? null;
}

/** Repositories this person can deploy: everything their linked accounts reach. */
export async function listReposForUser(userId: string): Promise<GithubRepo[]> {
    const credentials = await githubCredentialsForUser(userId);
    const repos: GithubRepo[] = [];
    for (const credential of credentials) {
        const listed = await (credential.method === "token"
            ? listReposForPat(credential.token)
            : listReposForUserToken(credential.token)
        ).catch(() => []);
        repos.push(...listed);
    }
    const seen = new Set<string>();
    return repos.filter((repo) => (seen.has(repo.fullName) ? false : (seen.add(repo.fullName), true)));
}

/**
 * A token for work nobody is watching: the owner's own credentials first, the
 * instance's App installation second. Both may be absent, which is a public
 * repository read or nothing at all - the same answer as before any account was
 * linked.
 */
export async function githubTokenForOwner(userId: string | null, owner?: string): Promise<string | null> {
    if (userId) {
        const personal = await githubTokenForUser(userId, owner).catch(() => null);
        if (personal) return personal;
    }
    return githubAppInstallationToken(owner).catch(() => null);
}

/** Who a clone goes out as, and the header that says so. */
export interface CloneIdentity {
    /** The git `http.extraHeader` value. Never logged: it carries the token. */
    readonly header: string;
    /** What the deployment log calls whoever this is. */
    readonly as: string;
}

/**
 * Who a clone of `owner`'s repository goes out as, resolved the background way:
 * the project owner's own account first, the App installation second, and null
 * for a clone that goes out as nobody.
 *
 * The name comes back with the header because the deployment log needs it. A
 * build that reached a private repository unauthenticated fails with git asking
 * a terminal that does not exist for a username, and the only thing anybody can
 * tell from that is that something went wrong somewhere - whereas a line saying
 * which account it used, written before the attempt, answers it in advance.
 */
export async function githubCloneIdentity(
    userId: string | null,
    owner?: string
): Promise<CloneIdentity | null> {
    if (userId) {
        const personal = await credentialForUser(userId, owner).catch(() => null);
        const header = cloneAuthHeader(personal?.token ?? null);
        if (personal && header) return { header, as: personal.login };
    }
    const installed = await githubAppInstallationToken(owner).catch(() => null);
    const header = cloneAuthHeader(installed);
    return header ? { header, as: "the GitHub App installed on this Polaris" } : null;
}

/**
 * The token behind one link, refreshed when it has aged out.
 *
 * GitHub only issues refresh tokens for apps set to expire user tokens; the rest
 * hold an access token that keeps working, which is why an absent expiry is not
 * treated as an expired one.
 */
async function usableToken(connectionId: string): Promise<string | null> {
    const credential = await readCredential(connectionId);
    if (!credential) return null;
    if (credential.token) return credential.token;
    if (!credential.accessToken && !credential.refreshToken) return null;

    const fresh = credential.expiresAt === undefined || credential.expiresAt > Date.now();
    if (fresh && credential.accessToken) return credential.accessToken;
    if (!credential.refreshToken) return null;

    const renewed = await refreshGithubUserToken(credential.refreshToken);
    await updateCredential(connectionId, {
        accessToken: renewed.accessToken,
        ...(renewed.refreshToken ? { refreshToken: renewed.refreshToken } : { refreshToken: credential.refreshToken }),
        ...(renewed.expiresAt ? { expiresAt: renewed.expiresAt } : {})
    });
    return renewed.accessToken;
}
