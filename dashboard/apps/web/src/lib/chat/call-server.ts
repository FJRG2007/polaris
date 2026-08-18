/**
 * The server a call runs through.
 *
 * Every call goes through one, and there is no second way. A browser sends its
 * microphone and its camera there once and receives everybody else's back, which
 * is what makes a call between two houses possible and a call between four
 * people cheap. Polaris ships one - the `livekit` service, started with the
 * stack - so a fresh install can already call, and an instance that runs its own
 * can be pointed at that instead.
 *
 * What this module does is mint the ticket. A browser is never given the signing
 * key: it asks for a token, this checks the seat it already holds in that call -
 * the same admission the waiting room enforces - and signs a token that is good
 * for that one room, for a few minutes. The media itself never passes through
 * Polaris.
 *
 * Server-only.
 */

import { prisma } from "@polaris/db";
import { loadEnv } from "@polaris/config";
import { AccessToken } from "livekit-server-sdk";
import { ensureCallKey } from "@/lib/chat/call-keys";
import {
    getIntegrationSecret,
    getIntegrationState,
    upsertIntegration
} from "@/lib/integration-service";

/** Where the pairing is kept. One per instance: a call server is infrastructure,
 *  not something a conversation chooses. */
const PROVIDER = "call-server";

/** How long a join token is good for. Long enough to answer a ringing call and
 *  short enough that one taken off a screen is worth nothing by the time anybody
 *  reads it - the browser asks for a fresh one every time it joins. */
const TOKEN_TTL = "10m";

/** What a screen says when there is nowhere for a call to run. Said rather than
 *  worked around: with no server there is no call, and a button that opens a
 *  microphone for a connection that cannot be made is the failure people report
 *  and nobody can act on. */
export const NO_CALL_SERVER =
    "The call server is not answering, so a call would reach nobody. An administrator can check it under Chat settings.";

/** What is stored beside the secret: everything that is not the secret. */
interface CallServerConfig {
    /** An address somebody typed, for a server they run themselves. */
    url?: string;
    apiKey?: string;
}

/** Where a call server is and what signs for it. */
export interface CallServerEndpoint {
    /** The address a browser connects to: a WebSocket URL, or a path on this
     *  deployment's own hostname. */
    readonly url: string;
    readonly apiKey: string;
    readonly apiSecret: string;
    /** Whether this is the one the stack runs, rather than one somebody typed.
     *  Decides where it is asked whether it is up: the shipped one answers on
     *  the host, and its `/livekit` path is only meaningful in a browser. */
    readonly shipped: boolean;
}

async function config(): Promise<CallServerConfig> {
    const state = await getIntegrationState(PROVIDER);
    return (state?.config ?? {}) as CallServerConfig;
}

/**
 * The call server this process was started with, if it was started with one.
 *
 * All three or none: a URL with no key signs nothing, and a key with no URL
 * points nowhere. Half a pairing is a misconfiguration rather than a server, and
 * treating it as one would take an instance that has a working admin-configured
 * server and quietly break its calls.
 */
function environmentServer(): CallServerEndpoint | null {
    const env = loadEnv();
    const url = env.POLARIS_CALL_SERVER_URL?.trim().replace(/\/+$/, "");
    const apiKey = env.POLARIS_CALL_SERVER_API_KEY?.trim();
    const apiSecret = env.POLARIS_CALL_SERVER_API_SECRET?.trim();
    if (!url || !apiKey || !apiSecret) return null;
    return { url: websocket(url), apiKey, apiSecret, shipped: servedHere(url) };
}

/** Whether an address names the host it is served from rather than another one.
 *  The browser resolves these against the page it is on, which is the only
 *  place the hostname somebody actually typed is known. */
function servedHere(address: string): boolean {
    return address.startsWith("/");
}

/** Point calls at a server somebody runs themselves, or unpoint them. A blank
 *  address clears the pairing, which is how this is switched off. */
export async function setCallServer(url: string, apiKey: string, apiSecret: string): Promise<void> {
    const trimmed = url.trim().replace(/\/+$/, "");
    if (trimmed) {
        let parsed: URL;
        try {
            parsed = new URL(trimmed);
        } catch {
            throw new Error("Write the address as wss://calls.example.com");
        }
        if (!/^wss?:$/.test(parsed.protocol) || !parsed.hostname) {
            throw new Error("Write the address as wss://calls.example.com");
        }
    }
    const current = await config();
    await upsertIntegration(PROVIDER, {
        enabled: true,
        config: {
            ...current,
            url: trimmed || undefined,
            apiKey: trimmed ? apiKey.trim() : undefined
        },
        // An empty secret on a save that only changed the address leaves the
        // stored one alone; clearing the address clears the pairing outright.
        ...(trimmed ? (apiSecret.trim() ? { secret: apiSecret.trim() } : {}) : { secret: null })
    });
}

/** The same address, as a browser has to dial it. LiveKit speaks WebSocket on
 *  the port it serves HTTP on. A path is left alone: it has no scheme to change,
 *  and the browser gives it the one the page is on. */
function websocket(address: string): string {
    if (servedHere(address)) return address;
    return address.replace(/^http:/, "ws:").replace(/^https:/, "wss:");
}

/**
 * The server this stack runs, which needs nothing configured anywhere.
 *
 * The address is a path, so the browser resolves it against whatever hostname it
 * reached Polaris on, and the key comes off the volume the two containers share
 * rather than out of `.env` - see `call-keys`. That is the whole point: `.env` is
 * written by the installer and an installed Polaris is only ever updated from a
 * button, so anything that has to appear there is a feature that is switched off
 * on every deployment in the world.
 *
 * Null only when the key file could not be read or written, which means there is
 * no shared volume, which means there is no media server beside this process
 * either.
 */
async function shippedServer(): Promise<CallServerEndpoint | null> {
    const key = await ensureCallKey();
    return key
        ? { url: SHIPPED_PATH, apiKey: key.apiKey, apiSecret: key.apiSecret, shipped: true }
        : null;
}

/** Where the shipped server is served from, and the default the browser is told
 *  to dial. It is a path rather than a hostname because only the browser knows
 *  which hostname it used. */
const SHIPPED_PATH = "/livekit";

/**
 * Where calls run, or null when there is nowhere at all.
 *
 * Three answers, in the order of how deliberately somebody chose them:
 *
 * 1. **A server named in this process's environment**, when it is somebody
 *    else's. An operator who put an address in `.env` has decided. A `/livekit`
 *    in there is not that decision - it is what every install written before the
 *    key file existed carries, and it names the shipped server anyway, whose key
 *    now lives on the volume rather than beside that line.
 * 2. **A server typed into the settings screen.**
 * 3. **The one this stack runs**, which is the answer on a deployment where
 *    nobody has done either - and that is meant to be almost all of them.
 */
export async function callServer(): Promise<CallServerEndpoint | null> {
    const fromEnv = environmentServer();
    if (fromEnv && !fromEnv.shipped) return fromEnv;

    const stored = await config();
    const secret = stored.url ? await getIntegrationSecret(PROVIDER) : null;
    if (stored.url && stored.apiKey && secret) {
        return { url: stored.url, apiKey: stored.apiKey, apiSecret: secret, shipped: false };
    }
    return shippedServer();
}

/**
 * A ticket for one room, for one person, for a few minutes.
 *
 * The grant is deliberately narrow: this room, this identity, and nothing about
 * any other. Whether the person is allowed in that room at all was decided
 * before this was called - by the seat they hold in the meeting - and this only
 * writes it down in a form the media server will believe.
 */
export async function joinToken(
    endpoint: CallServerEndpoint,
    room: string,
    /** The seat, which is what the media server knows somebody as. Not the
     *  account: a guest has no account and two tabs of one account are two
     *  seats. */
    participantId: string
): Promise<string> {
    // What to draw beside them, read here rather than passed in, so a caller
    // cannot decide what somebody is called on the way through.
    const participant = await prisma.meetingParticipant.findUnique({
        where: { id: participantId },
        select: { name: true }
    });

    const token = new AccessToken(endpoint.apiKey, endpoint.apiSecret, {
        identity: participantId,
        name: participant?.name ?? "",
        ttl: TOKEN_TTL
    });
    token.addGrant({
        room,
        roomJoin: true,
        canPublish: true,
        canSubscribe: true,
        // The data channel carries nothing here: everything Polaris has to say
        // about a call goes through Polaris, where it can be checked.
        canPublishData: false,
        // One thing a browser is allowed to say about itself, and only about
        // itself: whether its headphones are off. Nothing else can tell - a
        // person who has stopped listening publishes exactly what an attentive
        // one does - and it is a courtesy rather than a claim, so it does not
        // need to be believed to be worth carrying.
        canUpdateOwnMetadata: true
    });
    return token.toJwt();
}

/** What the settings screen shows. The signing key never goes back to a browser. */
export interface CallServerSettings {
    /** An address somebody typed, if they did. */
    readonly url: string;
    readonly hasKey: boolean;
    /** Whether calls run through the server this stack starts, rather than one
     *  somebody pointed them at. */
    readonly shipped: boolean;
    /** Whether calls have somewhere to run at all. */
    readonly ready: boolean;
    /** Whether it answers yet - a fresh install spends a moment starting, and
     *  "configured but silent" is the state people ask about. */
    readonly answering: boolean;
    /** Why the stored address is not where calls go, when one is stored and they
     *  do not: this process was started with a server of its own, or what was
     *  saved here is missing the key and secret that would let it sign. Null when
     *  it is in use, and when there is nothing stored to be in use. An address
     *  that is saved and silently unused is the state nobody can diagnose from a
     *  screen that only shows it. */
    readonly unused: "environment" | "incomplete" | null;
}

export async function callServerSettings(): Promise<CallServerSettings> {
    const stored = await config();
    const endpoint = await callServer();
    const fromEnv = environmentServer();
    return {
        url: stored.url ?? "",
        hasKey: Boolean(stored.apiKey),
        shipped: endpoint?.shipped ?? false,
        ready: endpoint !== null,
        answering: endpoint ? await answering(endpoint) : false,
        unused: !stored.url
            ? null
            : fromEnv && !fromEnv.shipped
              ? "environment"
              : endpoint && !endpoint.shipped
                ? null
                : "incomplete"
    };
}

/** Where the shipped call server answers from inside the stack. Two addresses
 *  because there are two ways this process runs: in a container beside it, where
 *  the host is reached by name, and directly on the machine in development. */
const INTERNAL_CALL_SERVER = ["http://host.docker.internal:7880", "http://127.0.0.1:7880"];

/** How long an answer stands. Every open Chat tab asks whether calls work, so
 *  without this a busy instance would knock on the media server once per poll
 *  per reader for a fact that changes when a container restarts. */
const ANSWER_TTL_MS = 10_000;

let lastAnswer: { at: number; url: string; answering: boolean } | null = null;

/** Throw the cached answer away. For a test that is a different instance every
 *  case; nothing in the app calls it, since the address changing already misses
 *  the cache and a container restarting is what the short life covers. */
export function forgetAnswer(): void {
    lastAnswer = null;
}

/**
 * Whether it answers at all.
 *
 * Asked over HTTP rather than over the address a browser dials, which is the
 * same server on the same port speaking the other half of its protocol: a
 * WebSocket handshake would need a signed token to get anywhere, and this
 * question is "is it up", not "may I join a call".
 *
 * Short timeout: this runs while a page is rendering, and a server still
 * starting is a fact to report rather than a reason to hold the page.
 */
export async function answering(endpoint: CallServerEndpoint): Promise<boolean> {
    if (
        lastAnswer &&
        lastAnswer.url === endpoint.url &&
        Date.now() - lastAnswer.at < ANSWER_TTL_MS
    ) {
        return lastAnswer.answering;
    }
    // A path names the edge in front of this app, which this process cannot
    // dial: it would have to know the hostname somebody typed, and only their
    // browser knows that. The shipped server answers on the host instead, which
    // is the same server reached the other way round.
    const addresses = endpoint.shipped
        ? INTERNAL_CALL_SERVER
        : [endpoint.url.replace(/^ws:/, "http:").replace(/^wss:/, "https:")];
    const answers = await Promise.all(
        addresses.map((address) =>
            fetch(address, { signal: AbortSignal.timeout(2500) })
                .then((response) => response.ok)
                .catch(() => false)
        )
    );
    const up = answers.some(Boolean);
    lastAnswer = { at: Date.now(), url: endpoint.url, answering: up };
    return up;
}

/**
 * Why a call cannot be started here, or null when one can.
 *
 * One question, asked by every screen with a call button on it and by the action
 * behind those buttons, so a button that is drawn as available is one the server
 * will accept.
 */
export async function callsUnavailable(): Promise<string | null> {
    const endpoint = await callServer();
    if (!endpoint) return NO_CALL_SERVER;
    return (await answering(endpoint)) ? null : NO_CALL_SERVER;
}
