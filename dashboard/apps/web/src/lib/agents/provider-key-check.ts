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

import { GATEWAY_SLUG } from "@/lib/agents/agent-providers";

/** Why a key was not accepted, in the terms a caller can branch on. */
export type KeyCheckCode = "invalid" | "forbidden" | "rate_limited" | "network" | "unknown" | "unsupported";

export type KeyCheck =
    | { state: "valid" }
    /** The provider refused the credential itself. */
    | { state: "rejected"; code: "invalid" | "forbidden"; reason: string }
    /** Nothing was learned. The key is stored, and a run is what proves it. */
    | { state: "unverified"; code: KeyCheckCode; reason: string };

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
    }
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
 */
export async function checkProviderKey(provider: string, secret: string): Promise<KeyCheck> {
    if (provider === GATEWAY_SLUG) {
        return {
            state: "unverified",
            code: "unsupported",
            reason: "An endpoint of your own is proven by the first run, not from here."
        };
    }
    const probe = PROBES[provider];
    if (!probe) {
        return {
            state: "unverified",
            code: "unsupported",
            reason: "Polaris has no way to check this provider's keys."
        };
    }

    const credential = probe.prefix ? `${probe.prefix}${secret.trim()}` : secret.trim();
    let response: Response;
    try {
        response = await fetch(probe.endpoint, {
            method: probe.method,
            headers: { [probe.header]: credential, ...probe.extraHeaders },
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
                : "Could not reach the provider to check the key."
        };
    }

    return classify(response.status);
}

/**
 * What a status code means for a credential.
 *
 * Only the two codes that mean "not you" refuse. A 429 is the account's rate
 * ceiling rather than a verdict on the key, a 404 means the endpoint moved, and
 * anything from 500 up is the provider's morning, not this key's problem.
 */
export function classify(status: number): KeyCheck {
    if (status >= 200 && status < 300) return { state: "valid" };
    if (status === 401) {
        return { state: "rejected", code: "invalid", reason: "The provider did not accept that key." };
    }
    if (status === 403) {
        return {
            state: "rejected",
            code: "forbidden",
            reason: "That key does not carry the access this provider needs."
        };
    }
    if (status === 429) {
        return {
            state: "unverified",
            code: "rate_limited",
            reason: "The provider is rate limiting this account, so the key could not be checked."
        };
    }
    return {
        state: "unverified",
        code: "unknown",
        reason: `The provider answered ${status}, so the key could not be checked.`
    };
}
