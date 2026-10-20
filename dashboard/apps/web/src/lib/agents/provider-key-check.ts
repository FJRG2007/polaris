/**
 * Asking the provider whether a pasted key is real, before storing it.
 *
 * A key is write-only once saved, so a typo in one does not surface until a run
 * fails hours later with a refusal nobody was watching for. One request at the
 * moment of pasting turns that into a sentence in the dialog.
 *
 * Every probe is a read: the endpoint that lists what the account can reach, or
 * the one that describes the key itself. None of them run a model, so checking
 * costs nothing on the provider's bill.
 *
 * The verdict is deliberately three-valued. Only a provider saying "not this
 * key" refuses the save; a timeout, a 500, a rate limit or an endpoint that has
 * moved says so and lets the key be stored, because a deployment with no route
 * to the provider must not be a deployment where nobody can add a key.
 */

import { readerWords } from "@/lib/i18n/reader-words";
import {
    GATEWAY_SLUG,
    ANTHROPIC_WORKSPACE_HEADER,
    anthropicWorkspaceHeaders
} from "@/lib/agents/agent-providers";
import { MODEL_PROVIDER_SEEDS } from "@/lib/integrations/model-providers";

/** Why a key was not accepted, in the terms a caller can branch on. `workspace`
 *  is an Anthropic key that needs a workspace ID, or was given a wrong one. */
export type KeyCheckCode =
    "invalid" | "forbidden" | "workspace" | "rate_limited" | "network" | "unknown" | "unsupported";

/** The catalog sentence behind a reason, under `refusals.aiKeys.check` in the
 *  api namespace, so the screen says it in the reader's language. */
export interface KeyCheckWords {
    key: string;
    values?: Record<string, string | number>;
}

export type KeyCheck =
    | { state: "valid" }
    /** The provider refused the credential itself. */
    | {
          state: "rejected";
          code: "invalid" | "forbidden" | "workspace";
          reason: string;
          words?: KeyCheckWords;
      }
    /** Nothing was learned. The key is stored, and a run is what proves it. */
    | { state: "unverified"; code: KeyCheckCode; reason: string; words?: KeyCheckWords };

export { ANTHROPIC_WORKSPACE_HEADER, anthropicWorkspaceHeaders };

/** One provider's read-only probe, in the vendor's own auth terms. */
interface Probe {
    endpoint: string;
    method: "GET" | "POST";
    /** The header the credential goes in. */
    header: string;
    /** What precedes it in that header, when anything does. */
    prefix: string | null;
    /** Anything else the vendor requires for the call to be understood. */
    extraHeaders?: Record<string, string>;
}

/**
 * Where each provider says whether a key is good.
 *
 * Most of them serve the OpenAI-compatible model list, which needs the key and
 * returns nothing that costs anything. The exceptions are the ones whose own
 * documentation names something else: Anthropic wants its version header, Google
 * its own key header, and OpenRouter's model list is public - checking a key
 * against it would accept every string ever pasted - so the endpoint that
 * describes the key is used instead.
 */
const PROBES: Record<string, Probe> = {
    anthropic: {
        endpoint: "https://api.anthropic.com/v1/models?limit=1",
        method: "GET",
        header: "x-api-key",
        prefix: null,
        extraHeaders: { "anthropic-version": "2023-06-01" }
    },
    openai: {
        endpoint: "https://api.openai.com/v1/models",
        method: "GET",
        header: "Authorization",
        prefix: "Bearer "
    },
    "google-ai": {
        // Its own header rather than a bearer token, and in a header rather than
        // the query string the quickstarts use: a key in a URL ends up in logs.
        endpoint: "https://generativelanguage.googleapis.com/v1beta/models?pageSize=1",
        method: "GET",
        header: "x-goog-api-key",
        prefix: null
    },
    xai: {
        endpoint: "https://api.x.ai/v1/models",
        method: "GET",
        header: "Authorization",
        prefix: "Bearer "
    },
    deepseek: {
        endpoint: "https://api.deepseek.com/models",
        method: "GET",
        header: "Authorization",
        prefix: "Bearer "
    },
    moonshot: {
        endpoint: "https://api.moonshot.ai/v1/models",
        method: "GET",
        header: "Authorization",
        prefix: "Bearer "
    },
    groq: {
        endpoint: "https://api.groq.com/openai/v1/models",
        method: "GET",
        header: "Authorization",
        prefix: "Bearer "
    },
    cerebras: {
        endpoint: "https://api.cerebras.ai/v1/models",
        method: "GET",
        header: "Authorization",
        prefix: "Bearer "
    },
    openrouter: {
        endpoint: "https://openrouter.ai/api/v1/auth/key",
        method: "GET",
        header: "Authorization",
        prefix: "Bearer "
    },

    // The long tail, from the table that carries the rest of what a provider is.
    // Only the ones whose model list is actually refused without a key appear
    // there, which is why this is thinner than the provider list: a provider
    // that publishes its catalogue publicly would accept every string pasted at
    // it, and saying "checked" about that is worse than saying nothing.
    ...Object.fromEntries(
        MODEL_PROVIDER_SEEDS.filter((seed) => seed.probe).map((seed) => [
            seed.slug,
            {
                endpoint: seed.probe as string,
                method: "GET" as const,
                header: "Authorization",
                prefix: "Bearer "
            }
        ])
    )
};

/** Whether this provider can be checked at all, for a screen that says so before
 *  somebody presses Save. */
export function providerIsCheckable(provider: string): boolean {
    return provider in PROBES;
}

/** How long to wait. Long enough for a provider having a slow morning, short
 *  enough that a dialog does not look stuck. */
const TIMEOUT_MS = 8000;

/**
 * Ask the provider about this key.
 *
 * The gateway is not asked. It is whatever endpoint its owner points it at,
 * frequently one on their own network, and a server-side request to an address
 * somebody supplies is a probe of the network Polaris sits in. Its shape is
 * checked instead, and the first run is what proves it.
 *
 * `workspaceId` is sent to Anthropic only, as the header a key that is not tied
 * to one workspace has to name its workspace in.
 */
export async function checkProviderKey(
    provider: string,
    secret: string,
    options: { workspaceId?: string | null } = {}
): Promise<KeyCheck> {
    return inReadersWords(await probeKey(provider, secret, options));
}

/** The verdict with its reason in the language of whoever is reading it. */
async function inReadersWords(check: KeyCheck): Promise<KeyCheck> {
    if (check.state === "valid" || !check.words) return check;
    const t = (await readerWords("api")) as unknown as (
        key: string,
        values?: Record<string, string | number>
    ) => string;
    return { ...check, reason: t(`refusals.aiKeys.check.${check.words.key}`, check.words.values) };
}

async function probeKey(
    provider: string,
    secret: string,
    options: { workspaceId?: string | null }
): Promise<KeyCheck> {
    if (provider === GATEWAY_SLUG) {
        return {
            state: "unverified",
            code: "unsupported",
            reason: "An endpoint of your own is proven by the first run, not from here.",
            words: { key: "ownEndpoint" }
        };
    }
    const probe = PROBES[provider];
    if (!probe) {
        return {
            state: "unverified",
            code: "unsupported",
            reason: "Polaris has no way to check this provider's keys.",
            words: { key: "noProbe" }
        };
    }

    const credential = probe.prefix ? `${probe.prefix}${secret.trim()}` : secret.trim();
    // Only Anthropic knows what a workspace is; anywhere else the header would be
    // a stray value sent to somebody who never asked for it.
    const workspace =
        provider === "anthropic" ? anthropicWorkspaceHeaders(options.workspaceId) : {};
    let response: Response;
    try {
        response = await fetch(probe.endpoint, {
            method: probe.method,
            headers: { [probe.header]: credential, ...probe.extraHeaders, ...workspace },
            signal: AbortSignal.timeout(TIMEOUT_MS),
            cache: "no-store"
        });
    } catch (caught) {
        const timedOut = caught instanceof Error && caught.name === "TimeoutError";
        return {
            state: "unverified",
            code: "network",
            reason: timedOut
                ? "The provider did not answer in time, so the key could not be checked."
                : "Could not reach the provider to check the key.",
            words: { key: timedOut ? "timedOut" : "unreachable" }
        };
    }

    if (response.ok) return classify(response.status);
    const body = await response.text().catch(() => "");
    return classify(response.status, providerMessage(body, secret), provider);
}

/** How much of a provider's own sentence is shown: enough for any error message
 *  a provider writes, short enough that a page of HTML never is one. */
const MESSAGE_LIMIT = 200;

/**
 * The provider's own explanation, from the error body it answered with.
 *
 * Read from the shapes providers use - `{ error: { message } }` (Anthropic,
 * OpenAI and the compatible ones), `{ error: "..." }` and `{ message }` - and
 * nothing else: a body that is not JSON is a proxy's page, not a sentence.
 * Control characters are dropped, the key is cut out wherever the provider
 * echoed it, and the length is capped, because this ends up on a screen.
 */
export function providerMessage(body: string, secret = ""): string | null {
    let parsed: unknown;
    try {
        parsed = JSON.parse(body);
    } catch {
        return null;
    }
    if (typeof parsed !== "object" || parsed === null) return null;
    const record = parsed as { error?: unknown; message?: unknown };
    const nested =
        typeof record.error === "object" && record.error !== null
            ? (record.error as { message?: unknown }).message
            : record.error;
    const raw =
        typeof nested === "string"
            ? nested
            : typeof record.message === "string"
              ? record.message
              : null;
    if (!raw) return null;
    let text = Array.from(raw, (char) =>
        char.charCodeAt(0) < 32 || char.charCodeAt(0) === 127 ? " " : char
    ).join("");
    const key = secret.trim();
    if (key.length >= 8) text = text.split(key).join("[key]");
    text = text.split(" ").filter(Boolean).join(" ");
    if (!text) return null;
    return text.length > MESSAGE_LIMIT ? `${text.slice(0, MESSAGE_LIMIT - 3).trimEnd()}...` : text;
}

/**
 * What a status code means for a credential, given what the provider said.
 *
 * Only the two codes that mean "not you" refuse, plus Anthropic's answers about
 * the workspace a key acts in. A 429 is the account's rate ceiling rather than a
 * verdict on the key, a 404 means the endpoint moved, and anything from 500 up
 * is the provider's morning, not this key's problem.
 *
 * The workspace sentences are the ones Anthropic documents, plus the wording a
 * `sk-ant-usr-` key was answered with on 2026-10-20:
 * https://platform.claude.com/docs/en/manage-claude/authentication#select-a-workspace
 */
export function classify(
    status: number,
    message: string | null = null,
    provider?: string
): KeyCheck {
    if (status >= 200 && status < 300) return { state: "valid" };
    const workspace = provider === "anthropic" ? workspaceVerdict(status, message) : null;
    if (workspace) return workspace;
    if (status === 401) {
        return {
            state: "rejected",
            code: "invalid",
            reason: "The provider did not accept that key.",
            words: { key: "invalid" }
        };
    }
    if (status === 403) {
        return {
            state: "rejected",
            code: "forbidden",
            reason: "That key does not carry the access this provider needs.",
            words: { key: "forbidden" }
        };
    }
    if (status === 429) {
        return {
            state: "unverified",
            code: "rate_limited",
            reason: "The provider is rate limiting this account, so the key could not be checked.",
            words: { key: "rateLimited" }
        };
    }
    if (message) {
        return {
            state: "unverified",
            code: "unknown",
            reason: `The provider answered ${status}: ${message}`,
            words: { key: "providerSaid", values: { status, message } }
        };
    }
    return {
        state: "unverified",
        code: "unknown",
        reason: `The provider answered ${status}, so the key could not be checked.`,
        words: { key: "status", values: { status } }
    };
}

/** Anthropic's three answers about a key's workspace, or null for anything else. */
function workspaceVerdict(status: number, message: string | null): KeyCheck | null {
    if (!message || !message.toLowerCase().includes("workspace")) return null;
    const said = message.toLowerCase();
    // "This API key is not scoped to a workspace, so this request must include the
    // anthropic-workspace-id header ..." and the documented "anthropic-workspace-id
    // is required when authenticating with an identity-linked API key ...".
    if (
        status === 400 &&
        (said.includes("not scoped to a workspace") || said.includes("is required"))
    ) {
        return {
            state: "rejected",
            code: "workspace",
            reason: "This key needs the ID of the Anthropic workspace to use. Add it under Workspace ID.",
            words: { key: "workspaceMissing" }
        };
    }
    // "anthropic-workspace-id header must be a valid workspace ID."
    if (status === 400 && said.includes("valid workspace id")) {
        return {
            state: "rejected",
            code: "workspace",
            reason: "That is not a workspace ID. Copy it from the Workspaces page of the Claude Console.",
            words: { key: "workspaceMalformed" }
        };
    }
    // "Workspace `wrkspc_...` not found." - unknown, or not open to this key.
    if (status === 404 && said.includes("not found")) {
        return {
            state: "rejected",
            code: "workspace",
            reason: "This key cannot use a workspace with that ID. Check the ID, or that the key has access to it.",
            words: { key: "workspaceNotFound" }
        };
    }
    return null;
}
