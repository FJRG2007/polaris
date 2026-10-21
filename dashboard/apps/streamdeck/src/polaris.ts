/**
 * Talking to Polaris: connecting a deck, the catalogue, runs and the state
 * stream.
 *
 * Every request carries the deck's key and a user-agent Polaris reads the
 * computer's system from. A 401 from any of them means the key is gone -
 * revoked, expired or disconnected from the Downloads screen - and is reported
 * as such so the keys can say "Sign in" instead of retrying forever.
 *
 * The SDK-free half of the plugin, so the tests reach it with a stubbed fetch.
 */

import os from "node:os";
import { SseReader } from "./sse";

/** One entry of the catalogue, as `GET /api/deck/actions` hands it out. */
export interface DeckAction {
    readonly id: string;
    readonly kind: "run" | "toggle" | "state" | "dial" | "open";
    readonly area: string;
    readonly label: string;
    readonly icon: string;
    readonly options: readonly DeckField[];
    readonly live: boolean;
    readonly path?: string;
}

export interface DeckField {
    readonly name: string;
    readonly type: "text" | "number" | "choice";
    readonly label: string;
    readonly required: boolean;
    readonly choices?: readonly { readonly value: string; readonly label: string }[];
    readonly min?: number;
    readonly max?: number;
}

export interface DeckState {
    readonly tone: "ok" | "warn" | "bad" | "idle";
    readonly value?: string;
    readonly on?: boolean;
    readonly detail?: string;
}

export type RunResult =
    | { readonly ok: true; readonly state?: DeckState }
    | { readonly ok: false; readonly message: string };

/** Where the deck stands with Polaris. */
export type Link = "unset" | "connecting" | "online" | "offline" | "unauthorized";

/** A request Polaris answered 401: the key no longer opens anything. */
export class Unauthorized extends Error {}

/** A request Polaris answered 429: the key works, and has to wait `retryMs`. */
export class Throttled extends Error {
    constructor(
        message: string,
        readonly retryMs: number
    ) {
        super(message);
    }
}

/** What a 429 says: how long to wait, from its `retry-after`, and why. */
async function throttled(response: Response): Promise<Throttled> {
    const seconds = Number(response.headers.get("retry-after"));
    const body = (await response.json().catch(() => null)) as { error?: unknown } | null;
    return new Throttled(
        typeof body?.error === "string" ? body.error : `Polaris answered ${response.status}`,
        Number.isFinite(seconds) && seconds > 0 ? Math.min(seconds, 3600) * 1000 : 60_000
    );
}

/** What a deck stores about its connection, in the plugin's global settings. */
export interface Credentials {
    readonly address: string;
    readonly token: string;
    readonly keyId?: string;
    readonly account?: string;
}

/** Read stored credentials, or null when there are none worth using. */
export function readCredentials(raw: unknown): Credentials | null {
    const value = raw as Partial<Credentials> | null;
    if (!value || typeof value.address !== "string" || typeof value.token !== "string") return null;
    if (value.address === "" || value.token === "") return null;
    return {
        address: value.address,
        token: value.token,
        ...(typeof value.keyId === "string" ? { keyId: value.keyId } : {}),
        ...(typeof value.account === "string" ? { account: value.account } : {})
    };
}

/** `polaris-streamdeck/<version> (<platform>; <arch>; node <version>)`, the
 *  shape Polaris reads a client's system from. */
export function userAgent(version: string): string {
    return `polaris-streamdeck/${version} (${process.platform}; ${process.arch}; node ${process.versions.node})`;
}

/** What `/api/deck/authorize` answers. */
export interface OpenedRequest {
    readonly userCode: string;
    readonly deviceCode: string;
    readonly pollMs: number;
    readonly expiresAt: string;
    readonly approvePath: string;
}

export type Claimed =
    | { readonly status: "pending" | "denied" | "expired" }
    | {
          readonly status: "approved";
          readonly token: string;
          readonly keyId: string;
          readonly account: { readonly name: string; readonly email: string };
      };

type Fetch = typeof fetch;

export class PolarisClient {
    constructor(
        readonly version: string,
        private readonly fetcher: Fetch = fetch
    ) {}

    #headers(token?: string): Record<string, string> {
        return {
            accept: "application/json",
            "content-type": "application/json",
            "user-agent": userAgent(this.version),
            ...(token ? { authorization: `Bearer ${token}` } : {})
        };
    }

    async #json<T>(response: Response): Promise<T> {
        if (response.status === 401) throw new Unauthorized();
        if (response.status === 429) throw await throttled(response);
        const body = (await response.json().catch(() => null)) as T | { error?: string } | null;
        if (!response.ok && response.status !== 422) {
            const message = (body as { error?: string } | null)?.error;
            throw new Error(message || `Polaris answered ${response.status}`);
        }
        return body as T;
    }

    /** Ask to connect this computer's deck. */
    async open(address: string): Promise<OpenedRequest> {
        const response = await this.fetcher(`${address}/api/deck/authorize`, {
            method: "POST",
            headers: this.#headers(),
            body: JSON.stringify({
                deviceName: os.hostname().slice(0, 80) || "Stream Deck",
                clientVersion: this.version
            })
        });
        return this.#json<OpenedRequest>(response);
    }

    /** Where a request stands; the key once approved. */
    async claim(address: string, deviceCode: string): Promise<Claimed> {
        const response = await this.fetcher(`${address}/api/deck/authorize/claim`, {
            method: "POST",
            headers: this.#headers(),
            body: JSON.stringify({ deviceCode })
        });
        return this.#json<Claimed>(response);
    }

    async catalogue(credentials: Credentials): Promise<DeckAction[]> {
        const response = await this.fetcher(`${credentials.address}/api/deck/actions`, {
            headers: this.#headers(credentials.token)
        });
        return (await this.#json<{ actions: DeckAction[] }>(response)).actions;
    }

    async run(
        credentials: Credentials,
        action: string,
        options: Record<string, unknown>,
        step?: number
    ): Promise<RunResult> {
        const response = await this.fetcher(`${credentials.address}/api/deck/run`, {
            method: "POST",
            headers: this.#headers(credentials.token),
            body: JSON.stringify({ action, options, ...(step === undefined ? {} : { step }) })
        });
        return this.#json<RunResult>(response);
    }

    /** Ask Polaris to revoke the key this deck holds. */
    async end(credentials: Credentials): Promise<void> {
        const response = await this.fetcher(`${credentials.address}/api/deck/session`, {
            method: "DELETE",
            headers: this.#headers(credentials.token)
        });
        // Already gone is what was asked for.
        if (response.status !== 204 && response.status !== 401) {
            throw new Error(`Polaris answered ${response.status}`);
        }
    }

    /**
     * Hold the state stream open, calling `onReadings` for every frame, until
     * it ends or `signal` aborts. Throws `Unauthorized` on a 401 and
     * `Throttled` on a 429.
     */
    async stream(
        credentials: Credentials,
        watched: readonly { key: string; action: string; options: Record<string, unknown> }[],
        onReadings: (readings: { key: string; state: DeckState }[]) => void,
        signal: AbortSignal
    ): Promise<void> {
        const watch = Buffer.from(JSON.stringify(watched)).toString("base64url");
        const response = await this.fetcher(
            `${credentials.address}/api/deck/state?watch=${watch}`,
            {
                headers: { ...this.#headers(credentials.token), accept: "text/event-stream" },
                signal
            }
        );
        if (response.status === 401) throw new Unauthorized();
        if (response.status === 429) throw await throttled(response);
        if (!response.ok || !response.body) throw new Error(`Polaris answered ${response.status}`);
        const reader = new SseReader();
        const decoder = new TextDecoder();
        for await (const chunk of response.body as unknown as AsyncIterable<Uint8Array>) {
            for (const event of reader.push(decoder.decode(chunk, { stream: true }))) {
                if (event.event !== "state") continue;
                try {
                    const parsed = JSON.parse(event.data) as {
                        readings?: { key: string; state: DeckState }[];
                    };
                    if (Array.isArray(parsed.readings)) onReadings(parsed.readings);
                } catch {
                    // A frame that does not parse is skipped; the next one carries on.
                }
            }
        }
    }
}
