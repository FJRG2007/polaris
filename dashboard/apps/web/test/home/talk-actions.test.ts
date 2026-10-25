/**
 * The talk actions on the server: the permission they ask for, the ids they
 * hold a request to, the rate limit on starting, the audit row at each end,
 * and a refusal from the talk passed on in the reader's words. The talk itself
 * is replaced; it is covered by talk-session.test.ts.
 */

import { beforeEach, describe, expect, it, vi } from "vitest";

const CAMERA = "11111111-1111-4111-8111-111111111111";
const TALK = "33333333-3333-4333-8333-333333333333";

const requireHome = vi.fn(async (_permission: string) => ({
    user: { id: "user-1" },
    install: { id: "install-1", ownerId: "owner-1" }
}));

vi.mock("@polaris-app/places/src/lib/access", () => ({
    requireHome: (permission: string) => requireHome(permission),
    requireHomeInstall: vi.fn(),
    requireHomeShared: vi.fn()
}));

const startTalk = vi.fn(async (..._args: unknown[]) => TALK);
const stopTalk = vi.fn(async (..._args: unknown[]) => true);
vi.mock("@polaris-app/places/src/lib/talk", () => ({
    startTalk: (...args: unknown[]) => startTalk(...args),
    stopTalk: (...args: unknown[]) => stopTalk(...args)
}));

vi.mock("@polaris-app/places/src/lib/i18n", async (original) => {
    const real = await original<typeof import("@polaris-app/places/src/lib/i18n")>();
    return { ...real, placesT: async () => real.placesTIn("en-US") };
});
vi.mock("next/cache", () => ({ revalidatePath: vi.fn() }));
vi.mock("next/headers", () => ({ cookies: vi.fn() }));

const counts = new Map<string, number>();
const rateLimit = vi.fn(async (key: string, limit: number, _windowMs: number) => {
    const count = (counts.get(key) ?? 0) + 1;
    counts.set(key, count);
    return { ok: count <= limit };
});
const recordAudit = vi.fn(async (_entry: Record<string, unknown>) => undefined);

vi.mock("@polaris/app-host", async (original) => {
    const real = await original<typeof import("@polaris/app-host")>();
    const host = real.host as unknown as Record<string, unknown>;
    return {
        ...real,
        host: new Proxy(host, {
            get(target, key) {
                if (key === "rateLimitService")
                    return {
                        rateLimit: (key: string, limit: number, windowMs: number) =>
                            rateLimit(key, limit, windowMs)
                    };
                if (key === "auditService")
                    return { recordAudit: (entry: Record<string, unknown>) => recordAudit(entry) };
                return Reflect.get(target, key);
            }
        })
    };
});

const { startTalkAction, stopTalkAction } = await import("@polaris-app/places/src/screens/actions");
const { HomeError } = await import("@polaris-app/places/src/lib/home-error");

beforeEach(() => {
    counts.clear();
    for (const mock of [requireHome, startTalk, stopTalk, rateLimit, recordAudit]) mock.mockClear();
    startTalk.mockImplementation(async () => TALK);
    stopTalk.mockImplementation(async () => true);
});

describe("talk actions", () => {
    it("ask for home.control at both ends", async () => {
        await startTalkAction(CAMERA);
        await stopTalkAction(CAMERA, TALK);
        expect(requireHome.mock.calls.map(([permission]) => permission)).toEqual([
            "home.control",
            "home.control"
        ]);
    });

    it("start a talk as the person asking, and audit it", async () => {
        expect(await startTalkAction(CAMERA)).toEqual({ talkId: TALK });
        expect(startTalk).toHaveBeenCalledWith("install-1", CAMERA, "user-1");
        expect(recordAudit).toHaveBeenCalledWith(
            expect.objectContaining({ action: "places.camera.talk", targetId: CAMERA })
        );
    });

    it("refuse a malformed camera or talk before reaching the camera", async () => {
        expect((await startTalkAction("not-a-camera")).error).toBeTruthy();
        expect((await stopTalkAction(CAMERA, "not-a-talk")).error).toBeTruthy();
        expect(startTalk).not.toHaveBeenCalled();
        expect(stopTalk).not.toHaveBeenCalled();
    });

    it("limit starting to ten a minute per person and camera", async () => {
        for (let press = 0; press < 10; press += 1)
            expect((await startTalkAction(CAMERA)).error).toBeUndefined();
        expect((await startTalkAction(CAMERA)).error).toBe(
            "Too many presses. Wait a minute and try again"
        );
        expect(startTalk).toHaveBeenCalledTimes(10);
    });

    it("pass a refusal on in the reader's words, without an audit row", async () => {
        startTalk.mockImplementation(async () => {
            throw new HomeError("Somebody else is talking through this camera");
        });
        expect(await startTalkAction(CAMERA)).toEqual({
            error: "Somebody else is talking through this camera"
        });
        expect(recordAudit).not.toHaveBeenCalled();
    });

    it("audit a stop only when it ended somebody's talk", async () => {
        stopTalk.mockImplementation(async () => false);
        expect(await stopTalkAction(CAMERA, TALK)).toEqual({});
        expect(recordAudit).not.toHaveBeenCalled();
        stopTalk.mockImplementation(async () => true);
        await stopTalkAction(CAMERA, TALK);
        expect(recordAudit).toHaveBeenCalledWith(
            expect.objectContaining({ action: "places.camera.talkEnd", targetId: CAMERA })
        );
    });
});
