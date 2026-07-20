/**
 * GitHub integration. Instance-wide, stored as the `github` Integration row: the
 * access token lives in the envelope-encrypted secret slot, and the non-secret
 * config records how it was connected (method + the authenticated login). Today
 * the connection is a Personal Access Token; a GitHub App (manifest flow) is a
 * planned second method and slots in behind the same repo-listing/clone-token
 * surface, so callers never learn which method is in use.
 */

import {
    getIntegrationSecret,
    getIntegrationState,
    upsertIntegration
} from "./integration-service";

const PROVIDER = "github";
const API = "https://api.github.com";

export interface GithubStatus {
    connected: boolean;
    method: "pat" | "app" | null;
    login: string | null;
}

export interface GithubRepo {
    /** owner/name */
    fullName: string;
    defaultBranch: string;
    private: boolean;
}

/** Common headers for a GitHub REST call. GitHub requires a User-Agent. */
function apiHeaders(token: string): HeadersInit {
    return {
        Authorization: `Bearer ${token}`,
        Accept: "application/vnd.github+json",
        "X-GitHub-Api-Version": "2022-11-28",
        "User-Agent": "polaris"
    };
}

/** Validate a token and return the login it authenticates as, or throw a clean error. */
export async function verifyGithubToken(token: string): Promise<{ login: string }> {
    const res = await fetch(`${API}/user`, { headers: apiHeaders(token), cache: "no-store" });
    if (res.status === 401) throw new Error("GitHub rejected the token (unauthorized)");
    if (!res.ok) throw new Error(`GitHub returned ${res.status} validating the token`);
    const body = (await res.json()) as { login?: string };
    if (!body.login) throw new Error("GitHub did not return an account for this token");
    return { login: body.login };
}

/** Public connection state for the UI (never exposes the token). */
export async function getGithubStatus(): Promise<GithubStatus> {
    const state = await getIntegrationState(PROVIDER);
    if (!state?.hasSecret) return { connected: false, method: null, login: null };
    const method = state.config.method === "app" ? "app" : "pat";
    const login = typeof state.config.login === "string" ? state.config.login : null;
    return { connected: true, method, login };
}

/** The stored access token, or null if GitHub is not connected / undecryptable. */
export async function getGithubToken(): Promise<string | null> {
    return getIntegrationSecret(PROVIDER);
}

/** Connect (or replace) GitHub with a Personal Access Token, validating it first. */
export async function connectGithubPat(token: string, installedById?: string): Promise<{ login: string }> {
    const trimmed = token.trim();
    if (!trimmed) throw new Error("A GitHub token is required");
    const { login } = await verifyGithubToken(trimmed);
    await upsertIntegration(PROVIDER, {
        enabled: true,
        config: { method: "pat", login },
        secret: trimmed,
        installedById
    });
    return { login };
}

/** Forget the GitHub connection and its token. */
export async function disconnectGithub(): Promise<void> {
    await upsertIntegration(PROVIDER, { enabled: false, config: {}, secret: null });
}

/**
 * Repositories the connected token can reach, most-recently-pushed first. Capped
 * at one page (100) to keep the picker snappy; the deploy UI also accepts a manual
 * URL for anything past that.
 */
export async function listGithubRepos(): Promise<GithubRepo[]> {
    const token = await getGithubToken();
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

/**
 * A git basic-auth header value that authenticates a clone with the stored token,
 * or null if GitHub is not connected. Used as `http.extraHeader` so the token never
 * appears in the clone URL or the deployment log. Works for both PATs and (later)
 * GitHub App installation tokens - GitHub reads the token from the password field
 * regardless of the username.
 */
export async function githubCloneAuthHeader(): Promise<string | null> {
    const token = await getGithubToken();
    if (!token) return null;
    const basic = Buffer.from(`x-access-token:${token}`).toString("base64");
    return `Authorization: Basic ${basic}`;
}
