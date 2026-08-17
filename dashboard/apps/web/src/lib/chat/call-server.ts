/**
 * The server a call runs through.
 *
 * Chat's calls were browser-to-browser, which is the right shape for two people
 * in one house and the wrong one for everybody else. With nothing in the middle,
 * each browser can only offer the addresses of the network it is on, so a call
 * between two houses needs a STUN server to discover a public address and a TURN
 * server whenever that is not enough - and with neither, it simply never
 * connects: both people sit there watching each other's names and hearing
 * nothing. It also does not scale: four people is twelve connections and four
 * uploads of the same camera.
 *
 * So there is a server in the middle now, and it is the piece every product that
 * does this uses: LiveKit, an SFU. Each browser sends its microphone and its
 * camera to it once and receives everybody else's back. Polaris installs it the
 * way Home installs the recognizer - one container, on a machine the owner picks,
 * with a key nobody types - and a house that already runs one can point at that
 * instead.
 *
 * What Polaris does here is mint the ticket. A browser is never given the signing
 * key: it asks for a token, this checks the seat it already holds in that call -
 * the same admission the waiting room enforces - and signs a token that is good
 * for that one room, for a few minutes. The media itself never passes through
 * Polaris.
 *
 * Server-only.
 */

import { prisma } from "@polaris/db";
import { AccessToken } from "livekit-server-sdk";
import { installApp } from "@/lib/apps/install-service";
import { installEnvSecret } from "@/lib/apps/install-secret";
import { assertServer, findService, serviceUrls } from "@/lib/home/side-service";
import { getIntegrationSecret, getIntegrationState, upsertIntegration } from "@/lib/integration-service";

/** The catalog app this module installs. */
const CALL_APP = "call-server";

/** Where the pairing is kept. One per instance: a call server is infrastructure,
 *  not something a conversation chooses. */
const PROVIDER = "call-server";

/** How long a join token is good for. Long enough to answer a ringing call and
 *  short enough that one taken off a screen is worth nothing by the time anybody
 *  reads it - the browser asks for a fresh one every time it joins. */
const TOKEN_TTL = "10m";

/** What is stored beside the secret: everything that is not the secret. */
interface CallServerConfig {
    /** The install Polaris put up, when it did. Takes precedence - it is the one
     *  this instance is responsible for. */
    installId?: string;
    /** An address somebody typed, for a server they run themselves. */
    url?: string;
    apiKey?: string;
}

/** Where a call server is and what signs for it. */
export interface CallServerEndpoint {
    /** The address a browser connects to, as a WebSocket URL. */
    readonly url: string;
    readonly apiKey: string;
    readonly apiSecret: string;
}

async function config(): Promise<CallServerConfig> {
    const state = await getIntegrationState(PROVIDER);
    return (state?.config ?? {}) as CallServerConfig;
}

/**
 * Put a call server on a server.
 *
 * Idempotent: a machine that already has one is adopted rather than given a
 * second. Two of them would each hold half of a call, and nobody in it would
 * hear everybody.
 */
export async function installCallServer(
    ownerId: string,
    actorId: string,
    serverId: string
): Promise<void> {
    await assertServer(ownerId, serverId);

    if (!(await findService(CALL_APP, serverId))) {
        await installApp(ownerId, actorId, {
            catalogId: CALL_APP,
            name: "Call server",
            serverId,
            storage: [],
            // Its key is minted by the install and never shown: Polaris is the
            // only thing that signs with it.
            env: []
        });
    }
    const service = await findService(CALL_APP, serverId);
    if (!service) throw new Error("The call server was installed but cannot be found");

    // The typed address is left alone rather than cleared, so somebody who had
    // their own server can go back to it by removing this install.
    await upsertIntegration(PROVIDER, {
        enabled: true,
        config: { ...(await config()), installId: service.installedAppId }
    });
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
        config: { ...current, url: trimmed || undefined, apiKey: trimmed ? apiKey.trim() : undefined },
        // An empty secret on a save that only changed the address leaves the
        // stored one alone; clearing the address clears the pairing outright.
        ...(trimmed ? (apiSecret.trim() ? { secret: apiSecret.trim() } : {}) : { secret: null })
    });
}

/**
 * The one Polaris installed, resolved now rather than written down.
 *
 * Its address is whatever Deploy publishes for it today, and its key is read
 * back off the install's own environment - the same place the container reads
 * it from, so there is one copy of it and it is never in two places disagreeing.
 */
async function installedServer(installId: string): Promise<CallServerEndpoint | null> {
    const row = await prisma.installedApp.findFirst({
        where: { id: installId, status: { not: "removed" }, applicationId: { not: null } },
        select: { applicationId: true, ownerId: true }
    });
    if (!row?.applicationId) return null;
    const [urls, keys] = await Promise.all([
        serviceUrls(row.applicationId, row.ownerId),
        installEnvSecret(row.applicationId, row.ownerId, "LIVEKIT_KEYS")
    ]);
    if (!urls || !keys) return null;

    // `name: secret`, which is the shape the server reads and therefore the shape
    // it was minted in. Anything else is an install somebody edited by hand.
    const [apiKey, apiSecret] = splitKeys(keys);
    if (!apiKey || !apiSecret) return null;
    return { url: websocket(urls.baseUrl), apiKey, apiSecret };
}

/** `polaris: <secret>` as its two halves. */
function splitKeys(keys: string): [string, string] {
    const at = keys.indexOf(":");
    if (at < 0) return ["", ""];
    return [keys.slice(0, at).trim(), keys.slice(at + 1).trim()];
}

/** The same address, as a browser has to dial it. LiveKit speaks WebSocket on
 *  the port Deploy publishes as HTTP. */
function websocket(address: string): string {
    return address.replace(/^http:/, "ws:").replace(/^https:/, "wss:");
}

/** Where calls run, or null when nothing has been set up - in which case Chat
 *  falls back to browser-to-browser, which still works inside one network. */
export async function callServer(): Promise<CallServerEndpoint | null> {
    const stored = await config();
    if (stored.installId) {
        const installed = await installedServer(stored.installId);
        if (installed) return installed;
    }
    const secret = stored.url ? await getIntegrationSecret(PROVIDER) : null;
    return stored.url && stored.apiKey && secret
        ? { url: stored.url, apiKey: stored.apiKey, apiSecret: secret }
        : null;
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
    /** Whether Polaris is running one of its own, and where. */
    readonly installedOn: string | null;
    /** Whether calls have somewhere to run at all. */
    readonly ready: boolean;
    /** Whether it answers yet - a fresh install spends a minute or two starting,
     *  and "installed but silent" is the state people ask about. */
    readonly answering: boolean;
}

export async function callServerSettings(): Promise<CallServerSettings> {
    const stored = await config();
    const endpoint = await callServer();
    return {
        url: stored.url ?? "",
        hasKey: Boolean(stored.apiKey),
        installedOn: stored.installId ? await serverNameFor(stored.installId) : null,
        ready: endpoint !== null,
        answering: endpoint ? await answering(endpoint) : false
    };
}

/**
 * Whether it answers at all.
 *
 * Asked over HTTP rather than over the address a browser dials, which is the
 * same server on the same port speaking the other half of its protocol: a
 * WebSocket handshake would need a signed token to get anywhere, and this
 * question is "is the container up", not "may I join a call".
 *
 * Short timeout: this runs while a settings page is rendering, and a server
 * still starting is a fact to report rather than a reason to hold the page.
 */
async function answering(endpoint: CallServerEndpoint): Promise<boolean> {
    const address = endpoint.url.replace(/^ws:/, "http:").replace(/^wss:/, "https:");
    const response = await fetch(address, { signal: AbortSignal.timeout(2500) }).catch(() => null);
    return response?.ok === true;
}

/** Which machine the installed server sits on, in words. Null when the install
 *  has gone, which is also how the screen offers to put one back. */
async function serverNameFor(installId: string): Promise<string | null> {
    const row = await prisma.installedApp.findFirst({
        where: { id: installId, status: { not: "removed" } },
        select: { targetId: true }
    });
    if (!row) return null;
    if (!row.targetId) return "this server";
    const target = await prisma.deployTarget.findFirst({
        where: { id: row.targetId },
        select: { kind: true, name: true, host: { select: { name: true } } }
    });
    if (!target || target.kind === "local") return "this server";
    return target.host?.name ?? target.name ?? "another server";
}
