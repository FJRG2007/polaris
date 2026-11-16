/**
 * Subscription logins for Polar: SuperGrok (xAI), GitHub Copilot, GitLab Duo
 * and an OpenCode Console account (Zen or Go), run from the server and stored as the person's own model key on the
 * provider's slug (`provider-oauth.ts` is the stored shape).
 *
 * An attempt in flight lives in server memory only, keyed by an id the screen
 * holds and bound to the account that started it; nothing about it is written
 * until the vendor hands back a token. Attempts end after fifteen minutes.
 */

import { randomUUID } from "node:crypto";
import * as xai from "@/lib/agents/signin-xai";
import * as gitlab from "@/lib/agents/signin-gitlab";
import * as copilot from "@/lib/agents/signin-copilot";
import * as opencode from "@/lib/agents/signin-opencode";
import { DirectSigninError } from "@/lib/agents/signin-direct";
import { writeOAuthSecret } from "@/lib/agents/provider-oauth";
import { createModelKey, ownerHasModelKeyName } from "@/lib/agents/model-keys";
import { asDirectPost, loginRequest, type LoginRequest } from "@/lib/agents/provider-login-http";

export const PROVIDER_LOGINS = ["xai", "github-copilot", "gitlab", "opencode", "opencode-go"] as const;
export type ProviderLogin = (typeof PROVIDER_LOGINS)[number];

/** The key's name in the table, before a number is added to keep it unique. */
const KEY_NAME: Record<ProviderLogin, string> = {
    xai: "SuperGrok", // i18n-ignore: product name
    "github-copilot": "GitHub Copilot", // i18n-ignore: product name
    gitlab: "GitLab Duo", // i18n-ignore: product name
    opencode: "OpenCode Zen", // i18n-ignore: product name
    "opencode-go": "OpenCode Go" // i18n-ignore: product name
};

/** The Console sign-in serves both: one account, stored on the slug chosen. */
type ConsoleSlug = "opencode" | "opencode-go";

type Pending =
    | { kind: "xai"; device: xai.XaiDevice }
    | { kind: "github-copilot"; device: copilot.CopilotDevice }
    | { kind: "gitlab"; authorization: gitlab.GitlabAuthorization }
    | { kind: "opencode"; slug: ConsoleSlug; device: opencode.OpencodeDevice };

interface Attempt {
    userId: string;
    pending: Pending;
    startedAt: number;
    nextPollAt: number;
    intervalMs: number;
}

const ATTEMPT_LIFETIME_MS = 15 * 60_000;
const MAX_ATTEMPTS = 500;
const attempts = new Map<string, Attempt>();

/** What the screen shows: where to go, and the code to type there (device
 *  logins) or that an address has to be pasted back (GitLab). */
export interface LoginStart {
    id: string;
    url: string;
    userCode: string | null;
    paste: boolean;
}

export type LoginState =
    | { state: "pending" }
    | { state: "done"; keyId: string }
    | { state: "denied" | "expired" | "failed" | "gone" | "bad-paste" | "no-duo" }
    | { state: "no-copilot"; canSignUp: boolean };

function sweep(now: number): void {
    for (const [id, attempt] of attempts) {
        if (now - attempt.startedAt > ATTEMPT_LIFETIME_MS) attempts.delete(id);
    }
    while (attempts.size >= MAX_ATTEMPTS) {
        const oldest = attempts.keys().next().value;
        if (oldest === undefined) break;
        attempts.delete(oldest);
    }
}

export async function startProviderLogin(
    userId: string,
    provider: ProviderLogin,
    request: LoginRequest = loginRequest,
    now = Date.now()
): Promise<LoginStart> {
    sweep(now);
    const id = randomUUID();
    let pending: Pending;
    let start: Omit<LoginStart, "id">;
    let intervalMs = 5000;
    if (provider === "xai") {
        const device = await xai.requestXaiDevice(asDirectPost(request), now);
        pending = { kind: "xai", device };
        intervalMs = device.intervalMs;
        start = { url: device.verificationUrl, userCode: device.userCode, paste: false };
    } else if (provider === "github-copilot") {
        const device = await copilot.requestCopilotDevice(request, now);
        pending = { kind: "github-copilot", device };
        intervalMs = device.intervalMs;
        start = { url: device.verificationUrl, userCode: device.userCode, paste: false };
    } else if (provider === "opencode" || provider === "opencode-go") {
        const device = await opencode.requestOpencodeDevice(request, now);
        pending = { kind: "opencode", slug: provider, device };
        intervalMs = device.intervalMs;
        start = { url: device.verificationUrl, userCode: device.userCode, paste: false };
    } else {
        const authorization = gitlab.startGitlabAuthorization();
        pending = { kind: "gitlab", authorization };
        start = { url: authorization.url, userCode: null, paste: true };
    }
    attempts.set(id, { userId, pending, startedAt: now, nextPollAt: now + intervalMs, intervalMs });
    return { id, ...start };
}

async function store(userId: string, provider: ProviderLogin, secret: string): Promise<string> {
    const base = KEY_NAME[provider];
    let name = base;
    for (let n = 2; n < 50 && (await ownerHasModelKeyName(userId, name)); n++) name = `${base} ${n}`;
    const row = await createModelKey(userId, { provider, name, secret });
    return row.id;
}

/**
 * One check on a device login. Polls the vendor only once its interval has
 * passed, so a screen asking every second costs the vendor nothing extra.
 */
export async function pollProviderLogin(
    userId: string,
    id: string,
    request: LoginRequest = loginRequest,
    now = Date.now()
): Promise<LoginState> {
    const attempt = attempts.get(id);
    if (!attempt || attempt.userId !== userId) return { state: "gone" };
    if (attempt.pending.kind === "gitlab" || now < attempt.nextPollAt) return { state: "pending" };
    attempt.nextPollAt = now + attempt.intervalMs;
    try {
        if (attempt.pending.kind === "xai") {
            const poll = await xai.pollXaiDevice(asDirectPost(request), attempt.pending.device, now);
            if (poll.state === "done") {
                attempts.delete(id);
                return { state: "done", keyId: await store(userId, "xai", writeOAuthSecret(poll.tokens)) };
            }
            return settle(id, attempt, poll.state);
        }
        if (attempt.pending.kind === "opencode") {
            const { slug } = attempt.pending;
            const poll = await opencode.pollOpencodeDevice(request, attempt.pending.device, now);
            if (poll.state === "done") {
                attempts.delete(id);
                return { state: "done", keyId: await store(userId, slug, writeOAuthSecret(poll.login)) };
            }
            return settle(id, attempt, poll.state);
        }
        const poll = await copilot.pollCopilotDevice(request, attempt.pending.device, now);
        if (poll.state === "done") {
            attempts.delete(id);
            const secret = writeOAuthSecret({
                access: poll.login.token,
                refresh: "",
                expires: 0,
                ...(poll.login.apiEndpoint ? { metadata: { apiEndpoint: poll.login.apiEndpoint } } : {})
            });
            return { state: "done", keyId: await store(userId, "github-copilot", secret) };
        }
        if (poll.state === "no-copilot") {
            attempts.delete(id);
            return poll;
        }
        return settle(id, attempt, poll.state);
    } catch (caught) {
        attempts.delete(id);
        logFailure(caught);
        return { state: "failed" };
    }
}

function settle(id: string, attempt: Attempt, state: "pending" | "slower" | "denied" | "expired"): LoginState {
    if (state === "slower") {
        attempt.intervalMs += 5000;
        return { state: "pending" };
    }
    if (state === "pending") return { state };
    attempts.delete(id);
    return { state };
}

/** GitLab: the address the browser landed on, pasted back. */
export async function finishGitlabLogin(
    userId: string,
    id: string,
    pasted: string,
    request: LoginRequest = loginRequest,
    now = Date.now()
): Promise<LoginState> {
    const attempt = attempts.get(id);
    if (!attempt || attempt.userId !== userId || attempt.pending.kind !== "gitlab") return { state: "gone" };
    const code = gitlab.codeFromPaste(pasted, attempt.pending.authorization.state);
    if (!code) return { state: "bad-paste" };
    attempts.delete(id);
    try {
        const tokens = await gitlab.exchangeGitlabCode(request, attempt.pending.authorization, code, now);
        // Asked once here so an account without Duo hears it now, not at its
        // first chat.
        try {
            await gitlab.gitlabDirectAccess(request, tokens.access);
        } catch (caught) {
            if (caught instanceof DirectSigninError && caught.message.includes("not available")) {
                return { state: "no-duo" };
            }
            throw caught;
        }
        const secret = writeOAuthSecret({ ...tokens, metadata: { instanceUrl: gitlab.GITLAB_INSTANCE } });
        return { state: "done", keyId: await store(userId, "gitlab", secret) };
    } catch (caught) {
        logFailure(caught);
        return { state: "failed" };
    }
}

/** A status line or an error's class, never a body or a token. */
function logFailure(caught: unknown): void {
    const reason = caught instanceof DirectSigninError ? caught.message : caught instanceof Error ? caught.name : "error";
    console.warn("[provider-login] sign-in failed:", reason);
}

/** Test seam: forget every attempt. */
export function resetProviderLogins(): void {
    attempts.clear();
}
