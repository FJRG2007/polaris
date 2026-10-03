/**
 * The sweep that holds every server's loader without anybody asking, and the
 * one-off update that lets it go.
 *
 * Existing servers have no pin and will never get one by hand: nobody opens a
 * server's variables. So the health job reads each following server's manifest
 * once it has finished installing, writes the version, and costs nothing after.
 * What must not happen: reading a manifest mid-install (holding the version the
 * server is moving away from), undoing an update somebody asked for, or reading
 * the same unreadable server every minute.
 */

import { Readable } from "node:stream";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { beforeEach, describe, expect, it, vi } from "vitest";

const OWNER = "11111111-1111-4111-8111-111111111111";
const INSTALL = "22222222-2222-4222-8222-222222222222";
const APP = "33333333-3333-4333-8333-333333333333";

const NEOFORGE = readFileSync(
    fileURLToPath(new URL("./fixtures/loader-manifests/neoforge.json", import.meta.url)),
    "utf8"
);

let config: Record<string, unknown> = {};
let catalogId = "minecraft";
let env: Record<string, string> = {};
let manifest: string | null = NEOFORGE;
let manifestReads = 0;
let runtime: { status: string; restartCount: number; startedAt: string } | null = null;
let log = "";

vi.mock("@polaris/db", () => ({
    prisma: {
        installedApp: {
            findMany: async () => [
                { id: INSTALL, applicationId: APP, catalogId, config: JSON.stringify(config) }
            ],
            findFirst: async () => ({
                id: INSTALL,
                applicationId: APP,
                config: JSON.stringify(config)
            })
        },
        envVar: {
            findMany: async ({ where }: { where: { key: { in: string[] } } }) =>
                Object.entries(env)
                    .filter(([key]) => where.key.in.includes(key))
                    .map(([key, value]) => ({ scopeId: APP, key, value }))
        }
    }
}));

vi.mock("@/lib/env-var-service", () => ({
    listEnvVars: async () =>
        Object.entries(env).map(([key, value]) => ({ id: key, key, value, isSecret: false })),
    setEnvVars: async (
        _scope: string,
        _id: string,
        _owner: string,
        vars: Array<{ key: string; value: string }>
    ) => {
        for (const item of vars) env[item.key] = item.value;
        return vars.length;
    }
}));

vi.mock("@/lib/apps/install-config", async (importOriginal) => {
    const real = await importOriginal<typeof import("@/lib/apps/install-config")>();
    return {
        ...real,
        patchInstallConfig: async (_id: string, patch: Record<string, unknown>) => {
            config = { ...config, ...patch };
        }
    };
});

vi.mock("@/lib/app-container-metrics", () => ({ readAppContainerRuntime: async () => runtime }));
vi.mock("@/lib/deploy-service", () => ({ readAppRuntimeLog: async () => log }));

vi.mock("@polaris-app/game-servers/src/lib/minecraft/service", () => ({
    editionOf: (catalogId: string) => (catalogId === "minecraft-bedrock" ? "bedrock" : "java"),
    withServerContainer: async (
        _owner: string,
        _install: string,
        work: (server: {
            readFile: (path: string) => Promise<ReadableStream<Uint8Array>>;
        }) => unknown
    ) =>
        work({
            readFile: async () => {
                manifestReads += 1;
                if (manifest === null) throw new Error("no such file");
                return Readable.toWeb(
                    Readable.from([Buffer.from(manifest)])
                ) as ReadableStream<Uint8Array>;
            }
        })
}));

const { sweepLoaderPins, releaseLoaderOnce, readLoaderPin, pinInstalledLoader } = await import(
    "@polaris-app/game-servers/src/lib/minecraft/loader-pin-service"
);

const NOW = new Date("2026-10-03T18:00:00.000Z");

beforeEach(() => {
    config = {};
    catalogId = "minecraft";
    env = { TYPE: "NEOFORGE", VERSION: "1.21.4" };
    manifest = NEOFORGE;
    manifestReads = 0;
    // Up for an hour: long past installing anything.
    runtime = { status: "running", restartCount: 0, startedAt: "2026-10-03T17:00:00.000Z" };
    log = "";
});

describe("the sweep", () => {
    it("holds a following server at what it installed", async () => {
        expect(await sweepLoaderPins(OWNER, NOW)).toEqual({ checked: 1, pinned: 1 });
        expect(env.NEOFORGE_VERSION).toBe("21.4.158");
        // Once held, it costs nothing again.
        manifestReads = 0;
        expect(await sweepLoaderPins(OWNER, NOW)).toEqual({ checked: 0, pinned: 0 });
        expect(manifestReads).toBe(0);
    });

    it("holds a stopped server too: nothing is installing on it", async () => {
        runtime = { status: "exited", restartCount: 0, startedAt: "2026-10-03T17:00:00.000Z" };
        expect((await sweepLoaderPins(OWNER, NOW)).pinned).toBe(1);
    });

    it("waits for a young run to reach the game before believing its manifest", async () => {
        runtime = { status: "running", restartCount: 0, startedAt: "2026-10-03T17:59:00.000Z" };
        log = "[init] Resolving type given NEOFORGE";
        expect((await sweepLoaderPins(OWNER, NOW)).pinned).toBe(0);
        expect(manifestReads).toBe(0);
        log = `${log}\n[17:59:40 INFO]: Done (30.1s)! For help, type "help"`;
        expect((await sweepLoaderPins(OWNER, NOW)).pinned).toBe(1);
    });

    it("leaves a server with no manifest alone for half an hour", async () => {
        manifest = null;
        expect((await sweepLoaderPins(OWNER, NOW)).pinned).toBe(0);
        expect(manifestReads).toBe(1);
        await sweepLoaderPins(OWNER, new Date(NOW.getTime() + 60_000));
        expect(manifestReads).toBe(1);
        manifest = NEOFORGE;
        await sweepLoaderPins(OWNER, new Date(NOW.getTime() + 31 * 60_000));
        expect(env.NEOFORGE_VERSION).toBe("21.4.158");
    });

    it("never reads a server it would not hold anyway", async () => {
        env = { TYPE: "PAPER", VERSION: "1.21.4" };
        expect(await sweepLoaderPins(OWNER, NOW)).toEqual({ checked: 0, pinned: 0 });
        env = { TYPE: "NEOFORGE", VERSION: "LATEST" };
        expect(await sweepLoaderPins(OWNER, NOW)).toEqual({ checked: 0, pinned: 0 });
        expect(manifestReads).toBe(0);
    });

    it("never reads an app that is not a Java Minecraft server", async () => {
        catalogId = "nextcloud";
        expect(await sweepLoaderPins(OWNER, NOW)).toEqual({ checked: 0, pinned: 0 });
        catalogId = "minecraft-bedrock";
        expect(await sweepLoaderPins(OWNER, NOW)).toEqual({ checked: 0, pinned: 0 });
        expect(manifestReads).toBe(0);
        expect(config).toEqual({});
    });
});

describe("updating the loader", () => {
    it("lets the held version go once, and holds the new one once it is installed", async () => {
        env.NEOFORGE_VERSION = "21.4.158";
        expect(await releaseLoaderOnce(OWNER, INSTALL, NOW)).toEqual({ from: "21.4.158" });
        expect(env.NEOFORGE_VERSION).toBe("");
        expect((await readLoaderPin(OWNER, INSTALL, NOW))?.updating).toBe(true);

        // The update's start has not installed yet: the manifest still names the
        // old version, and holding it would undo the update.
        expect((await pinInstalledLoader(OWNER, INSTALL, NOW)).state).toBe("unavailable");
        expect(env.NEOFORGE_VERSION).toBe("");

        // Installed: the update's start ran, the manifest names the new version,
        // and that is what is held.
        manifest = NEOFORGE.replaceAll("21.4.158", "21.4.160");
        const later = new Date(NOW.getTime() + 31 * 60_000);
        runtime = { status: "running", restartCount: 0, startedAt: "2026-10-03T18:01:00.000Z" };
        expect((await sweepLoaderPins(OWNER, later)).pinned).toBe(1);
        expect(env.NEOFORGE_VERSION).toBe("21.4.160");
        expect((await readLoaderPin(OWNER, INSTALL, later))?.updating).toBe(false);
    });

    it("waits for the next start of a stopped server, however long that is", async () => {
        runtime = { status: "exited", restartCount: 0, startedAt: "2026-10-03T17:00:00.000Z" };
        env.NEOFORGE_VERSION = "21.4.158";
        await releaseLoaderOnce(OWNER, INSTALL, NOW);

        const nextDay = new Date(NOW.getTime() + 24 * 60 * 60_000);
        await sweepLoaderPins(OWNER, nextDay);
        expect(env.NEOFORGE_VERSION).toBe("");
        expect((await readLoaderPin(OWNER, INSTALL, nextDay))?.updating).toBe(true);

        // Started, and the repository failed: what is on disk is held again.
        runtime = { status: "exited", restartCount: 3, startedAt: "2026-10-04T19:00:00.000Z" };
        const afterStart = new Date("2026-10-04T19:05:00.000Z");
        expect((await pinInstalledLoader(OWNER, INSTALL, afterStart)).state).toBe("pinned");
        expect(env.NEOFORGE_VERSION).toBe("21.4.158");
    });

    it("says whether a version somebody held is the one on disk", async () => {
        env.NEOFORGE_VERSION = "21.4.158";
        expect(await pinInstalledLoader(OWNER, INSTALL, NOW)).toMatchObject({
            state: "held",
            installed: true
        });
        env.NEOFORGE_VERSION = "21.4.150";
        expect(await pinInstalledLoader(OWNER, INSTALL, NOW)).toMatchObject({
            state: "held",
            installed: false
        });
        manifest = null;
        env.NEOFORGE_VERSION = "21.4.158";
        expect(await pinInstalledLoader(OWNER, INSTALL, NOW)).toMatchObject({
            state: "held",
            installed: false
        });
    });

    it("refuses a server that is not held", async () => {
        expect(await releaseLoaderOnce(OWNER, INSTALL, NOW)).toBeNull();
    });
});
