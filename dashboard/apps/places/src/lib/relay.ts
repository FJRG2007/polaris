/**
 * The one connection per camera, and everybody who watches it.
 *
 * A camera will nearly always allow exactly one connection to its good stream.
 * Two people opening the wall at once is enough to break that, and so is one
 * person watching while a detector looks at the same stream. So nothing in
 * Polaris ever opens a camera directly: the relay holds the single connection
 * and re-serves it, without re-encoding anything, to as many viewers as there
 * are. That is also why the whole thing costs almost nothing - copying packets
 * is not the expensive part of video, decoding is, and nothing here decodes.
 *
 * The relay is a marketplace app installed on demand: a house with no camera
 * runs nothing at all, and the first camera brings one up on the machine it was
 * told to use. A camera on a network Polaris cannot see gets a relay on a server
 * that CAN see it, which is what makes that camera reachable at all.
 *
 * Server-only.
 */

import { cameraVendor, redactSource, relaySource } from "./vendors";
import { drawsFromBattery } from "./camera-models";
import { streamPathOf } from "./stream-path";
import { RELAY_LOG_TAIL, UNEXPLAINED, explainRelayFailure, relaySaid } from "./relay-failure";
import { HomeError } from "./home-error";
import { talkStreamName } from "./talk-audio";
import type { CameraTarget } from "./cameras";
import {
    assertServer,
    findService,
    serviceUrls,
    type ServiceUrls,
    type SideService
} from "./side-service";
import { host } from "@polaris/app-host";

const { installApp } = host.appsInstallService;
const { installEnvSecret, installEnvValue } = host.appsInstallSecret;

/** The catalog app this module installs and talks to. */
const RELAY_APP = "camera-hub";

/** Where a relay is, and how to prove to it that this is Polaris asking. */
export interface RelayEndpoint extends ServiceUrls {
    readonly installedAppId: string;
    readonly username: string;
    readonly password: string;
}

/** Where a camera's connection is made from: "local", or the id of the server
 *  that can see it. Read off the camera's own `reachVia`. */
export function relayServerFor(reachVia: string): string {
    return reachVia.startsWith("server:") ? reachVia.slice("server:".length) : "local";
}

/** The name a camera's stream has inside the relay. Derived from the id rather
 *  than the name so renaming a camera does not orphan its stream. */
export function streamName(cameraId: string, quality: "main" | "sub"): string {
    return `${cameraId}-${quality}`;
}

/** The account the relay was installed with, read back from the app's own
 *  environment - see install-secret for why it is not kept twice. */
async function relayCredentials(
    applicationId: string,
    ownerId: string
): Promise<{ username: string; password: string } | null> {
    const [username, password] = await Promise.all([
        installEnvValue(applicationId, ownerId, "RELAY_USERNAME", "polaris"),
        installEnvSecret(applicationId, ownerId, "RELAY_PASSWORD")
    ]);
    return password ? { username, password } : null;
}

/** The relay serving one server, or null when there is not one yet. */
export async function relayEndpoint(serverId: string): Promise<RelayEndpoint | null> {
    const relay = await findService(RELAY_APP, serverId);
    if (!relay) return null;
    const [urls, auth] = await Promise.all([
        serviceUrls(relay.applicationId, relay.ownerId),
        relayCredentials(relay.applicationId, relay.ownerId)
    ]);
    if (!urls || !auth) return null;
    return { installedAppId: relay.installedAppId, ...urls, ...auth };
}

/**
 * The relay serving one server, installing it if this is the first camera there.
 *
 * Installing is a deploy, so this is slow the first time and instant every time
 * after. Callers that are rendering must not use it - the wall asks
 * `relayEndpoint` and shows a camera as "starting" instead of holding the page
 * open on a container pull.
 */
export async function ensureRelay(
    ownerId: string,
    actorId: string,
    serverId: string
): Promise<RelayEndpoint> {
    const existing = await relayEndpoint(serverId);
    if (existing) return existing;

    await assertServer(ownerId, serverId);
    await installApp(ownerId, actorId, {
        catalogId: RELAY_APP,
        name: "Camera relay",
        serverId,
        storage: [],
        env: []
    });
    const endpoint = await relayEndpoint(serverId);
    if (!endpoint) throw new HomeError("The camera relay was installed but is not answering yet");
    return endpoint;
}

function authHeader(endpoint: RelayEndpoint): string {
    return `Basic ${Buffer.from(`${endpoint.username}:${endpoint.password}`).toString("base64")}`;
}

/** One call to a relay. Short timeout: everything here happens while somebody is
 *  waiting, and a relay that is not answering should say so rather than hold a
 *  page open. */
async function relayFetch(
    endpoint: RelayEndpoint,
    path: string,
    init: {
        method?: string;
        /** Null waits for the answer as long as the call lasts: a pushed stream
         *  is answered only once the push ends. */
        timeoutMs?: number | null;
        headers?: Record<string, string>;
        /** A stream is sent as it is written, for as long as it stays open. */
        body?: string | ReadableStream<Uint8Array>;
        /**
         * The watcher's own request. A live stream ends when whoever was watching
         * closes the tab, and without this it does not: the relay keeps sending,
         * this process keeps reading, and go2rtc keeps a consumer for a viewer
         * who left. They accumulate, and a relay carrying a dozen ghosts is the
         * one that starts stuttering for the people still there.
         */
        signal?: AbortSignal;
    } = {}
): Promise<Response> {
    const controller = new AbortController();
    // The timeout is on getting a response started, not on the body: video reads
    // for as long as somebody watches. Cleared as soon as the headers land.
    const timer =
        init.timeoutMs === null
            ? undefined
            : setTimeout(() => controller.abort(), init.timeoutMs ?? 5000);
    if (init.signal) {
        if (init.signal.aborted) controller.abort();
        else init.signal.addEventListener("abort", () => controller.abort(), { once: true });
    }
    try {
        return await fetch(`${endpoint.baseUrl}${path}`, {
            method: init.method ?? "GET",
            headers: { authorization: authHeader(endpoint), ...(init.headers ?? {}) },
            ...(init.body === undefined ? {} : { body: init.body }),
            // Required by fetch for a body that is still being written.
            ...(typeof init.body === "object" ? { duplex: "half" } : {}),
            signal: controller.signal,
            redirect: "manual"
        } as RequestInit);
    } finally {
        clearTimeout(timer);
    }
}

/**
 * Tell the relay about a camera: the good stream and the small one, under names
 * derived from its id.
 *
 * Setting a stream does not connect to the camera. go2rtc dials a source when
 * something asks to consume it and drops it when the last consumer leaves, which
 * is the behavior that makes "added but never opened" cost nothing.
 */
export async function publishCamera(
    endpoint: RelayEndpoint,
    camera: CameraTarget,
    vendor: string,
    options: { warm?: boolean } = {}
): Promise<void> {
    const auth = { username: camera.username, password: camera.password };
    const shape = {
        vendor,
        address: camera.address,
        rtspPort: camera.rtspPort,
        mainPath: mainPathOf(camera),
        subPath: subPathOf(camera)
    };
    for (const quality of ["main", "sub"] as const) {
        const source = relaySource(shape, quality, auth);
        const query = new URLSearchParams({ name: streamName(camera.id, quality), src: source });
        const response = await relayFetch(endpoint, `/api/streams?${query.toString()}`, {
            method: "PUT"
        });
        // The relay validates the source and refuses one it cannot parse. Its
        // reason is about a URL that carries a password, so it is not passed on.
        if (!response.ok) throw new HomeError("The relay would not accept that camera");
    }
    // Asked again every time, not only when it changes: writing a stream
    // replaces it inside the relay, and a warm connection held on the one it
    // replaced is a second connection to the camera that nothing can see or
    // close. Pointing the warm connection at the stream again moves it over and
    // lets the old one stop.
    await warmStream(endpoint, streamName(camera.id, "main"), options.warm === true);
}

/**
 * Whether a camera's good stream is kept connected with nobody watching.
 *
 * This is what makes opening a camera fast. A relay connects to a camera when
 * somebody asks to watch it and lets go when the last viewer leaves, so every
 * opening paid for a fresh conversation with the camera - its handshake, then
 * its next keyframe - before there was anything to send. A camera the relay
 * already holds only costs the keyframe.
 *
 * It costs the relay nothing worth counting: holding a stream is copying
 * packets, and nothing decodes them. It costs the camera one connection it was
 * going to give the first viewer anyway. What it would cost a battery camera is
 * the battery, so those are never kept - they wake when somebody opens them, as
 * the maker's own app does. A camera that is switched off is not kept either.
 */
export function keepsWarm(camera: {
    enabled: boolean;
    power: string;
    vendor: string;
    privacy?: boolean;
}): boolean {
    if (!camera.enabled || camera.privacy) return false;
    if (drawsFromBattery(camera.power)) return false;
    return cameraVendor(camera.vendor).battery !== true;
}

/**
 * The streams a relay is holding open with nobody watching.
 *
 * Null when it could not be asked - a relay that is down, and a relay from a
 * build before it was allowed to be asked, which answers that it does not know
 * the path. Neither is an empty list: reading one as "nothing is warm" would
 * have the next step try to warm everything on a relay that will refuse it.
 */
export async function warmStreams(endpoint: RelayEndpoint): Promise<string[] | null> {
    const response = await relayFetch(endpoint, "/api/preload", { timeoutMs: 3000 }).catch(
        () => null
    );
    if (!response?.ok) return null;
    const body = (await response.json().catch(() => null)) as Record<string, unknown> | null;
    return body && typeof body === "object" ? Object.keys(body) : null;
}

/**
 * Hold a stream open with nobody watching, or let it go.
 *
 * Best effort and quiet about it. Keeping a camera warm is about how fast it
 * opens, never about whether it works, so a relay that will not do it - an old
 * one, or one that has not seen the camera yet - is a camera that opens the way
 * it always did, not an error on anybody's screen.
 */
export async function warmStream(
    endpoint: RelayEndpoint,
    name: string,
    on: boolean
): Promise<boolean> {
    const response = await relayFetch(endpoint, `/api/preload?src=${encodeURIComponent(name)}`, {
        method: on ? "PUT" : "DELETE"
    }).catch(() => null);
    return response?.ok === true;
}

/**
 * What to change so a relay holds exactly the cameras it should.
 *
 * Only cameras the relay is already serving are warmed: it refuses to hold a
 * stream it has not been given. Anything it holds that is not wanted - a camera
 * switched off, deleted, or moved to a battery - is let go.
 *
 * Pure, so the rules are tests.
 */
export function warmPlan(
    cameras: readonly { id: string; enabled: boolean; power: string; vendor: string }[],
    published: readonly string[],
    warm: readonly string[]
): { add: string[]; drop: string[] } {
    const serving = new Set(published);
    const wanted = new Set(
        cameras
            .filter(keepsWarm)
            .map((camera) => streamName(camera.id, "main"))
            .filter((name) => serving.has(name))
    );
    const held = new Set(warm);
    return {
        add: [...wanted].filter((name) => !held.has(name)),
        drop: [...held].filter((name) => !wanted.has(name))
    };
}

/** Stop serving a camera, both qualities. Best effort: a relay that has already
 *  forgotten it is the state we were asking for. */
export async function unpublishCamera(endpoint: RelayEndpoint, cameraId: string): Promise<void> {
    for (const quality of ["main", "sub"] as const) {
        // The warm connection first. Forgetting a stream does not close what is
        // attached to it, so a camera removed while warm would otherwise stay
        // connected to a relay that no longer lists it.
        await warmStream(endpoint, streamName(cameraId, quality), false);
        await relayFetch(
            endpoint,
            `/api/streams?src=${encodeURIComponent(streamName(cameraId, quality))}`,
            {
                method: "DELETE"
            }
        ).catch(() => null);
    }
}

/**
 * Which streams a relay currently holds. Used to reconcile after a restart, and
 * to tell "not published yet" from "published and the camera is down".
 *
 * Null when the relay could not be asked, which is not the same answer as an
 * empty list and must not be read as one: a relay that is down holds no streams
 * as far as this call can see, and anything that concluded "nothing was ever
 * published here" from that would be drawing the opposite conclusion from the
 * truth - every camera on it has just become unwatchable.
 */
export async function publishedStreams(endpoint: RelayEndpoint): Promise<string[] | null> {
    const response = await relayFetch(endpoint, "/api/streams", { timeoutMs: 3000 }).catch(
        () => null
    );
    if (!response?.ok) return null;
    const body = (await response.json().catch(() => null)) as Record<string, unknown> | null;
    return body ? Object.keys(body) : [];
}

/** Bytes received so far by each stream that has a connected producer and
 *  somebody waiting on it, by stream name. */
export type StreamTraffic = Record<string, number>;

/**
 * Restarting the relay drops every camera for the seconds it takes to come back,
 * so it is done at most this often however many streams keep stalling.
 */
export const RELAY_RESTART_COOLDOWN_MS = 5 * 60_000;

/** The longest a relay that keeps stalling waits between restarts. */
export const RELAY_RESTART_COOLDOWN_MAX_MS = 60 * 60_000;

/**
 * How long after a restart the next one waits.
 *
 * Doubles for each restart in a row that did not free the streams it was for:
 * a camera that stays stalled through a restart is not one a restart fixes, and
 * every restart drops every other camera on the relay with it.
 */
export function relayRestartCooldownMs(fruitless: number): number {
    const doublings = Math.max(0, Math.min(fruitless, 10));
    return Math.min(RELAY_RESTART_COOLDOWN_MS * 2 ** doublings, RELAY_RESTART_COOLDOWN_MAX_MS);
}

/**
 * What each stream is receiving, from the relay's `GET /api/streams` answer.
 *
 * A connected producer reports its byte count and one that is not connected
 * only its address, and a stream nobody is waiting on is idle rather than
 * stalled - so only streams with both are counted.
 */
export function streamTraffic(body: Record<string, unknown>): StreamTraffic {
    const traffic: StreamTraffic = {};
    for (const [name, stream] of Object.entries(body)) {
        if (!stream || typeof stream !== "object") continue;
        const { producers, consumers } = stream as { producers?: unknown; consumers?: unknown };
        if (!Array.isArray(consumers) || consumers.length === 0) continue;
        if (!Array.isArray(producers)) continue;
        let received: number | null = null;
        for (const producer of producers) {
            const bytes = (producer as { bytes_recv?: unknown } | null)?.bytes_recv;
            if (typeof bytes === "number" && Number.isFinite(bytes)) {
                received = (received ?? 0) + bytes;
            }
        }
        if (received !== null) traffic[name] = received;
    }
    return traffic;
}

/** What each stream is receiving, or null when the relay could not be asked. */
export async function relayTraffic(endpoint: RelayEndpoint): Promise<StreamTraffic | null> {
    const response = await relayFetch(endpoint, "/api/streams", { timeoutMs: 3000 }).catch(
        () => null
    );
    if (!response?.ok) return null;
    const body = (await response.json().catch(() => null)) as Record<string, unknown> | null;
    return body && typeof body === "object" ? streamTraffic(body) : null;
}

/**
 * The streams whose byte count did not move between two looks: connected,
 * waited on, and receiving nothing. A stream seen only once tells nothing.
 */
export function stalledStreams(before: StreamTraffic | undefined, now: StreamTraffic): string[] {
    if (!before) return [];
    return Object.keys(now).filter((name) => before[name] === now[name]);
}

/** Whether a relay with these stalled streams is restarted now. */
export function restartDue(
    stalled: readonly string[],
    lastRestartAt: number | undefined,
    now: number,
    fruitless = 0
): boolean {
    if (stalled.length === 0) return false;
    return lastRestartAt === undefined || now - lastRestartAt >= relayRestartCooldownMs(fruitless);
}

/**
 * Restart the relay in place.
 *
 * A stalled camera connection is not closed by replacing or deleting its stream
 * - the relay only forgets the name - and a camera that caps its sessions then
 * refuses the new one. Restarting closes every connection and reopens each
 * camera from the relay's own file, which is the one recovery that frees them.
 */
export async function restartRelay(endpoint: RelayEndpoint): Promise<boolean> {
    const response = await relayFetch(endpoint, "/api/restart", {
        method: "POST",
        timeoutMs: 3000
    }).catch(() => null);
    return response?.ok === true;
}

/**
 * How long a stream is left alone after a frame request to it ran out of time.
 *
 * The relay holds a frame request open until the camera sends a keyframe and
 * does not let go of one whose caller gave up, so asking a stalled stream again
 * at once only adds another request it will hold.
 */
export const FRAME_PAUSE_MS = 20_000;

/** A frame request's answer, read whole: frames are small. */
type FrameAnswer = { ok: boolean; status: number; body: Buffer };

/** The frame request out to each relay address right now, shared by every caller. */
const framesAsked = new Map<string, Promise<FrameAnswer | null>>();
/** Until when each stream is left alone, by relay and stream name. */
const framesPausedUntil = new Map<string, number>();

/**
 * One frame request per stream at a time, and none for a while after one timed
 * out. "paused" when the stream is being left alone; null when the relay did
 * not answer, or the caller left before it did.
 */
async function askFrame(
    endpoint: RelayEndpoint,
    query: URLSearchParams,
    timeoutMs: number,
    signal?: AbortSignal
): Promise<FrameAnswer | null | "paused"> {
    const stream = `${endpoint.baseUrl}|${query.get("src") ?? ""}`;
    if ((framesPausedUntil.get(stream) ?? 0) > Date.now()) return "paused";
    const path = `/api/frame.jpeg?${query.toString()}`;
    const key = `${endpoint.baseUrl}${path}`;
    let asked = framesAsked.get(key);
    if (!asked) {
        // Not tied to any one caller's signal: it is shared, and one viewer
        // leaving must not cancel it for the others.
        asked = relayFetch(endpoint, path, { timeoutMs })
            .then(async (response) => ({
                ok: response.ok,
                status: response.status,
                body: Buffer.from(await response.arrayBuffer())
            }))
            .catch((error: unknown) => {
                if (error instanceof Error && error.name === "AbortError") {
                    framesPausedUntil.set(stream, Date.now() + FRAME_PAUSE_MS);
                }
                return null;
            })
            .finally(() => framesAsked.delete(key));
        framesAsked.set(key, asked);
    }
    if (!signal) return asked;
    if (signal.aborted) return null;
    return Promise.race([
        asked,
        new Promise<null>((resolve) =>
            signal.addEventListener("abort", () => resolve(null), { once: true })
        )
    ]);
}

/**
 * A still from a camera, as JPEG bytes.
 *
 * This is what the wall shows before anybody presses play, and what an event
 * keeps as its picture. It goes through the relay rather than the camera for the
 * usual reason: the camera has one connection to give and the relay already has
 * it.
 */
export async function snapshot(
    endpoint: RelayEndpoint,
    cameraId: string,
    quality: "main" | "sub" = "sub",
    options: { width?: number; cacheMs?: number; signal?: AbortSignal } = {}
): Promise<Buffer | null> {
    const query = new URLSearchParams({ src: streamName(cameraId, quality) });
    // Asking for the size it will be drawn at rather than the camera's own. A
    // tile is a few hundred pixels wide, and sending it a 2K frame is most of a
    // megabyte to fill a postcard - over mobile data, several times a second.
    if (options.width) query.set("w", String(options.width));
    // The relay decodes a frame to answer this, so a wall of tiles asking at the
    // same moment must not be a decode each. With a cache window they all get the
    // one frame, and the cost is per camera per window rather than per viewer.
    //
    // In milliseconds because the window is also the ceiling on how many
    // different pictures anybody can be shown: a second of cache is a second of
    // the same frame, which is a slideshow however often it is asked for. The
    // wall still asks for a second; one camera on its own asks for less.
    if (options.cacheMs) query.set("cache", `${options.cacheMs}ms`);
    // A camera that is asleep takes a moment to produce its first frame.
    const answer = await askFrame(endpoint, query, 8000, options.signal);
    if (!answer || answer === "paused" || !answer.ok) return null;
    return answer.body;
}

/**
 * How long a relay's own words may be before they stop being an explanation.
 *
 * They go on a screen, and a screen has room for a sentence. The useful part of
 * one of these is always at the front - "401 Unauthorized", "unsupported codec"
 * - and what trails it is the address it was trying.
 */
const REASON_MAX = 300;

/**
 * A frame, or why there was not one.
 *
 * `snapshot` answers null for everything: a camera asleep, a password the camera
 * refused, a model the relay cannot open, a relay that is not running. Those
 * have nothing in common as fixes, and the person reading the screen cannot open
 * a terminal to tell them apart - so the one place that knows, the relay, is
 * asked and its answer is carried out.
 *
 * Its answer is not shown raw. The relay's message quotes the source it was
 * given, and that source carries the camera password, so everything on its way
 * out goes through `redactSource` first. What is left is the relay's own reason,
 * which is the half worth reading.
 */
export async function frameOrReason(
    endpoint: RelayEndpoint,
    cameraId: string,
    quality: "main" | "sub" = "sub"
): Promise<{ frame: Buffer } | { reason: string }> {
    const query = new URLSearchParams({ src: streamName(cameraId, quality) });
    const response = await askFrame(endpoint, query, 15_000);
    if (response === "paused") return { reason: "The camera is not sending a picture." };
    if (!response) return { reason: "The relay did not answer." };
    if (response.ok) {
        const frame = response.body;
        if (frame.length > 0) return { frame };
        // A 200 with nothing in it is what a refused camera looks like: go2rtc
        // did its job, there was no picture at the end of it, and neither the
        // status nor the stream record says why. Its log does.
        return { reason: await explained(endpoint) };
    }
    const said = response.body.toString("utf8").trim();
    const reason = said || (await streamError(endpoint, cameraId, quality));
    return {
        reason: reason
            ? redactSource(reason).slice(0, REASON_MAX)
            : `The relay refused it (${response.status}).`
    };
}

/**
 * Why the relay could not open a camera, in the words of somebody who has to go
 * and fix it.
 *
 * Its log is the only place the reason exists, and a relay from before that path
 * was allowed answers 404 for it - so this degrades to naming the two causes
 * that account for nearly all of these rather than to saying nothing.
 */
async function explained(endpoint: RelayEndpoint): Promise<string> {
    const response = await relayFetch(endpoint, "/api/log", { timeoutMs: 5000 }).catch(() => null);
    if (!response?.ok) return UNEXPLAINED;
    const log = (await response.text().catch(() => "")).slice(-RELAY_LOG_TAIL);
    return explainRelayFailure(log) ?? relaySaid(log) ?? UNEXPLAINED;
}

/** What the relay recorded against a stream, when asking for a frame said
 *  nothing useful. Best effort: this is already the second question. */
async function streamError(
    endpoint: RelayEndpoint,
    cameraId: string,
    quality: "main" | "sub"
): Promise<string> {
    const query = new URLSearchParams({ src: streamName(cameraId, quality) });
    const response = await relayFetch(endpoint, `/api/streams?${query.toString()}`, {
        timeoutMs: 5000
    }).catch(() => null);
    if (!response?.ok) return "";
    const body = await response.text().catch(() => "");
    // Read as text rather than parsed: go2rtc puts the failure in different
    // places depending on how far the connection got, and what is wanted here is
    // the sentence rather than a shape.
    const found = body.match(/"error"\s*:\s*"([^"]{1,400})"/);
    return found?.[1] ?? "";
}

/** Where a viewer's player connects, as a path on the relay. The browser never
 *  sees this - it is what the authenticated proxy route dials. */
export function streamPath(
    cameraId: string,
    kind: "mp4" | "webrtc" | "ws",
    quality: "main" | "sub" = "main"
): string {
    const src = encodeURIComponent(streamName(cameraId, quality));
    if (kind === "mp4") return `/api/stream.mp4?src=${src}`;
    if (kind === "webrtc") return `/api/webrtc?src=${src}`;
    return `/api/ws?src=${src}`;
}

/**
 * The files an HLS player asks for, in the order it asks for them.
 *
 * An allowlist rather than a path: these arrive from a URL, and a proxy that
 * pastes whatever it was given onto a relay's address is a proxy that can be
 * pointed at the rest of that relay's API.
 */
export const HLS_FILES = [
    "stream.m3u8",
    "playlist.m3u8",
    "init.mp4",
    "segment.m4s",
    "segment.ts"
] as const;
export type HlsFile = (typeof HLS_FILES)[number];

export function isHlsFile(value: string): value is HlsFile {
    return (HLS_FILES as readonly string[]).includes(value);
}

/**
 * The first playlist a player fetches, which is also what opens the session.
 *
 * `mp4` asks for fragmented-MP4 segments instead of the legacy transport stream.
 * That is the flavour that carries H265 and audio, and Safari - the only reason
 * any of this is HLS rather than a plain MP4 - plays it.
 */
export function hlsMasterPath(cameraId: string, quality: "main" | "sub"): string {
    return `/api/stream.m3u8?src=${encodeURIComponent(streamName(cameraId, quality))}&mp4`;
}

/** Everything the player fetches afterwards. The relay finds the stream from its
 *  own session id, so these carry no camera and no quality. */
export function hlsAssetPath(
    file: Exclude<HlsFile, "stream.m3u8">,
    session: string,
    sequence: string | null
): string {
    const query = new URLSearchParams({ id: session });
    if (sequence) query.set("n", sequence);
    return `/api/hls/${file}?${query.toString()}`;
}

/** Dial a relay path and hand back the raw response, for the proxy route that
 *  streams it on to a viewer. */
export async function relayStream(
    endpoint: RelayEndpoint,
    path: string,
    init?: { method?: string; body?: string; contentType?: string; signal?: AbortSignal }
): Promise<Response> {
    return relayFetch(endpoint, path, {
        method: init?.method ?? "GET",
        // Video is a long read; the timeout is on getting the response started,
        // and the body streams for as long as somebody is watching. That wait is
        // real and it is the camera's: nothing can be sent until a keyframe
        // arrives, and cameras space those seconds apart.
        timeoutMs: 15_000,
        ...(init?.contentType ? { headers: { "content-type": init.contentType } } : {}),
        ...(init?.body === undefined ? {} : { body: init.body }),
        ...(init?.signal ? { signal: init.signal } : {})
    });
}

/** The relay's own deployment on one server, for bringing it up to date. */
export async function relayService(serverId: string): Promise<SideService | null> {
    return findService(RELAY_APP, serverId);
}

/**
 * Whether a relay can carry a voice to a camera.
 *
 * One from before talking was added does not let `/api/stream` through and
 * answers it with the web server's own "404 page not found"; one that does
 * answers a push with no stream named with "stream not found". Anything else
 * is a relay that did not answer at all.
 */
export type TalkReadiness = "ready" | "outdated" | "unreachable";

export async function talkReadiness(endpoint: RelayEndpoint): Promise<TalkReadiness> {
    const response = await relayFetch(endpoint, "/api/stream", { timeoutMs: 3000 }).catch(
        () => null
    );
    if (!response) return "unreachable";
    const body = await response.text().catch(() => "");
    if (/404 page not found/i.test(body)) return "outdated";
    return "ready";
}

/** Where the relay re-serves its own streams to itself. Loopback, so it asks
 *  for no password, and inside the relay, so it needs no port of anybody's. */
const RELAY_LOOPBACK_RTSP = "rtsp://127.0.0.1:8554";

/**
 * The stream a camera's talk is pushed into, made ready to take a push.
 *
 * A push only lands in a stream that exists, and a stream cannot be written
 * without a source. This one is a door nothing answers at: dialling it fails at
 * once and is skipped, which leaves the pushed voice as the stream's only
 * producer.
 */
export async function prepareTalk(endpoint: RelayEndpoint, cameraId: string): Promise<void> {
    const query = new URLSearchParams({
        name: talkStreamName(cameraId),
        src: "tcp://127.0.0.1:1"
    });
    const response = await relayFetch(endpoint, `/api/streams?${query.toString()}`, {
        method: "PUT"
    });
    if (!response.ok) throw new HomeError("The camera relay would not take a voice");
}

/**
 * The voice itself, pushed for as long as `body` stays open.
 *
 * The relay answers only once the push ends, so there is no timeout on the
 * answer; `signal` is what ends it early.
 */
export function pushTalk(
    endpoint: RelayEndpoint,
    cameraId: string,
    body: ReadableStream<Uint8Array>,
    signal: AbortSignal
): Promise<Response> {
    const query = new URLSearchParams({ dst: talkStreamName(cameraId) });
    return relayFetch(endpoint, `/api/stream?${query.toString()}`, {
        method: "POST",
        timeoutMs: null,
        headers: { "content-type": "audio/wav" },
        body,
        signal
    });
}

/** The query that points a camera's speaker at its talk stream, or, with an
 *  empty source, stops it. Exported for its test. */
export function talkPlayQuery(cameraId: string, playing: boolean): string {
    return new URLSearchParams({
        dst: streamName(cameraId, "main"),
        src: playing ? `${RELAY_LOOPBACK_RTSP}/${talkStreamName(cameraId)}?audio=pcma` : ""
    }).toString();
}

/** Play the talk stream on the camera's speaker. False when the relay refused,
 *  which is also what it does when the push has not reached it yet. */
export async function playTalk(endpoint: RelayEndpoint, cameraId: string): Promise<boolean> {
    const response = await relayFetch(endpoint, `/api/streams?${talkPlayQuery(cameraId, true)}`, {
        method: "POST",
        timeoutMs: 8000
    }).catch(() => null);
    return response?.ok === true;
}

/** Stop the speaker and forget the talk stream. Best effort: a relay that has
 *  already let go is the state this asks for. */
export async function endTalk(endpoint: RelayEndpoint, cameraId: string): Promise<void> {
    await relayFetch(endpoint, `/api/streams?${talkPlayQuery(cameraId, false)}`, {
        method: "POST"
    }).catch(() => null);
    await relayFetch(
        endpoint,
        `/api/streams?${new URLSearchParams({ src: talkStreamName(cameraId) }).toString()}`,
        { method: "DELETE" }
    ).catch(() => null);
}

/** The camera's own main path, recovered from the URL the target carries. The
 *  target holds full URLs because that is what everything else needs; the relay
 *  wants the pieces so it can build a source of its own kind. */
function mainPathOf(camera: CameraTarget): string {
    return streamPathOf(camera.mainUrl);
}

function subPathOf(camera: CameraTarget): string {
    return streamPathOf(camera.subUrl);
}
