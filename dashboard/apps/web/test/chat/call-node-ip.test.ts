/**
 * `syncCallNodeIp`: the file the media server's entrypoint reads, and the
 * restart that makes it read it - once per change, and again after a restart
 * that failed.
 */

import { tmpdir } from "node:os";
import { join } from "node:path";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const RELAY = "51.0.0.30";
const OTHER_RELAY = "51.0.0.31";

const settings = new Map<string, string | null>();
let shipped = true;
let restartFails = false;
const restarts: string[] = [];

vi.mock("@/lib/setting-store", () => ({
    getSetting: async (key: string) => settings.get(key) ?? null,
    setSetting: async (key: string, value: string | null) => void settings.set(key, value)
}));
vi.mock("@/lib/chat/call-server", () => ({ callServer: async () => ({ shipped }) }));
vi.mock("@/lib/docker-service", () => ({
    localDockerDriver: () => ({
        listContainers: async () => [{ id: "livekit-1", composeService: "livekit" }],
        inspect: async () => ({ startedAt: "2026-10-27T10:00:00.000Z" }),
        restart: async (id: string) => {
            if (restartFails) throw new Error("engine away");
            restarts.push(id);
        },
        dispose: async () => undefined
    })
}));
vi.mock("@/lib/notifications/dispatch", () => ({ notify: async () => undefined }));
vi.mock("@/lib/i18n/reader-words", () => ({ readerWords: async () => (key: string) => key }));
vi.mock("@/lib/network-service", () => ({ detectPublicIp: async () => null }));
vi.mock("@polaris/hostd-client", () => ({ HostdClient: class {} }));
vi.mock("@polaris/db", () => ({ prisma: {}, VISIBLE_USER: {} }));

const { syncCallNodeIp } = await import("../../src/lib/chat/call-address-watch");

let dir = "";
const nodeIp = () => readFile(join(dir, "node-ip"), "utf8").catch(() => null);

beforeEach(async () => {
    dir = await mkdtemp(join(tmpdir(), "polaris-call-keys-"));
    process.env.POLARIS_CALL_KEYS_DIR = dir;
    settings.clear();
    restarts.length = 0;
    shipped = true;
    restartFails = false;
    vi.spyOn(console, "error").mockImplementation(() => undefined);
});

afterEach(async () => {
    delete process.env.POLARIS_CALL_KEYS_DIR;
    vi.restoreAllMocks();
    await rm(dir, { recursive: true, force: true });
});

describe("syncCallNodeIp", () => {
    it("writes the relay address and restarts once, then leaves it alone", async () => {
        expect(await syncCallNodeIp(RELAY)).toBe(true);
        expect((await nodeIp())?.trim()).toBe(RELAY);
        expect(restarts).toEqual(["livekit-1"]);

        expect(await syncCallNodeIp(RELAY)).toBe(true);
        expect(restarts).toHaveLength(1);
    });

    it("restarts again when the relay moves, and removes the file when the relay stops serving", async () => {
        await syncCallNodeIp(RELAY);
        await syncCallNodeIp(OTHER_RELAY);
        expect((await nodeIp())?.trim()).toBe(OTHER_RELAY);

        expect(await syncCallNodeIp(null)).toBe(true);
        expect(await nodeIp()).toBeNull();
        expect(restarts).toHaveLength(3);

        expect(await syncCallNodeIp(null)).toBe(true);
        expect(restarts).toHaveLength(3);
    });

    it("tries a failed restart again on the next pass", async () => {
        restartFails = true;
        expect(await syncCallNodeIp(RELAY)).toBe(false);
        expect((await nodeIp())?.trim()).toBe(RELAY);

        restartFails = false;
        expect(await syncCallNodeIp(RELAY)).toBe(true);
        expect(restarts).toEqual(["livekit-1"]);
    });

    it("leaves a call server somebody else runs alone", async () => {
        shipped = false;
        expect(await syncCallNodeIp(RELAY)).toBe(false);
        expect(await nodeIp()).toBeNull();
        expect(restarts).toEqual([]);
    });
});
