/**
 * Signing in to GitLab Duo, on gitlab.com or a self-managed GitLab, and calling it.
 *
 * The login is OpenCode's (`packages/core/src/plugin/provider/gitlab.ts`): a
 * PKCE authorization with OpenCode's public application on gitlab.com, or on a
 * self-managed instance with the application its owner registered there (the
 * same return address, scope `api`, not confidential). That application only
 * returns to `http://127.0.0.1:8080/callback`, which on a server nobody is
 * sitting at goes nowhere, so the person copies the address their browser
 * lands on and pastes it back; the code is read from it here. The instance and
 * application are kept on the login (`metadata.instanceUrl`, `clientID`, as
 * OpenCode keeps them), because a refresh token only renews with the
 * application that issued it.
 *
 * Chat does not go through a package. GitLab hands a short-lived token for its
 * AI gateway at `/api/v4/ai/third_party_agents/direct_access`, and the gateway
 * proxies Anthropic's and OpenAI's own APIs, so the existing clients are
 * pointed at it. Endpoints, headers and the model table are read from
 * `gitlab-ai-provider` 6.24.0 (`dist/index.js`, `GitLabDirectAccessClient` and
 * the `duo-chat-*` table), which OpenCode uses and which is too new to add.
 *
 * Pure apart from the `request` it is handed.
 */

import { z } from "zod";
import { createHash, randomBytes } from "node:crypto";
import { DirectSigninError } from "@/lib/agents/signin-direct";
import type { StoredOAuth } from "@/lib/agents/provider-oauth";
import type { LoginRequest } from "@/lib/agents/provider-login-http";
import { gitlabInstanceUrl, GITLAB_CLIENT_ID_PATTERN, type GitlabInstance } from "@/lib/agents/login-instances";

// gitlab.ts lines 24-35: OpenCode's public application on gitlab.com (PKCE, no
// secret), its one registered return address, and the scope it asks for.
export const GITLAB_CLIENT_ID = "fd180700a8f9c5d5557aca231632dd0611a1135a3bb510a741d5a988a3394fa7";
export const GITLAB_INSTANCE = "https://gitlab.com";
export const GITLAB_REDIRECT_URI = "http://127.0.0.1:8080/callback";
const SCOPE = "api";
/** gitlab.ts `credential`: two hours when the answer does not say. */
const DEFAULT_TOKEN_SECONDS = 7200;
/** gitlab-ai-provider `DEFAULT_AI_GATEWAY_URL` and its proxy paths. */
export const GITLAB_AI_GATEWAY = "https://cloud.gitlab.com";
export const GITLAB_ANTHROPIC_BASE = `${GITLAB_AI_GATEWAY}/ai/v1/proxy/anthropic/v1`;
export const GITLAB_OPENAI_BASE = `${GITLAB_AI_GATEWAY}/ai/v1/proxy/openai/v1`;
const DIRECT_ACCESS_PATH = "/api/v4/ai/third_party_agents/direct_access";
export const GITLAB_DIRECT_ACCESS_URL = `${GITLAB_INSTANCE}${DIRECT_ACCESS_PATH}`;
/** gitlab.com with OpenCode's application: every login made before an instance
 *  could be named. */
export const GITLAB_COM: GitlabInstance = { url: GITLAB_INSTANCE, clientId: GITLAB_CLIENT_ID };
/** "Tokens are cached for 25 minutes (they expire after 30 minutes)." */
export const DIRECT_ACCESS_TTL_MS = 25 * 60_000;

/** A PKCE authorization waiting for the person to paste where it landed. */
export interface GitlabAuthorization {
    readonly url: string;
    readonly state: string;
    readonly verifier: string;
    readonly instance: GitlabInstance;
}

/**
 * The instance a stored login was made against: the address and application
 * it names, read through the same rules a typed one is, or gitlab.com with
 * OpenCode's application for a login that names none (all made before).
 */
export function gitlabInstanceOf(metadata: Readonly<Record<string, string>> | undefined): GitlabInstance {
    const url = metadata?.instanceUrl ? gitlabInstanceUrl(metadata.instanceUrl) : null;
    if (!url) return GITLAB_COM;
    const clientId = metadata?.clientID;
    if (clientId && GITLAB_CLIENT_ID_PATTERN.test(clientId)) return { url, clientId };
    return url === GITLAB_INSTANCE ? GITLAB_COM : { url, clientId: GITLAB_CLIENT_ID };
}

/** What a login keeps about where it was made. */
export function gitlabMetadata(instance: GitlabInstance): Record<string, string> {
    return { instanceUrl: instance.url, clientID: instance.clientId };
}

export function startGitlabAuthorization(instance: GitlabInstance = GITLAB_COM): GitlabAuthorization {
    const verifier = randomBytes(32).toString("base64url");
    const state = randomBytes(16).toString("base64url");
    const challenge = createHash("sha256").update(verifier).digest("base64url");
    const query = new URLSearchParams({
        client_id: instance.clientId,
        redirect_uri: GITLAB_REDIRECT_URI,
        response_type: "code",
        state,
        scope: SCOPE,
        code_challenge: challenge,
        code_challenge_method: "S256"
    });
    return { url: `${instance.url}/oauth/authorize?${query.toString()}`, state, verifier, instance };
}

/**
 * The code in what the person pasted: the whole address their browser landed
 * on (its `state` must be this login's), or the bare code. Null for anything
 * else, including an address carrying GitLab's `error`.
 */
export function codeFromPaste(pasted: string, state: string): string | null {
    const text = pasted.trim();
    if (!text) return null;
    if (/^[A-Za-z0-9_-]{16,256}$/.test(text)) return text;
    let url: URL;
    try {
        url = new URL(text);
    } catch {
        return null;
    }
    const code = url.searchParams.get("code");
    if (!code || url.searchParams.get("error")) return null;
    return url.searchParams.get("state") === state ? code : null;
}

const tokenSchema = z.object({
    access_token: z.string().min(1),
    refresh_token: z.string().min(1),
    expires_in: z.number().positive().optional()
});

type Tokens = Pick<StoredOAuth, "access" | "refresh" | "expires">;

async function tokenCall(
    request: LoginRequest,
    instance: GitlabInstance,
    form: Record<string, string>,
    now: number
): Promise<Tokens> {
    const response = await request(`${instance.url}/oauth/token`, {
        method: "POST",
        form: { ...form, client_id: instance.clientId }
    });
    if (response.status < 200 || response.status >= 300) {
        throw new DirectSigninError(`gitlab token: HTTP ${response.status}`);
    }
    const parsed = tokenSchema.safeParse(response.json);
    if (!parsed.success) throw new DirectSigninError("gitlab token: unexpected answer");
    return {
        access: parsed.data.access_token,
        refresh: parsed.data.refresh_token,
        expires: now + (parsed.data.expires_in ?? DEFAULT_TOKEN_SECONDS) * 1000
    };
}

export function exchangeGitlabCode(
    request: LoginRequest,
    authorization: GitlabAuthorization,
    code: string,
    now: number
): Promise<Tokens> {
    return tokenCall(
        request,
        authorization.instance,
        {
            grant_type: "authorization_code",
            code,
            code_verifier: authorization.verifier,
            redirect_uri: GITLAB_REDIRECT_URI
        },
        now
    );
}

/** gitlab.ts line 163: a refresh names the same return address, on the
 *  instance and with the application the login was made with. */
export function refreshGitlabTokens(
    request: LoginRequest,
    login: Tokens & { readonly metadata?: Readonly<Record<string, string>> },
    now: number
): Promise<Tokens> {
    return tokenCall(
        request,
        gitlabInstanceOf(login.metadata),
        { grant_type: "refresh_token", refresh_token: login.refresh, redirect_uri: GITLAB_REDIRECT_URI },
        now
    );
}

const directAccessSchema = z.object({
    headers: z.record(z.string(), z.string()),
    token: z.string().min(1)
});

export interface DirectAccess {
    readonly token: string;
    readonly headers: Record<string, string>;
}

/** A gateway token for this account, from the instance it signed in on. 403
 *  is Duo not being available to it. */
export async function gitlabDirectAccess(
    request: LoginRequest,
    access: string,
    instanceUrl: string = GITLAB_INSTANCE
): Promise<DirectAccess> {
    const response = await request(`${instanceUrl}${DIRECT_ACCESS_PATH}`, {
        method: "POST",
        headers: { Authorization: `Bearer ${access}` },
        json: {}
    });
    if (response.status === 403) throw new DirectSigninError("gitlab duo: not available to this account");
    if (response.status < 200 || response.status >= 300) {
        throw new DirectSigninError(`gitlab duo: HTTP ${response.status}`);
    }
    const parsed = directAccessSchema.safeParse(response.json);
    if (!parsed.success) throw new DirectSigninError("gitlab duo: unexpected answer");
    // gitlab-ai-provider drops the key header and sends the token as a bearer.
    const { "x-api-key": _dropped, ...headers } = parsed.data.headers;
    return { token: parsed.data.token, headers };
}

/** Which upstream model a Duo model id is, and through which API. */
export interface DuoModel {
    readonly api: "anthropic" | "openai-chat" | "openai-responses";
    readonly model: string;
}

// gitlab-ai-provider 6.24.0 dist/index.js, the `duo-chat-*` table.
const ANTHROPIC: Readonly<Record<string, string>> = {
    "duo-chat-fable-5-2": "claude-fable-5-2",
    "duo-chat-fable-5-1": "claude-fable-5-1",
    "duo-chat-fable-5": "claude-fable-5",
    "duo-chat-opus-5-5": "claude-opus-5-5",
    "duo-chat-opus-5": "claude-opus-5",
    "duo-chat-opus-4-8": "claude-opus-4-8",
    "duo-chat-opus-4-7": "claude-opus-4-7",
    "duo-chat-opus-4-6": "claude-opus-4-6",
    "duo-chat-sonnet-5-5": "claude-sonnet-5-5",
    "duo-chat-sonnet-5": "claude-sonnet-5",
    "duo-chat-sonnet-4-6": "claude-sonnet-4-6",
    "duo-chat-opus-4-5": "claude-opus-4-5-20251101",
    "duo-chat-sonnet-4-5": "claude-sonnet-4-5-20250929",
    "duo-chat-haiku-5-5": "claude-haiku-5-5",
    "duo-chat-haiku-4-5": "claude-haiku-4-5-20251001"
};
const OPENAI_CHAT: Readonly<Record<string, string>> = {
    "duo-chat-gpt-5-1": "gpt-5.1-2025-11-13",
    "duo-chat-gpt-5-2": "gpt-5.2-2025-12-11",
    "duo-chat-gpt-5-4": "gpt-5.4-2026-03-05",
    "duo-chat-gpt-5-5": "gpt-5.5-2026-04-23",
    "duo-chat-gpt-5-mini": "gpt-5-mini-2025-08-07",
    "duo-chat-gpt-5-4-mini": "gpt-5.4-mini",
    "duo-chat-gpt-5-4-nano": "gpt-5.4-nano"
};
const OPENAI_RESPONSES: Readonly<Record<string, string>> = {
    "duo-chat-gpt-6-astra": "gpt-6-astra",
    "duo-chat-gpt-6-1-sol": "gpt-6.1-sol",
    "duo-chat-gpt-6-sol": "gpt-6-sol",
    "duo-chat-gpt-6-luna": "gpt-6-luna",
    "duo-chat-gpt-5-6-sol": "gpt-5.6-sol",
    "duo-chat-gpt-5-6-terra": "gpt-5.6-terra",
    "duo-chat-gpt-5-6-luna": "gpt-5.6-luna",
    "duo-chat-gpt-5-codex": "gpt-5-codex",
    "duo-chat-gpt-5-2-codex": "gpt-5.2-codex"
};

/** The upstream model behind a Duo id, or null for one the table does not know. */
export function duoModel(id: string): DuoModel | null {
    if (ANTHROPIC[id]) return { api: "anthropic", model: ANTHROPIC[id] };
    if (OPENAI_CHAT[id]) return { api: "openai-chat", model: OPENAI_CHAT[id] };
    if (OPENAI_RESPONSES[id]) return { api: "openai-responses", model: OPENAI_RESPONSES[id] };
    return null;
}

/** Every Duo id the table knows, for a picker with nothing better. */
export const DUO_MODEL_IDS: readonly string[] = [
    ...Object.keys(ANTHROPIC),
    ...Object.keys(OPENAI_CHAT),
    ...Object.keys(OPENAI_RESPONSES)
];
