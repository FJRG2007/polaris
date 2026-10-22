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
    /** It cannot be undone: a key asks for a second press before it runs. */
    readonly confirm?: boolean;
    /** For a dial: what its value runs between, and how far a tick moves it. */
    readonly dial?: { readonly min: number; readonly max: number; readonly step: number };
}

/** The newest released plugin and Companion module, as Polaris knows them. */
export interface DeckReleases {
    readonly streamdeck: string | null;
    readonly companion: string | null;
    /** The page of that Polaris that offers both. */
    readonly downloadsPath: string;
}

/** What `GET /api/deck/actions` answers. `latest` is missing from a Polaris
 *  older than the field. */
export interface DeckListing {
    readonly actions: DeckAction[];
    readonly latest: DeckReleases | null;
    /** Actions this deck's key lacks the permission for though its owner holds
     *  it; empty from a Polaris older than the field. */
    readonly locked: readonly DeckLocked[];
}

/** An action connecting the deck again would allow, and the sentence that
 *  says so, in the account's language. */
export interface DeckLocked {
    readonly id: string;
    readonly label: string;
    readonly message: string;
}

/** `locked` as it arrived, keeping only well-formed rows. */
export function readLocked(raw: unknown): DeckLocked[] {
    if (!Array.isArray(raw)) return [];
    return raw.filter(
        (row): row is DeckLocked =>
            typeof row?.id === "string" &&
            typeof row?.label === "string" &&
            typeof row?.message === "string"
    );
}

/** How long a press waits for Polaris before its key is put back. Polaris
 *  waits up to 8 s for a device to confirm a command. */
export const RUN_TIMEOUT_MS = 15_000;

/** A press Polaris did not answer within `RUN_TIMEOUT_MS`. */
export class TimedOut extends Error {}

/** `latest` as it arrived, kept only when every part has the expected type. */
export function readReleases(raw: unknown): DeckReleases | null {
    const value = raw as Partial<Record<keyof DeckReleases, unknown>> | null;
    if (!value || typeof value !== "object" || typeof value.downloadsPath !== "string") return null;
    const version = (field: unknown) => (typeof field === "string" ? field : null);
    return {
        streamdeck: version(value.streamdeck),
        companion: version(value.companion),
        downloadsPath: value.downloadsPath
    };
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
    /** What it is now - a crossed-out microphone, a fan rather than a bulb -
     *  drawn instead of the action's icon when the plugin knows the name. */
    readonly icon?: string;
    /** What a press does from here: the face to show at once, or that it is
     *  already done. From a Polaris that knows; absent otherwise. */
    readonly press?: {
        readonly face?: DeckState;
        readonly noop?: boolean;
    };
    /** A timer kept in Polaris: what the key counts down from between
     *  readings. `endsAt` and `serverNow` are on Polaris's clock, and only
     *  there while it runs. */
    readonly countdown?: {
        readonly state: "running" | "paused" | "rung" | "idle";
        readonly remainingMs: number;
        readonly durationMs: number;
        readonly endsAt?: number;
        readonly serverNow?: number;
        readonly phase?: "focus" | "short" | "long";
    };
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
 *  shape Polaris reads a client's system from. The Companion module shares this
 *  client and names itself `polaris-companion`. */
export function userAgent(version: string, product = "polaris-streamdeck"): string {
    return `${product}/${version} (${process.platform}; ${process.arch}; node ${process.versions.node})`;
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
        private readonly fetcher: Fetch = fetch,
        private readonly product = "polaris-streamdeck"
    ) {}

    #headers(token?: string): Record<string, string> {
        return {
            accept: "application/json",
            "content-type": "application/json",
            "user-agent": userAgent(this.version, this.product),
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
        return (await this.listing(credentials)).actions;
    }

    /** The catalogue, and the newest releases Polaris knows of. */
    async listing(credentials: Credentials): Promise<DeckListing> {
        const response = await this.fetcher(`${credentials.address}/api/deck/actions`, {
            headers: this.#headers(credentials.token)
        });
        const body = await this.#json<{
            actions: DeckAction[];
            latest?: unknown;
            locked?: unknown;
        }>(response);
        return {
            actions: body.actions,
            latest: readReleases(body.latest),
            locked: readLocked(body.locked)
        };
    }

    async run(
        credentials: Credentials,
        action: string,
        options: Record<string, unknown>,
        step?: number,
        push?: boolean
    ): Promise<RunResult> {
        let response: Response;
        try {
            response = await this.fetcher(`${credentials.address}/api/deck/run`, {
                method: "POST",
                headers: this.#headers(credentials.token),
                body: JSON.stringify({
                    action,
                    options,
                    ...(step === undefined ? {} : { step }),
                    ...(push ? { push: true } : {})
                }),
                signal: AbortSignal.timeout(RUN_TIMEOUT_MS)
            });
        } catch (caught) {
            if ((caught as { name?: string } | null)?.name === "TimeoutError") throw new TimedOut();
            throw caught;
        }
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
