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

// --- Personal Access Token method ------------------------------------------

/** Validate a token and return the login it authenticates as, or throw. */
export async function verifyGithubToken(token: string): Promise<{ login: string }> {
    const res = await fetch(`${API}/user`, { headers: apiHeaders(token), cache: "no-store" });
    if (res.status === 401) throw new Error("GitHub rejected the token (unauthorized)");
    if (!res.ok) throw new Error(`GitHub returned ${res.status} validating the token`);
    const body = (await res.json()) as { login?: string };
    if (!body.login) throw new Error("GitHub did not return an account for this token");
    return { login: body.login };
}

/** Connect (or replace) GitHub with a Personal Access Token, validating it first. */
export async function connectGithubPat(token: string, installedById?: string): Promise<{ login: string }> {
    const trimmed = token.trim();
    if (!trimmed) throw new Error("A GitHub token is required");
    const { login } = await verifyGithubToken(trimmed);
    await upsertIntegration(PROVIDER, { enabled: true, config: { method: "pat", login }, secret: trimmed, installedById });
    return { login };
}

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
    const body = (await res.json()) as Array<{ id: number; account?: { login?: string } }>;
    return body.map((row) => ({ id: row.id, login: row.account?.login ?? "" }));
}

/** The manifest describing the app GitHub will create for this Polaris instance. */
export function buildAppManifest(baseUrl: string, name: string): Record<string, unknown> {
    return {
        name,
        url: baseUrl,
        // Webhooks are inactive until the build system needs them; the URL is set so
        // enabling them later needs no app edit.
        // Push events drive auto-deploy. GitHub must be able to reach this URL, so
        // it only fires for instances with a public domain (LAN installs use polling).
        hook_attributes: { url: `${baseUrl}/api/deploy/github/webhook`, active: true },
        default_events: ["push"],
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
            installations
        },
        secret: JSON.stringify({ pem, clientSecret: input.clientSecret, webhookSecret: input.webhookSecret })
    });
    return { installations: installations.length };
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

/**
 * Repositories the connection can deploy, most-recently-pushed first. PAT lists the
 * user's repos; App lists each installation's repos. Capped per source to keep the
 * picker snappy; the deploy UI also accepts a manual URL for anything past that.
 */
export async function listGithubRepos(): Promise<GithubRepo[]> {
    const state = await getIntegrationState(PROVIDER);
    if (!state?.hasSecret) throw new Error("GitHub is not connected");

    if (state.config.method === "app") {
        const secrets = await getAppSecrets();
        if (!secrets) throw new Error("The GitHub App is not fully configured");
        const installs = Array.isArray(state.config.installations) ? (state.config.installations as Installation[]) : [];
        const repos: GithubRepo[] = [];
        for (const inst of installs) {
            const token = await installationToken(inst.id, secrets.appId, secrets.pem);
            const res = await fetch(`${API}/installation/repositories?per_page=100`, {
                headers: apiHeaders(token),
                cache: "no-store"
            });
            if (!res.ok) continue;
            const body = (await res.json()) as {
                repositories: Array<{ full_name: string; default_branch: string; private: boolean }>;
            };
            repos.push(
                ...body.repositories.map((repo) => ({
                    fullName: repo.full_name,
                    defaultBranch: repo.default_branch || "main",
                    private: repo.private
                }))
            );
        }
        return dedupeRepos(repos);
    }

    const token = await getPatToken();
    if (!token) throw new Error("GitHub is not connected");
    const url = `${API}/user/repos?per_page=100&sort=pushed&affiliation=owner,collaborator,organization_member`;
    const res = await fetch(url, { headers: apiHeaders(token), cache: "no-store" });
    if (!res.ok) throw new Error(`GitHub returned ${res.status} listing repositories`);
    const body = (await res.json()) as Array<{ full_name: string; default_branch: string; private: boolean }>;
    return body.map((repo) => ({
        fullName: repo.full_name,
        defaultBranch: repo.default_branch || "main",
        private: repo.private
    }));
}

/** An API token for REST calls scoped to `owner` (installation token for the App
 *  method, the PAT otherwise), or null when not connected / for a public call. */
async function apiToken(owner?: string): Promise<string | null> {
    const state = await getIntegrationState(PROVIDER);
    if (!state?.hasSecret) return null;
    if (state.config.method === "app") {
        const secrets = await getAppSecrets();
        if (!secrets) return null;
        const installs = Array.isArray(state.config.installations) ? (state.config.installations as Installation[]) : [];
        const inst = (owner && installs.find((row) => row.login.toLowerCase() === owner.toLowerCase())) || installs[0];
        if (!inst) return null;
        return installationToken(inst.id, secrets.appId, secrets.pem);
    }
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
 */
export async function inspectGithubRepo(owner: string, repo: string, branch: string): Promise<RepoInspection> {
    const token = await apiToken(owner);
    const headers: HeadersInit = token
        ? apiHeaders(token)
        : { Accept: "application/vnd.github+json", "User-Agent": "polaris", "X-GitHub-Api-Version": "2022-11-28" };

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
 * A git basic-auth header value that authenticates a clone with the stored
 * credentials, or null if GitHub is not connected. Used as `http.extraHeader` so
 * the token never appears in the clone URL or the deployment log. For the App
 * method, `owner` selects the installation that owns the repo (falling back to the
 * first). GitHub reads the token from the password field regardless of the username.
 */
export async function githubCloneAuthHeader(owner?: string): Promise<string | null> {
    const state = await getIntegrationState(PROVIDER);
    if (!state?.hasSecret) return null;

    let token: string | null = null;
    if (state.config.method === "app") {
        const secrets = await getAppSecrets();
        if (!secrets) return null;
        const installs = Array.isArray(state.config.installations) ? (state.config.installations as Installation[]) : [];
        const inst =
            (owner && installs.find((row) => row.login.toLowerCase() === owner.toLowerCase())) || installs[0];
        if (!inst) return null;
        token = await installationToken(inst.id, secrets.appId, secrets.pem);
    } else {
        token = await getPatToken();
    }
    if (!token) return null;
    return `Authorization: Basic ${Buffer.from(`x-access-token:${token}`).toString("base64")}`;
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
