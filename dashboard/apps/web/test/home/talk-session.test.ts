/**
 * Talking through a camera, on the server: one person per camera, a talk that
 * ends itself when nobody feeds it, the voice reaching the relay as A-law
 * behind a WAV header, and a relay too old to take it brought forward once.
 * The relay is replaced; its requests are covered by talk-relay.test.ts.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const CAMERA = "11111111-1111-4111-8111-111111111111";

let row: { vendor: string; reachVia: string; enabled: boolean; privacy: boolean } | null;
let endpoint: Record<string, string> | null;
let readiness: "ready" | "outdated" | "unreachable";
let plays: boolean[];
let refreshed: boolean;
let bodies: ReadableStream<Uint8Array>[];
let pushes: { resolve: () => void }[];

vi.mock("@polaris/db", () => ({
    prisma: { camera: { findFirst: vi.fn(async () => row) } }
}));

const prepareTalk = vi.fn(async (..._args: unknown[]) => undefined);
const playTalk = vi.fn(async (..._args: unknown[]) => plays.shift() ?? true);
const endTalk = vi.fn(async (..._args: unknown[]) => undefined);
const refreshHomeService = vi.fn(async (..._args: unknown[]) => refreshed);

vi.mock("@polaris-app/places/src/lib/relay", () => ({
    relayServerFor: (reachVia: string) =>
        reachVia.startsWith("server:") ? reachVia.slice("server:".length) : "local",
    relayEndpoint: async () => endpoint,
    relayService: async () => ({ installedAppId: "i", applicationId: "relay-app", ownerId: "o" }),
    talkReadiness: async () => readiness,
    prepareTalk: (...args: unknown[]) => prepareTalk(...args),
    playTalk: (...args: unknown[]) => playTalk(...args),
    endTalk: (...args: unknown[]) => endTalk(...args),
    pushTalk: (_endpoint: unknown, _camera: string, body: ReadableStream<Uint8Array>) => {
        bodies.push(body);
        return new Promise<Response>((resolve) => {
            pushes.push({ resolve: () => resolve(new Response(null)) });
        });
    }
}));
vi.mock("@polaris-app/places/src/lib/side-upgrade", () => ({
    refreshHomeService: (...args: unknown[]) => refreshHomeService(...args)
}));

const talk = await import("@polaris-app/places/src/lib/talk");
const { HomeError } = await import("@polaris-app/places/src/lib/home-error");

/** Start a talk, letting the play delays pass. */
async function started(userId = "user-1"): Promise<string> {
    const pending = talk.startTalk("install-1", CAMERA, userId);
    const settled = pending.catch((caught: unknown) => caught);
    await vi.advanceTimersByTimeAsync(1500);
    const result = await settled;
    if (result instanceof Error) throw result;
    return result as string;
}

async function readSome(body: ReadableStream<Uint8Array>, count: number): Promise<Uint8Array[]> {
    const reader = body.getReader();
    const parts: Uint8Array[] = [];
    for (let i = 0; i < count; i++) parts.push((await reader.read()).value as Uint8Array);
    reader.releaseLock();
    return parts;
}

beforeEach(() => {
    vi.useFakeTimers();
    row = { vendor: "tapo-cloud", reachVia: "local", enabled: true, privacy: false };
    endpoint = { baseUrl: "http://relay:1984" };
    readiness = "ready";
    plays = [];
    refreshed = true;
    bodies = [];
    pushes = [];
    for (const mock of [prepareTalk, playTalk, endTalk, refreshHomeService]) mock.mockClear();
});

afterEach(async () => {
    // Nothing carried into the next test.
    await vi.advanceTimersByTimeAsync(talk.TALK_IDLE_MS + 10);
    vi.useRealTimers();
});

describe("starting a talk", () => {
    it("readies the talk stream, pushes a live A-law WAV, and points the camera at it", async () => {
        const id = await started();
        expect(id).toMatch(/^[0-9a-f-]{36}$/);
        expect(prepareTalk).toHaveBeenCalledTimes(1);
        expect(playTalk).toHaveBeenCalledTimes(1);
        const [header, primer] = await readSome(bodies[0] as ReadableStream<Uint8Array>, 2);
        expect(new TextDecoder().decode(header!.subarray(0, 4))).toBe("RIFF");
        expect(new DataView(header!.buffer).getUint16(20, true)).toBe(6);
        expect(primer!.every((byte) => byte === 0xd5)).toBe(true);
        expect(talk.talking(CAMERA)).toBe(true);
    });

    it("retries the camera once when the push has not reached the relay yet", async () => {
        plays = [false, true];
        await started();
        expect(playTalk).toHaveBeenCalledTimes(2);
    });

    it("ends the talk and says so when the camera will not play it", async () => {
        plays = [false, false];
        await expect(started()).rejects.toThrow("The camera would not play a voice");
        expect(endTalk).toHaveBeenCalledTimes(1);
        expect(talk.talking(CAMERA)).toBe(false);
    });

    it("refuses a second person while somebody is talking", async () => {
        await started("user-1");
        await expect(started("user-2")).rejects.toThrow(talk.TALKING_ELSEWHERE);
    });

    it("lets the same person start again, replacing their own talk", async () => {
        const first = await started("user-1");
        const second = await started("user-1");
        expect(second).not.toBe(first);
        expect(endTalk).toHaveBeenCalledTimes(1);
    });

    it("tells the same person their own start is still on its way", async () => {
        const first = talk
            .startTalk("install-1", CAMERA, "user-1")
            .catch((caught: unknown) => caught);
        await expect(talk.startTalk("install-1", CAMERA, "user-1")).rejects.toThrow(
            talk.ALREADY_STARTING
        );
        await expect(talk.startTalk("install-1", CAMERA, "user-2")).rejects.toThrow(
            talk.TALKING_ELSEWHERE
        );
        await vi.advanceTimersByTimeAsync(1500);
        expect(await first).toMatch(/^[0-9a-f-]{36}$/);
    });

    it("refuses a camera reached over RTSP, or a make with no way to its speaker", async () => {
        row = { vendor: "tapo", reachVia: "local", enabled: true, privacy: false };
        await expect(started()).rejects.toThrow(talk.CANNOT_TALK);
        row = { vendor: "reolink", reachVia: "local", enabled: true, privacy: false };
        await expect(started()).rejects.toThrow(talk.CANNOT_TALK);
        expect(prepareTalk).not.toHaveBeenCalled();
    });

    it("talks to a battery Tapo too", async () => {
        row = { vendor: "tapo-battery", reachVia: "server:abc", enabled: true, privacy: false };
        await expect(started()).resolves.toBeTruthy();
    });

    it("refuses a private camera, one switched off, and one with no relay yet", async () => {
        row = { vendor: "tapo-cloud", reachVia: "local", enabled: true, privacy: true };
        await expect(started()).rejects.toThrow("This camera is private");
        row = { vendor: "tapo-cloud", reachVia: "local", enabled: false, privacy: false };
        await expect(started()).rejects.toThrow("This camera is switched off");
        row = { vendor: "tapo-cloud", reachVia: "local", enabled: true, privacy: false };
        endpoint = null;
        await expect(started()).rejects.toThrow("The camera relay is still starting");
    });

    it("brings an outdated relay forward and says it is updating", async () => {
        readiness = "outdated";
        await expect(started()).rejects.toThrow(/is updating so it can carry your voice/);
        expect(refreshHomeService).toHaveBeenCalledWith("relay-app", "o");
        expect(prepareTalk).not.toHaveBeenCalled();
    });

    it("names the update in Settings once the relay was already brought forward this build", async () => {
        readiness = "outdated";
        refreshed = false;
        await expect(started()).rejects.toThrow(/Update Polaris in Settings/);
    });

    it("says when the relay does not answer at all", async () => {
        readiness = "unreachable";
        await expect(started()).rejects.toThrow("The camera relay is not answering");
    });
});

describe("feeding and ending a talk", () => {
    it("encodes each piece to A-law and keeps the talk open", async () => {
        const id = await started();
        const pcm = new Uint8Array(400); // 200 samples of silence
        expect(talk.feedTalk(CAMERA, "user-1", id, pcm)).toBe(true);
        const parts = await readSome(bodies[0] as ReadableStream<Uint8Array>, 3);
        expect(parts[2]!.byteLength).toBe(200);
        expect(parts[2]!.every((byte) => byte === 0xd5)).toBe(true);
    });

    it("refuses a piece for somebody else's talk or one that is over", async () => {
        const id = await started();
        expect(() => talk.feedTalk(CAMERA, "user-2", id, new Uint8Array(2))).toThrow(HomeError);
        expect(() =>
            talk.feedTalk(
                CAMERA,
                "user-1",
                "22222222-2222-4222-8222-222222222222",
                new Uint8Array(2)
            )
        ).toThrow(talk.NOT_TALKING);
    });

    it("drops what arrives far faster than anybody speaks", async () => {
        const id = await started();
        const second = new Uint8Array(16000);
        let accepted = 0;
        for (let i = 0; i < 6; i++) if (talk.feedTalk(CAMERA, "user-1", id, second)) accepted += 1;
        // About 1.5 s have passed and 2 s of lead are allowed.
        expect(accepted).toBe(3);
    });

    it("ends a talk nobody has fed for a few seconds", async () => {
        const id = await started();
        // Starting took 1.5 s of the first idle window.
        await vi.advanceTimersByTimeAsync(2000);
        talk.feedTalk(CAMERA, "user-1", id, new Uint8Array(2));
        await vi.advanceTimersByTimeAsync(talk.TALK_IDLE_MS - 500);
        expect(talk.talking(CAMERA)).toBe(true);
        await vi.advanceTimersByTimeAsync(600);
        expect(talk.talking(CAMERA)).toBe(false);
        expect(endTalk).toHaveBeenCalledTimes(1);
    });

    it("ends when the relay ends the push", async () => {
        await started();
        pushes[0]!.resolve();
        await vi.advanceTimersByTimeAsync(0);
        expect(talk.talking(CAMERA)).toBe(false);
    });

    it("ends a live talk when the camera may no longer be talked through", async () => {
        const id = await started();
        await talk.endCameraTalk(CAMERA);
        expect(talk.talking(CAMERA)).toBe(false);
        expect(endTalk).toHaveBeenCalledTimes(1);
        expect(() => talk.feedTalk(CAMERA, "user-1", id, new Uint8Array(2))).toThrow(
            talk.NOT_TALKING
        );
    });

    it("ends a talk that was still starting when the camera was made private", async () => {
        const pending = talk
            .startTalk("install-1", CAMERA, "user-1")
            .catch((caught: unknown) => caught);
        await vi.advanceTimersByTimeAsync(100);
        await talk.endCameraTalk(CAMERA);
        await vi.advanceTimersByTimeAsync(1500);
        const result = await pending;
        expect(result).toBeInstanceOf(HomeError);
        expect((result as Error).message).toBe(talk.NOT_TALKING);
        expect(talk.talking(CAMERA)).toBe(false);
    });

    it("is stopped only by the person talking", async () => {
        const id = await started();
        expect(await talk.stopTalk(CAMERA, "user-2", id)).toBe(false);
        expect(talk.talking(CAMERA)).toBe(true);
        expect(await talk.stopTalk(CAMERA, "user-1", id)).toBe(true);
        expect(talk.talking(CAMERA)).toBe(false);
        expect(endTalk).toHaveBeenCalledTimes(1);
        expect(await talk.stopTalk(CAMERA, "user-1", id)).toBe(false);
    });
});
