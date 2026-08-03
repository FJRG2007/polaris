/**
 * GitHub integration. Instance-wide, stored as the `github` Integration row.
 *
 * Two connection methods share one repo-listing / clone-auth surface, so callers
 * (the Deploy picker, the build clone) never learn which is in use:
 *  - "pat": a Personal Access Token. config = { method, login }; the token is the
 *    encrypted secret. Simplest to set up.
 *  - "app": a GitHub App, created in one click via the App Manifest flow (or an
 *    existing app pasted in). config = { method, appId, appName, htmlUrl,
 *    clientId, installations[] }; the secret is a JSON bundle { pem, clientSecret,
 *    webhookSecret }. Repo access and clone tokens are minted per installation.
 *    This is the path the future build/webhook system builds on.
 */

import { createHmac, createSign, timingSafeEqual } from "node:crypto";
import { getIntegrationSecret, getIntegrationState, upsertIntegration } from "./integration-service";

const PROVIDER = "github";
const API = "https://api.github.com";

export interface GithubStatus {
    connected: boolean;
    method: "pat" | "app" | null;
    login: string | null;
    /** App method: the accounts/orgs the app is installed on. */
    installations: string[];
    /** App method: the app's GitHub page, for the Install button. */
    htmlUrl: string | null;
}

export interface GithubRepo {
    /** owner/name */
    fullName: string;
    defaultBranch: string;
    private: boolean;
}

interface Installation {
    id: number;
    login: string;
    /** The permissions this installation was granted, as GitHub reports them.
     *  Recorded so Polaris can say which capability is missing before a call
     *  fails, rather than surfacing a bare 403. Absent on rows written before
     *  runner support existed; a refresh fills them in. */
    permissions?: Record<string, string>;
    /** "Organization" or "User", which decides whether org-level runner
     *  registration is even possible for it. */
    accountType?: string;
}

interface AppSecrets {
    appId: string;
    pem: string;
    clientSecret?: string;
    webhookSecret?: string;
}

/** Common headers for a token-authenticated GitHub REST call. */
function apiHeaders(token: string): HeadersInit {
    return {
        Authorization: `Bearer ${token}`,
        Accept: "application/vnd.github+json",
        "X-GitHub-Api-Version": "2022-11-28",
        "User-Agent": "polaris"
    };
}

/** Headers for a call that also works signed out. The stored credentials are used
 *  when there are any, which both reaches private repositories and lifts the far
 *  lower anonymous rate limit. */
function optionalAuthHeaders(token: string | null): HeadersInit {
    if (token) return apiHeaders(token);
    return {
        Accept: "application/vnd.github+json",
        "X-GitHub-Api-Version": "2022-11-28",
        "User-Agent": "polaris"
    };
}

// --- Personal Access Token method ------------------------------------------
//
// No longer something an administrator can connect: a personal token speaks for
// one person, and connecting one instance-wide let everybody here list and clone
// that person's repositories. People connect their own under Connected accounts.
// What remains is the reader, so a token connected before that stays usable
// until it has been handed back to its owner (see adopt-github-pat).

/** The stored PAT (pat method only), or null. */
async function getPatToken(): Promise<string | null> {
    const state = await getIntegrationState(PROVIDER);
    if (state?.config.method !== "pat") return null;
    return getIntegrationSecret(PROVIDER);
}

// --- GitHub App method ------------------------------------------------------

/** Sign a short-lived app JWT (RS256) as required for app-level GitHub calls. */
function appJwt(appId: string, pem: string): string {
    const now = Math.floor(Date.now() / 1000);
    const header = Buffer.from(JSON.stringify({ alg: "RS256", typ: "JWT" })).toString("base64url");
    // iat backdated 60s to tolerate clock skew; GitHub caps exp at 10 minutes.
    const payload = Buffer.from(JSON.stringify({ iat: now - 60, exp: now + 540, iss: appId })).toString("base64url");
    const data = `${header}.${payload}`;
    const signature = createSign("RSA-SHA256").update(data).sign(pem).toString("base64url");
    return `${data}.${signature}`;
}

/** The app id + private key bundle (app method only), or null. */
async function getAppSecrets(): Promise<AppSecrets | null> {
    const state = await getIntegrationState(PROVIDER);
    if (state?.config.method !== "app") return null;
    const raw = await getIntegrationSecret(PROVIDER);
    if (!raw) return null;
    let parsed: { pem?: string; clientSecret?: string; webhookSecret?: string };
    try {
        parsed = JSON.parse(raw);
    } catch {
        return null;
    }
    const appId = String(state.config.appId ?? "");
    if (!parsed.pem || !appId) return null;
    return { appId, pem: parsed.pem, clientSecret: parsed.clientSecret, webhookSecret: parsed.webhookSecret };
}

/** Mint a short-lived installation access token used to reach that installation's repos. */
async function installationToken(installationId: number, appId: string, pem: string): Promise<string> {
    const res = await fetch(`${API}/app/installations/${installationId}/access_tokens`, {
        method: "POST",
        headers: apiHeaders(appJwt(appId, pem)),
        cache: "no-store"
    });
    if (!res.ok) throw new Error(`GitHub returned ${res.status} minting an installation token`);
    const body = (await res.json()) as { token?: string };
    if (!body.token) throw new Error("GitHub did not return an installation token");
    return body.token;
}

/** Every account/org the app is installed on. Validates the pem (it signs the JWT). */
async function fetchInstallations(appId: string, pem: string): Promise<Installation[]> {
    const res = await fetch(`${API}/app/installations?per_page=100`, {
        headers: apiHeaders(appJwt(appId, pem)),
        cache: "no-store"
    });
    if (res.status === 401) throw new Error("GitHub rejected the app credentials (check the App ID and private key)");
    if (!res.ok) throw new Error(`GitHub returned ${res.status} listing installations`);
    const body = (await res.json()) as Array<{
        id: number;
        account?: { login?: string; type?: string };
        permissions?: Record<string, string>;
    }>;
    return body.map((row) => ({
        id: row.id,
        login: row.account?.login ?? "",
        permissions: row.permissions ?? {},
        accountType: row.account?.type
    }));
}

/** Where GitHub sends somebody back after they authorize Polaris as themselves.
 *  Registered on the app at creation, because a user authorization with no
 *  callback registered is one GitHub refuses. */
export function githubLinkCallbackUrl(baseUrl: string): string {
    return `${baseUrl}/api/integrations/github/link/callback`;
}

/** The manifest describing the app GitHub will create for this Polaris instance. */
export function buildAppManifest(baseUrl: string, name: string): Record<string, unknown> {
    return {
        name,
        url: baseUrl,
        // Where a person is returned to after linking their own GitHub account to
        // their Polaris one, which is what lets a runner pool serve "these
        // people's repositories" without anybody typing a login for them.
        callback_urls: [githubLinkCallbackUrl(baseUrl)],
        // Webhooks are inactive until the build system needs them; the URL is set so
        // enabling them later needs no app edit.
        // Push events drive auto-deploy; workflow_job tells the runner pools which
        // repository has work waiting. GitHub must be able to reach this URL, so it
        // only fires for instances with a public domain (LAN installs use polling).
        hook_attributes: { url: `${baseUrl}/api/deploy/github/webhook`, active: true },
        default_events: ["push", "workflow_job"],
        redirect_url: `${baseUrl}/api/integrations/github/callback`,
        setup_url: `${baseUrl}/api/integrations/github/callback`,
        setup_on_update: true,
        public: false,
        default_permissions: { contents: "read", metadata: "read" }
    };
}

/** Where the manifest form POSTs to create the app under the user's account. */
export const GITHUB_APP_NEW_URL = "https://github.com/settings/apps/new";

/**
 * Exchange the temporary code from the manifest redirect for the created app's
 * credentials and store them. Returns the app page URL so the caller can send the
 * user to install it.
 */
export async function exchangeManifestCode(code: string): Promise<{ htmlUrl: string }> {
    const res = await fetch(`${API}/app-manifests/${encodeURIComponent(code)}/conversions`, {
        method: "POST",
        headers: { Accept: "application/vnd.github+json", "User-Agent": "polaris", "X-GitHub-Api-Version": "2022-11-28" },
        cache: "no-store"
    });
    if (!res.ok) throw new Error(`GitHub returned ${res.status} creating the app`);
    const body = (await res.json()) as {
        id: number;
        slug: string;
        name: string;
        client_id: string;
        client_secret: string;
        webhook_secret: string | null;
        pem: string;
        html_url: string;
    };
    await upsertIntegration(PROVIDER, {
        enabled: true,
        config: {
            method: "app",
            appId: String(body.id),
            appSlug: body.slug,
            appName: body.name,
            htmlUrl: body.html_url,
            clientId: body.client_id,
            installations: []
        },
        secret: JSON.stringify({
            pem: body.pem,
            clientSecret: body.client_secret,
            webhookSecret: body.webhook_secret ?? undefined
        })
    });
    return { htmlUrl: body.html_url };
}

/** Connect an existing GitHub App by its id + private key (validated by listing installations). */
export async function connectGithubApp(input: {
    appId: string;
    pem: string;
    appName?: string;
    htmlUrl?: string;
    clientId?: string;
    clientSecret?: string;
    webhookSecret?: string;
}): Promise<{ installations: number }> {
    const appId = input.appId.trim();
    const pem = input.pem.trim();
    if (!appId || !pem) throw new Error("An App ID and private key are required");
    const installations = await fetchInstallations(appId, pem);
    await upsertIntegration(PROVIDER, {
        enabled: true,
        config: {
            method: "app",
            appId,
            appName: input.appName?.trim() || `App ${appId}`,
            htmlUrl: input.htmlUrl,
            clientId: input.clientId?.trim() || undefined,
            installations
        },
        secret: JSON.stringify({ pem, clientSecret: input.clientSecret, webhookSecret: input.webhookSecret })
    });
    return { installations: installations.length };
}

// --- Authorizing as a person, rather than as the installation ----------------

/**
 * The app's OAuth client, which is what lets somebody prove to Polaris which
 * GitHub account is theirs. Present only for the App method, and only when the app
 * was created through Polaris or its client credentials were pasted in - an app
 * connected with nothing but an id and a private key can act on repositories but
 * cannot ask anybody who they are.
 */
export async function getGithubUserAuth(): Promise<{ clientId: string; clientSecret: string } | null> {
    const state = await getIntegrationState(PROVIDER);
    if (state?.config.method !== "app") return null;
    const clientId = typeof state.config.clientId === "string" ? state.config.clientId : "";
    const secrets = await getAppSecrets();
    if (!clientId || !secrets?.clientSecret) return null;
    return { clientId, clientSecret: secrets.clientSecret };
}

/** One GitHub account, as GitHub describes it to a token issued for that person. */
export interface GithubAccount {
    /** GitHub's numeric id. The identity that survives a rename. */
    id: number;
    login: string;
    avatarUrl: string | null;
    /** The account's public address, when it has one. GitHub only lets a verified
     *  address be published, so this is one GitHub has proved - but most accounts
     *  publish none, which is why nothing here depends on it. */
    email: string | null;
}

/** A user-to-server token, as GitHub issues it. The refresh token and expiry are
 *  present only when the app was set to expire user tokens; without them the
 *  access token simply keeps working. */
export interface GithubUserToken {
    accessToken: string;
    refreshToken?: string;
    /** Epoch milliseconds the access token stops being accepted at. */
    expiresAt?: number;
    scope: string;
}

/**
 * Turn the code GitHub handed back into the account that authorized it, and the
 * token that speaks for them.
 *
 * The token is kept, unlike before: it is what lists the repositories that
 * person - and nobody else on this Polaris - can reach. Acting on those
 * repositories is still done with the installation's own credentials, so a
 * build keeps working after somebody's token expires.
 */
export async function authorizeGithubUser(
    code: string,
    redirectUri: string
): Promise<{ account: GithubAccount; token: GithubUserToken }> {
    const auth = await getGithubUserAuth();
    if (!auth) throw new Error("This GitHub connection cannot verify accounts");

    const token = await exchangeUserToken(auth, {
        code,
        redirect_uri: redirectUri,
        grant_type: "authorization_code"
    });
    return { account: await readGithubAccount(token.accessToken), token };
}

/**
 * Trade a refresh token for a fresh access token. Only apps set to expire user
 * tokens ever reach this; the rest hold one that keeps working.
 */
export async function refreshGithubUserToken(refreshToken: string): Promise<GithubUserToken> {
    const auth = await getGithubUserAuth();
    if (!auth) throw new Error("This GitHub connection cannot refresh accounts");
    return exchangeUserToken(auth, { refresh_token: refreshToken, grant_type: "refresh_token" });
}

/** The account a user token speaks for. */
export async function readGithubAccount(token: string): Promise<GithubAccount> {
    const res = await fetch(`${API}/user`, { headers: apiHeaders(token), cache: "no-store" });
    if (res.status === 401) throw new Error("GitHub rejected the token (unauthorized)");
    if (!res.ok) throw new Error(`GitHub returned ${res.status} reading the account`);
    const body = (await res.json()) as { id?: number; login?: string; avatar_url?: string; email?: string | null };
    if (typeof body.id !== "number" || !body.login) throw new Error("GitHub did not return an account");
    return {
        id: body.id,
        login: body.login,
        avatarUrl: body.avatar_url ?? null,
        email: typeof body.email === "string" && body.email.includes("@") ? body.email.trim().toLowerCase() : null
    };
}

async function exchangeUserToken(
    auth: { clientId: string; clientSecret: string },
    fields: Record<string, string>
): Promise<GithubUserToken> {
    const exchange = await fetch("https://github.com/login/oauth/access_token", {
        method: "POST",
        headers: { Accept: "application/json", "content-type": "application/json", "User-Agent": "polaris" },
        body: JSON.stringify({ ...fields, client_id: auth.clientId, client_secret: auth.clientSecret }),
        cache: "no-store"
    });
    if (!exchange.ok) throw new Error(`GitHub returned ${exchange.status} verifying the account`);
    const granted = (await exchange.json()) as {
        access_token?: string;
        refresh_token?: string;
        expires_in?: number;
        scope?: string;
        error_description?: string;
        error?: string;
    };
    if (!granted.access_token) {
        throw new Error(granted.error_description ?? granted.error ?? "GitHub declined the authorization");
    }
    return {
        accessToken: granted.access_token,
        refreshToken: granted.refresh_token,
        // A minute of headroom, so a token is never spent on the request that
        // discovers it has just expired.
        ...(granted.expires_in ? { expiresAt: Date.now() + granted.expires_in * 1000 - 60_000 } : {}),
        scope: granted.scope ?? ""
    };
}

/** Refresh the stored installation list (call after the user installs the app). */
export async function refreshInstallations(): Promise<void> {
    const secrets = await getAppSecrets();
    if (!secrets) return;
    const installations = await fetchInstallations(secrets.appId, secrets.pem);
    const state = await getIntegrationState(PROVIDER);
    await upsertIntegration(PROVIDER, { config: { ...(state?.config ?? {}), installations } });
}

// --- Shared surface ---------------------------------------------------------

/** Public connection state for the UI (never exposes secrets). */
export async function getGithubStatus(): Promise<GithubStatus> {
    const state = await getIntegrationState(PROVIDER);
    if (!state?.hasSecret) return { connected: false, method: null, login: null, installations: [], htmlUrl: null };
    if (state.config.method === "app") {
        const installs = Array.isArray(state.config.installations) ? (state.config.installations as Installation[]) : [];
        return {
            connected: true,
            method: "app",
            login: typeof state.config.appName === "string" ? state.config.appName : null,
            installations: installs.map((row) => row.login).filter(Boolean),
            htmlUrl: typeof state.config.htmlUrl === "string" ? state.config.htmlUrl : null
        };
    }
    return {
        connected: true,
        method: "pat",
        login: typeof state.config.login === "string" ? state.config.login : null,
        installations: [],
        htmlUrl: null
    };
}

/**
 * The App installations as last recorded, with the permissions each was granted.
 * Runner registration reads these to say which capability is missing before it
 * makes a call that would 403. Empty for the PAT method, which has no
 * installations.
 */
export async function listGithubInstallations(): Promise<
    Array<{ login: string; accountType?: string; permissions: Record<string, string> }>
> {
    const state = await getIntegrationState(PROVIDER);
    if (state?.config.method !== "app") return [];
    const installs = Array.isArray(state.config.installations) ? (state.config.installations as Installation[]) : [];
    return installs.map((install) => ({
        login: install.login,
        accountType: install.accountType,
        permissions: install.permissions ?? {}
    }));
}

/** Forget the GitHub connection and its secret(s). */
export async function disconnectGithub(): Promise<void> {
    await upsertIntegration(PROVIDER, { enabled: false, config: {}, secret: null });
}

/** Deduplicate repos by full name, keeping first seen. */
function dedupeRepos(repos: GithubRepo[]): GithubRepo[] {
    const seen = new Set<string>();
    const unique: GithubRepo[] = [];
    for (const repo of repos) {
        if (seen.has(repo.fullName)) continue;
        seen.add(repo.fullName);
        unique.push(repo);
    }
    return unique;
}

function toRepo(row: { full_name: string; default_branch: string; private: boolean }): GithubRepo {
    return { fullName: row.full_name, defaultBranch: row.default_branch || "main", private: row.private };
}

/**
 * Repositories a personal access token reaches, most-recently-pushed first.
 * Capped by GitHub's page size to keep the picker snappy; the deploy UI also
 * accepts a manual URL for anything past that.
 */
export async function listReposForPat(token: string): Promise<GithubRepo[]> {
    const url = `${API}/user/repos?per_page=100&sort=pushed&affiliation=owner,collaborator,organization_member`;
    const res = await fetch(url, { headers: apiHeaders(token), cache: "no-store" });
    if (!res.ok) throw new Error(`GitHub returned ${res.status} listing repositories`);
    const body = (await res.json()) as Array<{ full_name: string; default_branch: string; private: boolean }>;
    return body.map(toRepo);
}

/**
 * Repositories a person reaches through this app, asked as them.
 *
 * This is the answer that differs per account and the reason user tokens are
 * kept at all: GitHub intersects what the app was installed on with what that
 * person can see, so somebody who is not on an organization never learns its
 * repositories exist - which listing them with the app's own credentials would
 * have told them.
 */
export async function listReposForUserToken(token: string): Promise<GithubRepo[]> {
    const res = await fetch(`${API}/user/installations?per_page=100`, {
        headers: apiHeaders(token),
        cache: "no-store"
    });
    if (res.status === 401) throw new Error("GitHub rejected the token (unauthorized)");
    if (!res.ok) throw new Error(`GitHub returned ${res.status} listing installations`);
    const body = (await res.json()) as { installations?: Array<{ id: number }> };

    const repos: GithubRepo[] = [];
    for (const install of body.installations ?? []) {
        const page = await fetch(`${API}/user/installations/${install.id}/repositories?per_page=100`, {
            headers: apiHeaders(token),
            cache: "no-store"
        });
        if (!page.ok) continue;
        const listed = (await page.json()) as {
            repositories?: Array<{ full_name: string; default_branch: string; private: boolean }>;
        };
        repos.push(...(listed.repositories ?? []).map(toRepo));
    }
    return dedupeRepos(repos);
}

/**
 * Every repository one account owns, as far as this connection can see it.
 *
 * Where the App is installed on that account this is the installation's own list,
 * which includes the private repositories it was given. Otherwise it falls back to
 * the account's public repositories, authenticated when there are credentials only
 * because the rate limit is higher - the answer is the same either way.
 *
 * Ordered most recently pushed first and capped, so a scope pointed at an account
 * with hundreds of repositories takes the ones anybody is actually working in.
 *
 * `asToken` is the credential of whoever the scope names, when they have linked
 * one: their own account is the most accurate answer for "their repositories",
 * and it is used before the installation's.
 */
export async function listReposForOwner(login: string, limit = 100, asToken?: string | null): Promise<GithubRepo[]> {
    const owner = login.trim();
    if (!owner) return [];

    if (asToken) {
        const mine = await listReposForUserToken(asToken).catch(() => null);
        if (mine) {
            const theirs = mine.filter((repo) => repo.fullName.split("/")[0]?.toLowerCase() === owner.toLowerCase());
            if (theirs.length > 0) return theirs.slice(0, limit);
        }
    }

    const state = await getIntegrationState(PROVIDER);

    if (state?.config.method === "app") {
        const secrets = await getAppSecrets();
        const installs = Array.isArray(state.config.installations) ? (state.config.installations as Installation[]) : [];
        const install = installs.find((row) => row.login.toLowerCase() === owner.toLowerCase());
        if (secrets && install) {
            const token = await installationToken(install.id, secrets.appId, secrets.pem);
            const res = await fetch(`${API}/installation/repositories?per_page=100`, {
                headers: apiHeaders(token),
                cache: "no-store"
            });
            if (res.ok) {
                const body = (await res.json()) as {
                    repositories?: Array<{ full_name: string; default_branch: string; private: boolean }>;
                };
                return (body.repositories ?? [])
                    .filter((repo) => repo.full_name.split("/")[0]?.toLowerCase() === owner.toLowerCase())
                    .slice(0, limit)
                    .map((repo) => ({
                        fullName: repo.full_name,
                        defaultBranch: repo.default_branch || "main",
                        private: repo.private
                    }));
            }
        }
    }

    const res = await fetch(
        `${API}/users/${encodeURIComponent(owner)}/repos?per_page=100&type=owner&sort=pushed`,
        { headers: optionalAuthHeaders(await apiToken(owner)), cache: "no-store" }
    );
    if (!res.ok) return [];
    const body = (await res.json()) as Array<{
        full_name: string;
        default_branch: string;
        private: boolean;
        archived?: boolean;
    }>;
    return body
        .filter((repo) => repo.archived !== true)
        .slice(0, limit)
        .map((repo) => ({
            fullName: repo.full_name,
            defaultBranch: repo.default_branch || "main",
            private: repo.private
        }));
}

/**
 * One repository by name, or null when GitHub does not serve it to whoever is
 * asking - which is the same answer for "no such repository" and "private, and
 * not one of yours", exactly as GitHub reports it.
 *
 * The token is the caller's, never the instance's: resolving a name with shared
 * credentials would confirm the existence of a private repository to somebody who
 * cannot reach it, and then let them deploy it.
 */
export async function resolveGithubRepo(owner: string, repo: string, token: string | null): Promise<GithubRepo | null> {
    const url = `${API}/repos/${encodeURIComponent(owner)}/${encodeURIComponent(repo)}`;
    const res = await fetch(url, { headers: optionalAuthHeaders(token), cache: "no-store" });
    if (!res.ok) return null;
    const body = (await res.json()) as { full_name: string; default_branch: string; private: boolean };
    return {
        fullName: body.full_name,
        defaultBranch: body.default_branch || "main",
        private: body.private
    };
}

/**
 * Public repositories matching a phrase, best match first. GitHub's search index
 * only covers public repositories however the call is authenticated, so private
 * ones are reached through the caller's own list instead; a token is still passed
 * because it triples the searches allowed per minute.
 */
export async function searchGithubRepos(query: string, token: string | null, limit = 8): Promise<GithubRepo[]> {
    const term = query.trim();
    if (term.length < 2) return [];
    const url = `${API}/search/repositories?q=${encodeURIComponent(term)}&per_page=${limit}`;
    const res = await fetch(url, { headers: optionalAuthHeaders(token), cache: "no-store" });
    if (!res.ok) return [];
    const body = (await res.json()) as {
        items?: Array<{ full_name: string; default_branch: string; private: boolean }>;
    };
    return (body.items ?? []).map((item) => ({
        fullName: item.full_name,
        defaultBranch: item.default_branch || "main",
        private: item.private
    }));
}

/** An API token for REST calls scoped to `owner` (installation token for the App
 *  method, the PAT otherwise), or null when not connected / for a public call.
 *  Exported so sibling modules (runner registration) authenticate the same way
 *  instead of each learning which method is in use. */
export async function githubApiToken(owner?: string): Promise<string | null> {
    return apiToken(owner);
}

/**
 * An installation token for `owner`, or null when this instance is not connected
 * through a GitHub App.
 *
 * This is the only instance-wide credential anything acts on somebody else's
 * behalf with. An installation is a grant an administrator deliberately put on a
 * set of repositories, which a personal token connected to the same row is not -
 * so work with nobody watching uses this and never the token.
 */
export async function githubAppInstallationToken(owner?: string): Promise<string | null> {
    const state = await getIntegrationState(PROVIDER);
    if (!state?.hasSecret || state.config.method !== "app") return null;
    const secrets = await getAppSecrets();
    if (!secrets) return null;
    const installs = Array.isArray(state.config.installations) ? (state.config.installations as Installation[]) : [];
    const inst = (owner && installs.find((row) => row.login.toLowerCase() === owner.toLowerCase())) || installs[0];
    if (!inst) return null;
    return installationToken(inst.id, secrets.appId, secrets.pem);
}

async function apiToken(owner?: string): Promise<string | null> {
    const state = await getIntegrationState(PROVIDER);
    if (!state?.hasSecret) return null;
    if (state.config.method === "app") return githubAppInstallationToken(owner);
    return getPatToken();
}

export interface RepoInspection {
    /** Path to a Dockerfile in the repo, or null if none was found. */
    dockerfile: string | null;
    /** Detected stack/framework (informational), or null. */
    framework: string | null;
    /** The build strategy to default to. */
    builder: "dockerfile" | "nixpacks";
}

/** Framework hints keyed by a package.json dependency name. */
const JS_FRAMEWORKS: Array<[string, string]> = [
    ["next", "Next.js"],
    ["nuxt", "Nuxt"],
    ["@remix-run/react", "Remix"],
    ["astro", "Astro"],
    ["@angular/core", "Angular"],
    ["@sveltejs/kit", "SvelteKit"],
    ["vue", "Vue"],
    ["react", "React"],
    ["vite", "Vite"],
    ["express", "Express"],
    ["fastify", "Fastify"]
];

/**
 * Inspect a repo to auto-configure a deploy: find a Dockerfile and detect the
 * framework (like Vercel/Railway) so the build needs no Dockerfile. Best-effort -
 * returns nulls on any API hiccup and defaults to a nixpacks (auto) build.
 *
 * Reads the tree as whoever asked, for the same reason resolving a name does: the
 * file list of a private repository is its contents by another route.
 */
export async function inspectGithubRepo(
    owner: string,
    repo: string,
    branch: string,
    token: string | null
): Promise<RepoInspection> {
    const headers = optionalAuthHeaders(token);

    let paths: string[] = [];
    try {
        const res = await fetch(
            `${API}/repos/${owner}/${repo}/git/trees/${encodeURIComponent(branch)}?recursive=1`,
            { headers, cache: "no-store" }
        );
        if (res.ok) {
            const body = (await res.json()) as { tree?: Array<{ path?: string; type?: string }> };
            paths = (body.tree ?? []).filter((entry) => entry.type === "blob").map((entry) => entry.path ?? "");
        }
    } catch {
        // fall through with no paths
    }

    const dockerfile = paths.find((p) => p === "Dockerfile") ?? paths.find((p) => p.endsWith("/Dockerfile")) ?? null;
    const has = (name: string) => paths.some((p) => p === name || p.endsWith(`/${name}`));

    let framework: string | null = null;
    if (paths.includes("package.json")) {
        framework = "Node.js";
        try {
            const res = await fetch(
                `${API}/repos/${owner}/${repo}/contents/package.json?ref=${encodeURIComponent(branch)}`,
                { headers, cache: "no-store" }
            );
            if (res.ok) {
                const body = (await res.json()) as { content?: string };
                const json = body.content
                    ? (JSON.parse(Buffer.from(body.content, "base64").toString("utf8")) as {
                          dependencies?: Record<string, string>;
                          devDependencies?: Record<string, string>;
                      })
                    : {};
                const deps = { ...json.dependencies, ...json.devDependencies };
                const match = JS_FRAMEWORKS.find(([dep]) => dep in deps);
                if (match) framework = match[1];
            }
        } catch {
            // keep the generic Node.js label
        }
    } else if (has("requirements.txt") || has("pyproject.toml") || has("Pipfile")) framework = "Python";
    else if (has("go.mod")) framework = "Go";
    else if (has("Cargo.toml")) framework = "Rust";
    else if (has("Gemfile")) framework = "Ruby";
    else if (has("composer.json")) framework = "PHP";
    else if (has("pom.xml") || has("build.gradle")) framework = "Java";

    return { dockerfile, framework, builder: dockerfile ? "dockerfile" : "nixpacks" };
}

/**
 * A git basic-auth header value that authenticates a clone with `token`, or null
 * when there is none and the clone is a public one. Used as `http.extraHeader` so
 * the token never appears in the clone URL or the deployment log. GitHub reads the
 * token from the password field regardless of the username.
 */
export function cloneAuthHeader(token: string | null): string | null {
    if (!token) return null;
    return `Authorization: Basic ${Buffer.from(`x-access-token:${token}`).toString("base64")}`;
}

/**
 * Latest commit (sha + message) on a repo's branch, used by the auto-deploy
 * poller. A connected token authenticates the call (required for private repos);
 * a public repo also resolves unauthenticated. Null on any error, so a poll tick
 * simply skips this repo rather than failing.
 */
export interface CommitInfo {
    sha: string;
    message: string;
    /** Commit author's display name (GitHub login or the git author name). */
    authorName: string | null;
    /** Commit author's GitHub avatar URL, when the author is a GitHub user. */
    authorAvatarUrl: string | null;
}

export async function getLatestCommit(
    owner: string,
    repo: string,
    ref: string,
    token: string | null
): Promise<CommitInfo | null> {
    const headers = optionalAuthHeaders(token);
    try {
        const res = await fetch(`${API}/repos/${owner}/${repo}/commits/${encodeURIComponent(ref)}`, {
            headers,
            cache: "no-store"
        });
        if (!res.ok) return null;
        const data = (await res.json()) as {
            sha?: string;
            commit?: { message?: string; author?: { name?: string } };
            author?: { login?: string; avatar_url?: string } | null;
        };
        if (!data.sha) return null;
        return {
            sha: data.sha,
            message: data.commit?.message ?? "",
            authorName: data.author?.login ?? data.commit?.author?.name ?? null,
            authorAvatarUrl: data.author?.avatar_url ?? null
        };
    } catch {
        return null;
    }
}

/** The GitHub App's webhook secret (app method only), used to verify push events. */
export async function getGithubWebhookSecret(): Promise<string | null> {
    const secrets = await getAppSecrets();
    return secrets?.webhookSecret ?? null;
}

/** Constant-time verification of a GitHub webhook signature ("sha256=<hex>"). */
export function verifyWebhookSignature(secret: string, payload: string, signature: string): boolean {
    const expected = `sha256=${createHmac("sha256", secret).update(payload).digest("hex")}`;
    const a = Buffer.from(signature);
    const b = Buffer.from(expected);
    return a.length === b.length && timingSafeEqual(a, b);
}
