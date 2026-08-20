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

import { parseGithubRepo } from "@/lib/repo-reference";
import { noteConnectionRefused } from "@/lib/connections/health";
import { listConnections, readCredential, updateCredential } from "@/lib/connections/store";
import {
    cloneAuthHeader,
    githubAppInstallationToken,
    listReposForPat,
    listReposForUserToken,
    refreshGithubUserToken,
    repoAccessFor,
    resolveGithubRepo,
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
 * Why a clone that went out as a connected account was refused anyway, in terms
 * of what to go and do about it - or null when there is nothing more to add.
 *
 * The clone itself cannot tell these apart. Git sends the credential, GitHub
 * answers 401, git asks for a username, and there is no terminal to ask at: the
 * same three lines whether the token has expired, whether the account was never
 * given that repository, or whether an organization wants its SSO authorized.
 * They are three different things to go and do, so this asks GitHub which.
 *
 * Only ever called after a refusal. A deploy that works pays nothing for it.
 */
export async function githubCloneProblem(
    userId: string | null,
    owner: string,
    repo: string
): Promise<string | null> {
    const token = await githubTokenForOwner(userId, owner).catch(() => null);
    if (!token) return null;
    const access = await repoAccessFor(owner, repo, token);
    if (access === "token-refused") {
        return "GitHub no longer accepts that account: connect it again under Connected accounts.";
    }
    if (access === "out-of-reach") {
        return `That account cannot see ${owner}/${repo}. If it reaches GitHub through the Polaris app, the app has to be given this repository as well - the account itself owning it is not enough.`;
    }
    if (access === "sso-required") {
        return `${owner} requires that account to authorize single sign-on before anything may read its repositories.`;
    }
    if (access === "reachable") {
        return `That account can read ${owner}/${repo}, so the clone was refused over the credential rather than over access to it.`;
    }
    return null;
}

/**
 * Why this deploy cannot reach its own source, or null when it can.
 *
 * Asked before a deploy starts rather than discovered at the clone. Every answer
 * here is a sentence about something to go and do, because every one of them is:
 * the link ran out, the account was never given this repository, the
 * organization wants its single sign-on authorized.
 *
 * Silent about anything that is not GitHub's, and silent about a public
 * repository: a clone that needs no account is not a clone anybody has to
 * connect one for, and refusing it because nothing is linked would break every
 * deploy that has ever worked without a link.
 */
export async function githubRepoReach(userId: string | null, repoUrl: string): Promise<string | null> {
    const repo = parseGithubRepo(repoUrl);
    if (!repo) return null;

    const token = await githubTokenForOwner(userId, repo.owner).catch(() => null);
    // Nothing linked at all. Public repositories still deploy, which is what
    // they did before any of this existed; a private one is refused with the
    // thing to do about it.
    if (!token) {
        const open = await resolveGithubRepo(repo.owner, repo.repo, null).catch(() => null);
        return open
            ? null
            : `This deploy needs an account: ${repo.owner}/${repo.repo} is private, or it is not there. Connect the account that can see it under Connected accounts.`;
    }

    const access = await repoAccessFor(repo.owner, repo.repo, token);
    if (access === "reachable" || access === "unknown") return null;

    // A public repository is reachable whatever the token is worth, so a token
    // that has expired must not stop one deploying. It still stopped working,
    // and its owner is told either way.
    const open = await resolveGithubRepo(repo.owner, repo.repo, null).catch(() => null);
    if (access === "token-refused") {
        if (userId) await noteConnectionRefused(userId, PROVIDER).catch(() => undefined);
        return open
            ? null
            : "The GitHub account this deploy would clone with has stopped working. Connect it again under Connected accounts, then deploy again.";
    }
    if (open) return null;
    if (access === "sso-required") {
        return `${repo.owner} requires the connected account to authorize single sign-on before anything may read its repositories.`;
    }
    return `The connected GitHub account cannot see ${repo.owner}/${repo.repo}. If it reaches GitHub through the Polaris app, the app has to be given this repository as well - the account owning it is not enough.`;
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
