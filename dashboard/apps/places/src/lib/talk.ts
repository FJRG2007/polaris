/**
 * Talking through a camera's speaker.
 *
 * The voice rides the same HTTPS the screen came over: the browser posts short
 * pieces of its microphone here, and this pushes them on to the camera's relay
 * as one live A-law WAV. Pushed rather than pulled because the relay often has
 * no way back to Polaris - another network, another machine, or one reached
 * only through SSH - while Polaris always has a way to the relay. So it works
 * from anywhere the screen does, with nothing to open or forward.
 *
 * One person at a time per camera: a speaker plays one voice, and two people
 * talking over each other through one would be neither of them heard. A talk
 * nobody has fed for a few seconds is ended, so a closed tab or a dropped
 * connection does not leave the camera's speaker held.
 *
 * Only a Tapo reached over its own protocol has a way in to its speaker; one
 * reached over RTSP has none.
 *
 * Server-only.
 */

import { prisma } from "@polaris/db";
import { randomUUID } from "node:crypto";
import { HomeError } from "./home-error";
import { talkSupport } from "./vendors";
import { refreshHomeService } from "./side-upgrade";
import { encodeAlaw, liveWavHeader, TALK_RATE } from "./talk-audio";
import {
    endTalk,
    playTalk,
    prepareTalk,
    pushTalk,
    relayEndpoint,
    relayServerFor,
    relayService,
    talkReadiness,
    type RelayEndpoint
} from "./relay";

/** A talk nobody has fed for this long is over. */
export const TALK_IDLE_MS = 4000;

/** How long the push is given to reach the relay before the camera is pointed
 *  at it, and how long before the one retry. The relay can only play a stream
 *  that already has its voice attached. */
const PLAY_SETTLE_MS = 300;
const PLAY_RETRY_MS = 700;

/** How far ahead of real time a talk may be fed. A browser sends in bursts
 *  after a stall, which is fine; a script sending as fast as it can is not. */
const AHEAD_SECONDS = 2;

/** A quarter of a second of A-law silence, sent behind the header so the relay
 *  has samples to recognise the push by before anybody has said a word. */
const PRIMER = new Uint8Array(TALK_RATE / 4).fill(0xd5);

export const TALKING_ELSEWHERE = "Somebody else is talking through this camera";
export const ALREADY_STARTING = "Your talk through this camera is already starting";
export const NOT_TALKING = "This talk has ended";
export const CANNOT_TALK = "This camera cannot play a voice from Polaris";

interface Talk {
    readonly id: string;
    readonly cameraId: string;
    readonly userId: string;
    readonly endpoint: RelayEndpoint;
    readonly write: ReadableStreamDefaultController<Uint8Array>;
    readonly abort: AbortController;
    readonly startedAt: number;
    sent: number;
    idle: ReturnType<typeof setTimeout> | undefined;
    ended: boolean;
}

interface Starting {
    readonly userId: string;
    cancelled: boolean;
}

interface Registry {
    talks: Map<string, Talk>;
    starts: Map<string, Starting>;
}

const REGISTRY = Symbol.for("polaris.places.talk");

/** Held on the process rather than the module: the action that starts a talk
 *  and the route that feeds it are bundled apart, and each would otherwise
 *  hold its own empty map. */
function registry(): Registry {
    const holder = globalThis as unknown as Record<symbol, Registry | undefined>;
    holder[REGISTRY] ??= { talks: new Map(), starts: new Map() };
    return holder[REGISTRY];
}

function wait(ms: number): Promise<void> {
    return new Promise((resolve) => setTimeout(resolve, ms));
}

async function talkTarget(
    installedAppId: string,
    cameraId: string
): Promise<{ endpoint: RelayEndpoint; serverId: string }> {
    const camera = await prisma.camera.findFirst({
        where: { id: cameraId, installedAppId },
        select: { vendor: true, reachVia: true, enabled: true, privacy: true }
    });
    if (!camera) throw new HomeError("Camera not found");
    if (talkSupport(camera.vendor) !== "yes") throw new HomeError(CANNOT_TALK);
    if (!camera.enabled) throw new HomeError("This camera is switched off");
    if (camera.privacy) throw new HomeError("This camera is private");
    const serverId = relayServerFor(camera.reachVia);
    const endpoint = await relayEndpoint(serverId);
    if (!endpoint) throw new HomeError("The camera relay is still starting");
    return { endpoint, serverId };
}

/** A relay that cannot take a voice yet is brought up to date, once, and the
 *  sentence says what is happening. */
async function assertReady(endpoint: RelayEndpoint, serverId: string): Promise<void> {
    const readiness = await talkReadiness(endpoint);
    if (readiness === "ready") return;
    if (readiness === "unreachable") throw new HomeError("The camera relay is not answering");
    const service = await relayService(serverId);
    const started = service
        ? await refreshHomeService(service.applicationId, service.ownerId)
        : false;
    throw new HomeError(
        started
            ? "The camera relay is updating so it can carry your voice. Try again in a minute"
            : "The camera relay is out of date. Update Polaris in Settings to talk through cameras"
    );
}

async function finish(talk: Talk): Promise<void> {
    if (talk.ended) return;
    talk.ended = true;
    clearTimeout(talk.idle);
    const { talks } = registry();
    if (talks.get(talk.cameraId) === talk) talks.delete(talk.cameraId);
    try {
        talk.write.close();
    } catch {
        // Already closed by the relay ending the push.
    }
    talk.abort.abort();
    await endTalk(talk.endpoint, talk.cameraId);
}

function keepAlive(talk: Talk): void {
    clearTimeout(talk.idle);
    talk.idle = setTimeout(() => void finish(talk), TALK_IDLE_MS);
}

/**
 * Open the camera's speaker to this person. Answers the talk's id, which every
 * piece of voice and the stop must carry.
 *
 * The same person starting again replaces their own talk - a second tab, or a
 * screen that lost track of the first - rather than being refused by it.
 */
export async function startTalk(
    installedAppId: string,
    cameraId: string,
    userId: string
): Promise<string> {
    const { talks, starts } = registry();
    const current = talks.get(cameraId);
    if (current && current.userId !== userId) throw new HomeError(TALKING_ELSEWHERE);
    const pending = starts.get(cameraId);
    if (pending)
        throw new HomeError(pending.userId === userId ? ALREADY_STARTING : TALKING_ELSEWHERE);
    const starting: Starting = { userId, cancelled: false };
    starts.set(cameraId, starting);
    try {
        if (current) await finish(current);
        const { endpoint, serverId } = await talkTarget(installedAppId, cameraId);
        await assertReady(endpoint, serverId);
        await prepareTalk(endpoint, cameraId);
        if (starting.cancelled) throw new HomeError(NOT_TALKING);

        let write!: ReadableStreamDefaultController<Uint8Array>;
        const body = new ReadableStream<Uint8Array>({
            start(controller) {
                write = controller;
            }
        });
        write.enqueue(liveWavHeader());
        write.enqueue(PRIMER);
        const talk: Talk = {
            id: randomUUID(),
            cameraId,
            userId,
            endpoint,
            write,
            abort: new AbortController(),
            startedAt: Date.now(),
            sent: 0,
            idle: undefined,
            ended: false
        };
        talks.set(cameraId, talk);
        keepAlive(talk);
        // The relay answers when the push ends, whichever side ended it.
        pushTalk(endpoint, cameraId, body, talk.abort.signal).then(
            () => void finish(talk),
            () => void finish(talk)
        );

        await wait(PLAY_SETTLE_MS);
        let playing = !talk.ended && (await playTalk(endpoint, cameraId));
        if (!playing && !talk.ended) {
            await wait(PLAY_RETRY_MS);
            playing = !talk.ended && (await playTalk(endpoint, cameraId));
        }
        if (!playing || starting.cancelled) {
            await finish(talk);
            throw new HomeError(
                starting.cancelled ? NOT_TALKING : "The camera would not play a voice"
            );
        }
        return talk.id;
    } finally {
        if (starts.get(cameraId) === starting) starts.delete(cameraId);
    }
}

/**
 * One piece of the voice: 16-bit little-endian PCM at 8 kHz, as the browser
 * recorded it, at most `MAX_CHUNK_BYTES` (the route holds it to that). Refused
 * when it is not this person's talk, or no longer one.
 * Answers false, and drops the piece, when the talk is being fed faster than
 * anybody speaks.
 */
export function feedTalk(
    cameraId: string,
    userId: string,
    talkId: string,
    pcm: Uint8Array
): boolean {
    const talk = registry().talks.get(cameraId);
    if (!talk || talk.ended || talk.id !== talkId || talk.userId !== userId)
        throw new HomeError(NOT_TALKING);
    const alaw = encodeAlaw(pcm);
    const allowed = ((Date.now() - talk.startedAt) / 1000 + AHEAD_SECONDS) * TALK_RATE;
    if (talk.sent + alaw.byteLength > allowed) return false;
    talk.sent += alaw.byteLength;
    keepAlive(talk);
    if (alaw.byteLength > 0) talk.write.enqueue(alaw);
    return true;
}

/** Close the speaker. Only the person talking can; anybody else's stop, or a
 *  stop for a talk already over, does nothing and answers false. */
export async function stopTalk(cameraId: string, userId: string, talkId: string): Promise<boolean> {
    const talk = registry().talks.get(cameraId);
    if (!talk || talk.id !== talkId || talk.userId !== userId) return false;
    await finish(talk);
    return true;
}

/** End whatever is being said through a camera, and any talk still starting on
 *  it, whoever it belongs to: for a camera just made private, switched off,
 *  changed or removed, which a talk may no longer reach. */
export async function endCameraTalk(cameraId: string): Promise<void> {
    const { talks, starts } = registry();
    const starting = starts.get(cameraId);
    if (starting) starting.cancelled = true;
    const talk = talks.get(cameraId);
    if (talk) await finish(talk);
}

/** Whether somebody is talking through a camera now. For the test. */
export function talking(cameraId: string): boolean {
    return registry().talks.has(cameraId);
}
