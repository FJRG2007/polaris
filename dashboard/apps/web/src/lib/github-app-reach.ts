/**
 * Why a linked GitHub account cannot reach a repository it can see on GitHub.
 *
 * A GitHub link made through Polaris's App is a user access token, and GitHub
 * limits that token three ways at once: to what the person can see, to what the
 * App was granted, and to the accounts the App is installed on. The third is the
 * one nobody expects - somebody who opens an organization's private repository
 * in the browser every day gets a 404 for it here until the App is installed on
 * that organization. So a refusal is followed by one question to GitHub, asked
 * as the same person: is the App installed on that owner at all, and if it is
 * on selected repositories only, is this one of them?
 *
 * Sources (docs.github.com):
 * - apps/creating-github-apps/authenticating-with-a-github-app/authenticating-with-a-github-app-on-behalf-of-a-user
 *   ("The app can reach resources only in accounts where it is installed").
 * - rest/apps/installations: GET /user/installations (installations this user
 *   can access, each with `account`, `repository_selection` and `html_url`) and
 *   GET /user/installations/{id}/repositories, both paged with per_page <= 100.
 * - apps/using-github-apps/installing-a-github-app-from-a-third-party: the
 *   install page is https://github.com/apps/<app>/installations/new; an
 *   organization member who may not install it gets a Request button there and
 *   GitHub asks an organization owner to approve.
 * The `.../installations/new/permissions?target_id=<id>` address that jumps
 * straight to one account is not documented, so it is not used: the documented
 * page lets the person pick the owner themselves.
 *
 * Asked only after a read was refused. A token never leaves this module and is
 * never part of a cache key or a log line.
 *
 * Server-only.
 */

import { z } from "zod";
import {
    githubAppInstallUrl,
    githubAppIsPublic,
    githubAppVisibilityUrl
} from "@/lib/github-service";
import { CONNECTIONS_HUB } from "@/lib/connections/hub-href";
import {
    credentialFor,
    githubCredentialsForUser,
    type GithubCredential
} from "@/lib/github-access";

const API = "https://api.github.com";
const CALL_TIMEOUT_MS = 10_000;
/** Pages of installations, and of one installation's repositories, walked. */
const MOST_PAGES = 10;
/** How long an answer that lets the read through is kept. */
const FOUND_TTL_MS = 60_000;
/** How long an answer that says something is missing is kept: short, so the
 *  person who just installed the App and pressed Check again is asked afresh. */
const MISSING_TTL_MS = 5_000;
const CACHE_MOST = 500;

/** What stands between a linked account and one repository. */
export type GithubAppGap =
    | { kind: "no-account"; owner: string; url: string }
    | { kind: "app-missing"; owner: string; url: string | null }
    /** The App is private, so it can only be installed on the account that
     *  created it: whoever manages it has to make it public first. */
    | { kind: "app-private"; owner: string; url: string | null }
    | { kind: "repo-not-selected"; owner: string; repository: string; url: string | null };

const installationsPage = z.object({
    installations: z.array(
        z.object({
            id: z.number().int(),
            account: z.object({ login: z.string() }).passthrough().nullish(),
            repository_selection: z.enum(["all", "selected"]).catch("all"),
            html_url: z.string().nullish()
        })
    )
});

const repositoriesPage = z.object({
    repositories: z.array(z.object({ full_name: z.string() }))
});

type Installation = z.output<typeof installationsPage>["installations"][number];

const cache = new Map<string, { at: number; value: unknown }>();

/** Drops everything remembered. For tests. */
export function forgetGithubAppReach(): void {
    cache.clear();
}

function remembered<T>(key: string, ttl: number): T | undefined {
    const hit = cache.get(key);
    if (!hit) return undefined;
    if (Date.now() - hit.at > ttl) return undefined;
    return hit.value as T;
}

function remember(key: string, value: unknown): void {
    if (cache.size >= CACHE_MOST) {
        const oldest = cache.keys().next().value;
        if (oldest !== undefined) cache.delete(oldest);
    }
    cache.set(key, { at: Date.now(), value });
}

function ask(path: string, token: string): Promise<Response> {
    return fetch(`${API}${path}`, {
        headers: {
            Accept: "application/vnd.github+json",
            "X-GitHub-Api-Version": "2022-11-28",
            "User-Agent": "polaris",
            Authorization: `Bearer ${token}`
        },
        cache: "no-store",
        signal: AbortSignal.timeout(CALL_TIMEOUT_MS)
    });
}

async function getJson(path: string, token: string): Promise<unknown> {
    const response = await ask(path, token);
    if (!response.ok) throw new Error(`GitHub answered ${response.status}`);
    return response.json();
}

/** Every installation of the App this account can reach, paged through. */
async function installationsFor(credential: GithubCredential): Promise<Installation[]> {
    const all: Installation[] = [];
    for (let page = 1; page <= MOST_PAGES; page += 1) {
        const parsed = installationsPage.parse(
            await getJson(`/user/installations?per_page=100&page=${page}`, credential.token)
        );
        all.push(...parsed.installations);
        if (parsed.installations.length < 100) break;
    }
    return all;
}

/** Whether `fullName` is among the repositories one installation gives this account. */
async function installationHolds(
    credential: GithubCredential,
    installationId: number,
    fullName: string
): Promise<boolean> {
    const wanted = fullName.toLowerCase();
    for (let page = 1; page <= MOST_PAGES; page += 1) {
        const parsed = repositoriesPage.parse(
            await getJson(
                `/user/installations/${installationId}/repositories?per_page=100&page=${page}`,
                credential.token
            )
        );
        if (parsed.repositories.some((repo) => repo.full_name.toLowerCase() === wanted))
            return true;
        if (parsed.repositories.length < 100) break;
    }
    return false;
}

/** Whether GitHub knows an account called `owner`. Only a 404 says it does not. */
async function accountExists(credential: GithubCredential, owner: string): Promise<boolean> {
    const response = await ask(`/users/${encodeURIComponent(owner)}`, credential.token);
    return response.status !== 404;
}

/** Only GitHub's own pages are linked to. */
function githubPage(url: string | null | undefined): string | null {
    if (!url) return null;
    try {
        const parsed = new URL(url);
        return parsed.protocol === "https:" && parsed.hostname === "github.com"
            ? parsed.toString()
            : null;
    } catch {
        return null;
    }
}

/**
 * What keeps this person's linked account from `owner/repo`, or null when the
 * App is not the reason (or GitHub could not say): the caller's own sentence
 * stands then. `repo` is optional; without it only the owner is checked.
 */
export async function githubAppGap(
    userId: string,
    owner: string,
    repo?: string
): Promise<GithubAppGap | null> {
    const credentials = await githubCredentialsForUser(userId).catch(() => null);
    if (credentials === null) return null;
    const credential = credentialFor(credentials, owner);
    if (!credential) return { kind: "no-account", owner, url: CONNECTIONS_HUB };
    // A personal access token is not held to an installation.
    if (credential.method !== "oauth") return null;

    const fullName = repo ? `${owner}/${repo}` : "";
    const key = `${credential.connectionId}:${owner.toLowerCase()}:${fullName.toLowerCase()}`;
    const kept = remembered<GithubAppGap | "none">(key, FOUND_TTL_MS);
    if (kept === "none") return null;
    if (kept && remembered(key, MISSING_TTL_MS)) return kept;

    let gap: GithubAppGap | null;
    try {
        gap = await askGithub(credential, owner, fullName);
    } catch {
        // GitHub would not say. Unknown is reported as nothing rather than as
        // a step somebody has to take.
        return null;
    }
    remember(key, gap ?? "none");
    return gap;
}

async function askGithub(
    credential: GithubCredential,
    owner: string,
    fullName: string
): Promise<GithubAppGap | null> {
    const wanted = owner.toLowerCase();
    const installations = await installationsFor(credential);
    const installation = installations.find(
        (entry) => entry.account?.login.toLowerCase() === wanted
    );
    if (!installation) {
        if (!(await accountExists(credential, owner))) return null;
        // The App's own account is the one place a private App installs, and
        // it is never the owner missing here once it has an installation.
        if ((await githubAppIsPublic()) === false && installations.length > 0)
            return { kind: "app-private", owner, url: await githubAppVisibilityUrl() };
        return { kind: "app-missing", owner, url: await githubAppInstallUrl() };
    }
    if (!fullName || installation.repository_selection === "all") return null;
    if (await installationHolds(credential, installation.id, fullName)) return null;
    return {
        kind: "repo-not-selected",
        owner,
        repository: fullName,
        url: githubPage(installation.html_url)
    };
}

/** A gap the GitHub App causes: one an install or a repository choice fixes. */
export type GithubInstallGap = Exclude<GithubAppGap, { kind: "no-account" }>;

/**
 * The App gap for `owner/name`, for a screen about to clone or dispatch to it.
 * No linked account is not reported here: those screens fall back to the
 * credentials they always used, and refusing on it would break them.
 */
export async function githubInstallGapForRepo(
    userId: string,
    fullName: string
): Promise<GithubInstallGap | null> {
    const [owner, name, ...rest] = fullName.split("/");
    if (!owner || !name || rest.length > 0) return null;
    const gap = await githubAppGap(userId, owner, name).catch(() => null);
    return gap && gap.kind !== "no-account" ? gap : null;
}

/** The sentence for an App gap, in the reader's words, from the `agents` catalog. */
export function installGapKey(
    gap: GithubInstallGap
): "errors.githubAppMissing" | "errors.githubAppPrivate" | "errors.githubRepoNotSelected" {
    if (gap.kind === "app-missing") return "errors.githubAppMissing";
    if (gap.kind === "app-private") return "errors.githubAppPrivate";
    return "errors.githubRepoNotSelected";
}

/** The `agents` catalog key and its values for an App gap on `repoFullName`. */
export function installGapMessage(
    gap: GithubInstallGap,
    repoFullName: string
): {
    key: ReturnType<typeof installGapKey>;
    values: { owner: string; repository: string };
} {
    return {
        key: installGapKey(gap),
        values: {
            owner: gap.owner,
            repository: gap.kind === "repo-not-selected" ? gap.repository : repoFullName
        }
    };
}
