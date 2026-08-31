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

/**
 * What the App ITSELF currently asks for, as GitHub holds it.
 *
 * Not the same question as what an installation was granted, and the difference
 * is the one this whole area kept getting wrong. `APP_PERMISSIONS` is the set
 * Polaris wants; it is sent once, in the manifest that creates the App, and
 * GitHub publishes no way to change it afterwards - not by API, not by any URL
 * that accepts one. Only the App's owner can, by hand, on the App's own settings
 * page.
 *
 * So an App created before a permission was added to that list does not request
 * it, no installation is holding a request for it, and there is nothing anywhere
 * for anybody to accept. Polaris said "so-and-so has not granted Deployments"
 * and sent people to a page with no Review request on it, every few minutes,
 * forever. Reading this is what tells the two apart.
 */
async function fetchAppPermissions(appId: string, pem: string): Promise<Record<string, string> | null> {
    try {
        const res = await fetch(`${API}/app`, { headers: apiHeaders(appJwt(appId, pem)), cache: "no-store" });
        if (!res.ok) return null;
        const body = (await res.json()) as { permissions?: Record<string, string> };
        return body.permissions ?? null;
    } catch {
        // Unknown, which every reader below treats as "assume the App asks for
        // everything" - the state things were in before this existed, and the one
        // that cannot invent a step for somebody to take.
        return null;
    }
}

/** Where GitHub sends somebody back after they authorize Polaris as themselves.
 *  Registered on the app at creation, because a user authorization with no
 *  callback registered is one GitHub refuses. */
export function githubLinkCallbackUrl(baseUrl: string): string {
    return `${baseUrl}/api/integrations/github/link/callback`;
}

/** The single webhook URL a GitHub App has. Everything Polaris listens for arrives
 *  here: push drives auto-deploy, workflow_job tells the runner pools which
 *  repository has work waiting, and the rest are what start an agent run. */
export function githubWebhookUrl(baseUrl: string): string {
    return `${baseUrl}/api/deploy/github/webhook`;
}

/**
 * The manifest describing the app GitHub will create for this Polaris instance.
 *
 * Two addresses, because two different parties follow them. `origin` is where the
 * administrator's browser is right now, so it is what the redirect back has to land
 * on - that is the only host the CSRF cookie was set for. `publicUrl` is where
 * GitHub's own servers can reach this instance, and it is null on a LAN-only one.
 *
 * A webhook URL GitHub cannot resolve does not merely sit idle: GitHub validates it
 * while reading the manifest and refuses the whole thing ("Hook url is not supported
 * because it isn't reachable over the public Internet"), so no app is created at all.
 * The subscription is therefore declared only when there is a public address. Without
 * one the app is created with no webhook, which is what a LAN install can have: Deploy
 * and the runner pools already poll, and the URL can be filled in on GitHub once the
 * instance has a domain.
 */
export function buildAppManifest(input: {
    name: string;
    origin: string;
    publicUrl: string | null;
    linkOrigin?: string | null;
}): Record<string, unknown> {
    const { name, origin, publicUrl, linkOrigin } = input;
    // Where a person is returned to after linking their own GitHub account to their
    // Polaris one, which is what lets a runner pool serve "these people's
    // repositories" without anybody typing a login for them. Every address that
    // round trip can run on is registered, because GitHub refuses a callback it was
    // not told about: the one this app is being created from, the one the internet
    // reaches this instance at, and the one linking actually uses - which is the
    // deployment's own address rather than whichever name this browser is on.
    const callbacks: string[] = [];
    for (const address of [origin, publicUrl, linkOrigin]) {
        const callback = address ? githubLinkCallbackUrl(address) : null;
        if (callback && !callbacks.includes(callback)) callbacks.push(callback);
    }
    return {
        name,
        url: publicUrl ?? origin,
        callback_urls: callbacks,
        ...(publicUrl
            ? { hook_attributes: { url: githubWebhookUrl(publicUrl), active: true }, default_events: [...APP_EVENTS] }
            : {}),
        redirect_url: `${origin}/api/integrations/github/callback`,
        setup_url: `${origin}/api/integrations/github/callback`,
        setup_on_update: true,
        public: false,
        default_permissions: { ...APP_PERMISSIONS }
    };
}

/**
 * What the App asks for, and why each one is here.
 *
 * Deploy needed two read permissions. An agent works inside the repository, so it
 * needs to write what it is there to produce, and nothing beyond that: there is
 * no administration, no member management and no access to another installation.
 *
 * Widening this list does not widen an App that already exists. GitHub requires
 * the owner to accept new permissions, which is why `missingAppPermissions`
 * exists and why Integrations surfaces the gap instead of letting a dispatch fail
 * with a bare 403.
 */
export const APP_PERMISSIONS: Readonly<Record<string, string>> = {
    // Read the repository, and write the branches an agent pushes.
    contents: "write",
    metadata: "read",
    // Open pull requests, review them, and comment on them.
    pull_requests: "write",
    // Triage issues and answer them.
    issues: "write",
    // Dispatch the workflow a run happens in, and read its logs when CI fails.
    actions: "write",
    // Post the run-status check a pull request shows while a run is in flight.
    checks: "write",
    // Announce a deploy on the commit it came from, so the repository shows what
    // Polaris is doing with it the way it shows Vercel and Railway.
    deployments: "write",
    // Write the workflow file itself. GitHub gates this separately from contents.
    workflows: "write",
    // Register self-hosted runners on a repository, which is what a runner pool
    // is. Asked for here rather than left to the operator because the alternative
    // was an instruction nobody could follow: the screen said "grant
    // Administration: Read and write", and GitHub never offers a permission the
    // App does not request - it would have to be added to the App first. The
    // narrower `organization_self_hosted_runners` covers organizations only, and
    // most installs are on a user account where it does not apply.
    administration: "write"
};

// Deliberately absent: `secrets`. A run gets its provider key from this instance
// over its authenticated run-context call, not from a copy written into the
// repository. That keeps one place to rotate a key, leaves no copy behind on a
// repository somebody later disables, and costs the App one less permission.

/** Events the App subscribes to. Everything an agent can be started by, plus the
 *  two Deploy and Runners already relied on. */
export const APP_EVENTS: readonly string[] = [
    "push",
    "workflow_job",
    "workflow_run",
    "issues",
    "issue_comment",
    "pull_request",
    "pull_request_review",
    "pull_request_review_comment",
    "check_suite"
];

/**
 * Permissions this installation was never granted, in the order they are declared.
 *
 * GitHub reports what it granted, so this compares against what the App now asks
 * for. `write` satisfies a `read` requirement; nothing else does. An installation
 * with no recorded permissions is treated as complete rather than broken: those
 * rows predate the recording, and a refresh fills them in.
 */
export function missingAppPermissions(granted: Record<string, string>): string[] {
    if (Object.keys(granted).length === 0) return [];
    return Object.entries(APP_PERMISSIONS)
        .filter(([name, needed]) => {
            const held = granted[name];
            if (!held) return true;
            return needed === "write" && held !== "write";
        })
        .map(([name]) => name);
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
    // Read alongside, on the same schedule and from the same credentials: an App
    // widened by hand on GitHub has to stop being reported as un-widened here
    // without anybody pressing anything, exactly as an acceptance does.
    const appPermissions = await fetchAppPermissions(secrets.appId, secrets.pem);
    const state = await getIntegrationState(PROVIDER);
    await upsertIntegration(PROVIDER, {
        config: {
            ...(state?.config ?? {}),
            installations,
            // Left alone rather than written as null when GitHub could not be
            // asked: a blink must not read as an App that requests nothing.
            ...(appPermissions ? { appPermissions } : {})
        }
    });
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

export interface GithubPermissionGap {
    /** Installations that have not accepted everything the App now asks for,
     *  each with the page its owner accepts them on - null where the account
     *  type was never recorded and neither of GitHub's two paths is known to
     *  apply. The gap is still reported; only the link is missing. */
    installations: Array<{ login: string; missing: string[]; reviewUrl: string | null }>;
    /** Where to send somebody when there is no single installation to point at.
     *  Re-running the install prompts for the current permission set, which is
     *  the same acceptance by another route. */
    reviewUrl: string | null;
    /**
     * Permissions the APP does not yet ask GitHub for.
     *
     * The step before every other one, and the one that was missing. Nothing an
     * installation's owner does can grant a permission the App does not request:
     * GitHub shows them no Review request, because there is no request. Until
     * this is empty, the installation rows below are unreachable and saying
     * "so-and-so has not granted Deployments" is telling somebody to press a
     * button that is not on their screen.
     *
     * Empty when the App asks for everything, and also when GitHub could not be
     * asked - an unknown is not a gap.
     */
    appMissing: string[];
    /** Where the App's owner adds them, which is the only place they can be
     *  added. Null for the PAT method and for an App whose name was not kept. */
    appPermissionsUrl: string | null;
}

/**
 * Where an installation's owner accepts a pending permission request.
 *
 * Not on the App's own page: `https://github.com/apps/<slug>` is the public
 * listing and has no `/permissions/update` under it, so linking there was a 404
 * for everybody who followed it. The request is held against the *installation*,
 * and the installation lives in the account's settings - which is a different
 * path for a user and for an organization.
 */
function installationSettingsUrl(installation: Installation, htmlUrl: string | null): string | null {
    if (installation.accountType === "Organization") {
        return `https://github.com/organizations/${installation.login}/settings/installations/${installation.id}`;
    }
    if (installation.accountType === "User") {
        return `https://github.com/settings/installations/${installation.id}`;
    }
    // Written before the type was recorded, so which of the two paths applies is
    // unknown. Guessing produces another 404; re-running the install prompts for
    // the same acceptance and is right either way. `htmlUrl` is the App's own
    // page and is derived from its slug where it was never stored, so this only
    // comes back null for a deployment that has neither - which is a deployment
    // with no App at all.
    return htmlUrl ? `${htmlUrl}/installations/new` : null;
}

/**
 * The App's own page, from whatever the connection recorded.
 *
 * Stored as `htmlUrl` since the App was created here, but an older connection
 * has only the slug - and the slug is enough, because GitHub's address for an
 * App is its name. Worth deriving rather than giving up on: this is the one
 * value every fallback link below is built out of, and a row with no link at all
 * is a row telling somebody to go and find a page it will not name.
 */
function appPageUrl(config: Record<string, unknown>): string | null {
    const htmlUrl = typeof config.htmlUrl === "string" ? config.htmlUrl : "";
    if (htmlUrl) return htmlUrl.replace(/\/+$/, "");
    const slug = typeof config.appSlug === "string" ? config.appSlug : "";
    return slug ? `https://github.com/apps/${slug}` : null;
}

/**
 * Installations still running on an older permission set.
 *
 * An App that gains a permission does not gain it on anything it is already
 * installed on: GitHub holds the request until the owner accepts it. Until they
 * do, every call needing the new permission fails with a 403 that names nothing,
 * on a screen that had no reason to expect it. So the gap is reported where the
 * App is managed, before anybody enables a repository against it.
 */
export async function githubPermissionGap(): Promise<GithubPermissionGap> {
    const state = await getIntegrationState(PROVIDER);
    if (state?.config.method !== "app") {
        return { installations: [], reviewUrl: null, appMissing: [], appPermissionsUrl: null };
    }
    const installs = Array.isArray(state.config.installations) ? (state.config.installations as Installation[]) : [];
    const htmlUrl = appPageUrl(state.config);
    const gaps = installs
        .map((install) => ({
            login: install.login,
            missing: missingAppPermissions(install.permissions ?? {}),
            reviewUrl: installationSettingsUrl(install, htmlUrl)
        }))
        // Only the gap decides whether a row belongs here. It used to have to
        // carry a link as well, so an installation recorded before the account
        // type was - the one case with no derivable URL - was dropped from the
        // gap and its refusals went unexplained. A row with nowhere to point is
        // still a row somebody has to be told about.
        .filter((row) => row.missing.length > 0);

    const asked =
        state.config.appPermissions && typeof state.config.appPermissions === "object"
            ? (state.config.appPermissions as Record<string, string>)
            : null;

    return {
        installations: gaps,
        // One installation has a page of its own; several have no single page, so
        // the install flow stands in - it prompts for the current permission set,
        // which accepts the same request.
        reviewUrl:
            gaps.length === 1 && gaps[0]?.reviewUrl
                ? gaps[0].reviewUrl
                : htmlUrl
                  ? `${htmlUrl}/installations/new`
                  : null,
        // Null means GitHub was never asked, or could not be. Reported as no gap:
        // an unknown must not put a step in front of somebody.
        appMissing: asked ? missingAppPermissions(asked) : [],
        appPermissionsUrl: appPermissionsUrl(state.config)
    };
}

/** Where the App's own requested permissions are edited. Built from the slug,
 *  because GitHub's address for an App is its name. */
function appPermissionsUrl(config: Record<string, unknown>): string | null {
    const slug = typeof config.appSlug === "string" ? config.appSlug : "";
    return slug ? `https://github.com/settings/apps/${slug}/permissions` : null;
}

/**
 * The login people write to address the App, without the `[bot]` suffix GitHub
 * appends to the account it creates for it.
 *
 * Instance-specific: the App is named when it is created, so nothing that matches
 * a mention may be a constant. Null for the PAT method, which has no App and
 * therefore nothing to address.
 */
export async function githubAppHandle(): Promise<string | null> {
    const state = await getIntegrationState(PROVIDER);
    if (state?.config.method !== "app") return null;
    const slug = typeof state.config.appSlug === "string" ? state.config.appSlug : null;
    return slug || null;
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
 * What a token turns out to be worth against one repository.
 *
 * Four answers rather than a boolean, because they are four different things to
 * go and do and the clone failure that prompts the question looks identical for
 * all of them: git asks for a username, is refused a terminal, and stops.
 */
export type RepoAccess = "reachable" | "token-refused" | "out-of-reach" | "sso-required" | "unknown";

/**
 * Ask GitHub about `owner/repo` as this token, and report which of the four it
 * is.
 *
 * Only ever asked after something has already gone wrong. GitHub deliberately
 * answers 404 rather than 403 for a repository a token may not see - it does not
 * confirm that private repositories exist - so "not there" and "not yours" are
 * one answer here, and the sentence built from it has to name both.
 */
export async function repoAccessFor(owner: string, repo: string, token: string): Promise<RepoAccess> {
    const url = `${API}/repos/${encodeURIComponent(owner)}/${encodeURIComponent(repo)}`;
    let res: Response;
    try {
        res = await fetch(url, { headers: apiHeaders(token), cache: "no-store" });
    } catch {
        return "unknown";
    }
    if (res.ok) return "reachable";
    if (res.status === 401) return "token-refused";
    // An organization with SAML on it names that in a header rather than in
    // anything the body says, and it is the one 403 with an answer of its own.
    if (res.status === 403) return res.headers.get("x-github-sso") ? "sso-required" : "out-of-reach";
    if (res.status === 404) return "out-of-reach";
    return "unknown";
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

/**
 * The repository-relative paths that changed between two commits, for deciding which
 * services in a monorepo a push actually concerns.
 *
 * Returns an empty list on any failure, which the watch-path matcher reads as "could
 * not tell" and deploys anyway. That is the right way round: a compare call GitHub
 * would not answer must not quietly stop a service deploying, because a service that
 * stops deploying and says nothing is indistinguishable from a broken integration.
 *
 * GitHub caps the file list at 300 per page. Past that the answer is truncated rather
 * than paged: a push touching more than 300 files is one that concerns everything.
 */
export async function getChangedFiles(
    owner: string,
    repo: string,
    base: string,
    head: string,
    token: string | null
): Promise<string[]> {
    const headers = optionalAuthHeaders(token);
    try {
        const res = await fetch(
            `${API}/repos/${owner}/${repo}/compare/${encodeURIComponent(base)}...${encodeURIComponent(head)}`,
            { headers, cache: "no-store" }
        );
        if (!res.ok) return [];
        const data = (await res.json()) as { files?: Array<{ filename?: string; previous_filename?: string }> };
        const files = data.files ?? [];
        if (files.length >= 300) return [];
        return files.flatMap((file) =>
            // A rename touches both sides: a service watching the path a file moved out
            // of has as much reason to rebuild as the one it moved into.
            [file.filename, file.previous_filename].filter((path): path is string => typeof path === "string")
        );
    } catch {
        return [];
    }
}

// --- Deployments -----------------------------------------------------------
//
// The deployment box GitHub renders on a commit and on a pull request, with a
// state and a "View deployment" link - the one Vercel and Railway fill in. It is
// two calls: GitHub mints a Deployment against a commit, and every state after
// that is posted against the id it minted.
//
// Both are best-effort throughout. A repository that refuses them is a repository
// whose deploys still work; announcing is something a deploy does, never
// something it depends on.

/** The states GitHub accepts for a deployment. `error` is the one a cancel lands
 *  on: there is no cancelled state, and leaving it in progress is worse. */
export type DeploymentState = "queued" | "in_progress" | "success" | "failure" | "error" | "inactive";

/**
 * What GitHub did with an announcement.
 *
 * The status comes back with it because a refusal is the whole of what the
 * operator sees: a deploy that never appeared on the commit and no reason given
 * anywhere they can read. 403 is a token without the permission, 404 a repository
 * it cannot see at all, and they are two different things to go and do. Zero is
 * GitHub not answering, which is neither.
 */
export interface AnnounceResult {
    /** The deployment id, set only where GitHub minted one. */
    id: string | null;
    /** GitHub's status code, or 0 when the request never reached it. */
    status: number;
}

/** GitHub truncates a longer description; trimming here keeps what it shows ours. */
function shortDescription(text: string): string {
    const line = text.split("\n").map((part) => part.trim()).find((part) => part.length > 0) ?? "";
    return line.length > 140 ? `${line.slice(0, 137)}...` : line;
}

/**
 * Mint a Deployment on a commit, and hand back the id its states are posted
 * against. No id when GitHub would not create one, with its answer beside it so
 * the deploy log can say which refusal this was.
 *
 * The two flags are not optional in practice, whatever the API defaults say.
 * Without `auto_merge: false` GitHub answers a ref behind its base branch by
 * merging into it - a deploy that silently writes to somebody's repository.
 * Without an empty `required_contexts` it refuses outright whenever a check on
 * that commit has not passed yet, which for a push-triggered deploy is nearly
 * always: the build starts long before CI has finished.
 */
export async function createDeployment(input: {
    owner: string;
    repo: string;
    /** The commit SHA. A branch name would deploy whatever is at its head later. */
    ref: string;
    environment: string;
    description: string;
    production: boolean;
    token: string;
}): Promise<AnnounceResult> {
    try {
        const res = await fetch(`${API}/repos/${input.owner}/${input.repo}/deployments`, {
            method: "POST",
            headers: { ...apiHeaders(input.token), "Content-Type": "application/json" },
            cache: "no-store",
            body: JSON.stringify({
                ref: input.ref,
                environment: input.environment,
                description: shortDescription(input.description),
                production_environment: input.production,
                auto_merge: false,
                required_contexts: []
            })
        });
        // 202 and 409 both come back with a message instead of a deployment: a merge
        // GitHub performed, or a conflict it refused over. Neither has an id, so
        // neither is something later states can be posted against.
        if (res.status !== 201) return { id: null, status: res.status };
        const data = (await res.json()) as { id?: number };
        return { id: typeof data.id === "number" ? String(data.id) : null, status: res.status };
    } catch {
        return { id: null, status: 0 };
    }
}

/**
 * Post a state against a deployment. 201 is the one status that took; the rest
 * are what the deploy's own log says instead of showing a state that never
 * reached the commit.
 *
 * `environment_url` is the "View deployment" link, so it is left off rather than
 * pointed at a name only this network resolves - a button that goes nowhere is
 * worse than no button. `log_url` is where GitHub sends whoever asks what
 * happened, which is this deployment's own log.
 */
export async function setDeploymentState(input: {
    owner: string;
    repo: string;
    deploymentId: string;
    state: DeploymentState;
    description: string;
    environmentUrl?: string | null;
    logUrl?: string | null;
    token: string;
}): Promise<AnnounceResult> {
    try {
        const res = await fetch(
            `${API}/repos/${input.owner}/${input.repo}/deployments/${encodeURIComponent(input.deploymentId)}/statuses`,
            {
                method: "POST",
                headers: { ...apiHeaders(input.token), "Content-Type": "application/json" },
                cache: "no-store",
                body: JSON.stringify({
                    state: input.state,
                    description: shortDescription(input.description),
                    // Retires whatever was serving this environment before, so the
                    // repository shows one active release rather than a pile of them.
                    auto_inactive: true,
                    ...(input.environmentUrl ? { environment_url: input.environmentUrl } : {}),
                    ...(input.logUrl ? { log_url: input.logUrl } : {})
                })
            }
        );
        return { id: null, status: res.status };
    } catch {
        return { id: null, status: 0 };
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
