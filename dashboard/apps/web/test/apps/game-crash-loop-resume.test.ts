/**
 * The whole sequence of 2026-10-03, against the health sweep.
 *
 * A NeoForge server left on "latest" could not download its loader and
 * crash-looped. The guard stopped it - through the same switch an operator's stop
 * uses, so the service was then recorded as stopped. The server was repaired and
 * brought up healthy outside Polaris, and then:
 *
 * - its page still said "Stopped", because the stop and its crash record stayed;
 * - twenty minutes later the pass that halts services recorded as stopped halted
 *   it, healthy and with a player on.
 *
 * What has to hold now: the loop is caught on the first look, the installed loader
 * is held so Start works offline, the record says the stop was Polaris's, and a
 * server that comes back up is taken back as running within one health pass -
 * while a server its operator stopped stays stopped.
 */

import { Readable } from "node:stream";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { english } from "../setup/game-english";
import { beforeEach, describe, expect, it, vi } from "vitest";

const OWNER = "11111111-1111-4111-8111-111111111111";
const INSTALL = "22222222-2222-4222-8222-222222222222";
const APP = "33333333-3333-4333-8333-333333333333";

const MANIFEST = readFileSync(
    fileURLToPath(new URL("./fixtures/loader-manifests/neoforge.json", import.meta.url)),
    "utf8"
);

/** The failing run, as the image prints it (see `crash-loop-loader.test.ts`). */
const LOADER_LOOP = [
    "2026-10-03T17:19:30.512Z [init] Resolving type given NEOFORGE",
    "2026-10-03T17:19:31.818Z [mc-image-helper] 17:19:31.818 ERROR : 'install-neoforge' command failed. Version is 1.70.2",
    "2026-10-03T17:19:31.818Z me.itzg.helpers.errors.GenericException: Failed to parse response body into class me.itzg.helpers.mvn.MavenMetadata",
    "2026-10-03T17:19:31.819Z \tat me.itzg.helpers.http.ObjectFetchBuilder.lambda$assemble$0(ObjectFetchBuilder.java:57)",
    '2026-10-03T17:19:31.820Z Caused by: com.fasterxml.jackson.databind.exc.UnrecognizedPropertyException: Unrecognized field "modelVersion" (class me.itzg.helpers.mvn.MavenMetadata), not marked as ignorable',
    "2026-10-03T17:19:31.901Z [init] Failed to install NeoForge"
].join("\n");

/** The same server, recreated with the loader held, a minute into a good run. */
const HEALTHY = [
    "2026-10-03T17:38:02.000Z [init] Resolving type given NEOFORGE",
    "2026-10-03T17:38:03.000Z [mc-image-helper] 17:38:03.000 INFO  : NeoForge version 21.4.158 for minecraft version 1.21.4 is already installed",
    '2026-10-03T17:38:41.000Z [17:38:41 INFO]: Done (31.882s)! For help, type "help"'
].join("\n");

interface Install {
    id: string;
    name: string;
    catalogId: string;
    applicationId: string;
    config: string;
    status: string;
}

let install: Install;
let desiredState = "running";
let env: Record<string, string> = {};
let runtime: {
    status: string;
    restartCount: number;
    startedAt: string;
    restarting?: boolean;
} | null;
let log = "";
let inspections = 0;
let stops = 0;
let audits: Array<{ action: string; actorId: string | null }> = [];
let notified: Array<{ type: string; body: string }> = [];

vi.mock("@polaris/db", () => ({
    prisma: {
        installedApp: {
            findMany: async () => [install],
            findFirst: async () => install
        },
        application: {
            findFirst: async () => ({ desiredState }),
            updateMany: async ({
                where,
                data
            }: {
                where: { desiredState: string };
                data: { desiredState: string };
            }) => {
                if (desiredState !== where.desiredState) return { count: 0 };
                desiredState = data.desiredState;
                return { count: 1 };
            }
        }
    }
}));

vi.mock("@/lib/app-container-metrics", () => ({
    readAppContainerRuntime: async () => {
        inspections += 1;
        return runtime;
    }
}));

vi.mock("@/lib/deploy-service", () => ({
    readAppRuntimeLog: async () => log,
    setApplicationRunning: async (_app: string, _owner: string, running: boolean) => {
        if (!running) stops += 1;
        desiredState = running ? "running" : "stopped";
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
            install = {
                ...install,
                config: JSON.stringify({ ...JSON.parse(install.config), ...patch })
            };
        }
    };
});

vi.mock("@/lib/notification-service", () => ({
    createNotification: async (input: { type: string; body: string }) => {
        notified.push(input);
    }
}));

vi.mock("@/lib/audit-service", () => ({
    recordAudit: async (event: { action: string; actorId: string | null }) => {
        audits.push(event);
    }
}));

// The server's files, as the daemon serves them from a stopped container's volume.
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
            readFile: async (path: string) => {
                expect(path).toBe("/data/.neoforge-manifest.json");
                return Readable.toWeb(
                    Readable.from([Buffer.from(MANIFEST)])
                ) as ReadableStream<Uint8Array>;
            }
        })
}));

const { sweepCrashLoops, adoptsRunningService, readCrashLoop } = await import(
    "@polaris-app/game-servers/src/lib/games-health"
);

const at = (iso: string) => new Date(iso);

beforeEach(() => {
    install = {
        id: INSTALL,
        name: "Offgrid",
        catalogId: "minecraft",
        applicationId: APP,
        config: "{}",
        status: "installed"
    };
    desiredState = "running";
    env = { TYPE: "NEOFORGE", VERSION: "1.21.4" };
    runtime = null;
    log = "";
    inspections = 0;
    stops = 0;
    audits = [];
    notified = [];
});

/** The first sweep that sees the loop, which is the one that has to stop it. */
async function caughtLooping(): Promise<void> {
    runtime = { status: "running", restartCount: 9, startedAt: "2026-10-03T17:19:30.000Z" };
    log = LOADER_LOOP;
    await sweepCrashLoops(OWNER, at("2026-10-03T17:19:34.000Z"));
}

describe("a server that cannot download its loader", () => {
    it("is stopped on the first look, not left restarting for another minute", async () => {
        runtime = { status: "running", restartCount: 9, startedAt: "2026-10-03T17:19:30.000Z" };
        log = LOADER_LOOP;
        const swept = await sweepCrashLoops(OWNER, at("2026-10-03T17:19:34.000Z"));
        expect(swept.stopped).toBe(1);
        expect(stops).toBe(1);
        expect(desiredState).toBe("stopped");
    });

    it("is held at the loader it installed, and says so", async () => {
        await caughtLooping();
        expect(env.NEOFORGE_VERSION).toBe("21.4.158");
        const record = readCrashLoop(install.config);
        expect(record?.stoppedByPolaris).toBe(true);
        expect(english(record?.advice ?? null)).toBe(
            "The loader could not be downloaded: NeoForge's repository answered in a format this server cannot read. Polaris pinned the installed version 21.4.158; press Start."
        );
        expect(notified).toHaveLength(1);
        expect(notified[0]?.body).toContain(
            "Polaris pinned the installed version 21.4.158; press Start."
        );
    });

    it("keeps a loader version somebody already set, and promises nothing about it", async () => {
        env.NEOFORGE_VERSION = "21.4.150";
        await caughtLooping();
        expect(env.NEOFORGE_VERSION).toBe("21.4.150");
        expect(english(readCrashLoop(install.config)?.advice ?? null)).toBe(
            "The loader could not be downloaded: NeoForge's repository answered in a format this server cannot read."
        );
    });
});

describe("the same server, brought back up", () => {
    it("is running again within one health pass, with the record gone", async () => {
        await caughtLooping();
        expect(desiredState).toBe("stopped");

        // Recreated outside Polaris: a new container, a clean count, up a minute.
        runtime = { status: "running", restartCount: 0, startedAt: "2026-10-03T17:38:00.000Z" };
        log = HEALTHY;
        const swept = await sweepCrashLoops(OWNER, at("2026-10-03T17:39:00.000Z"));

        expect(swept.resumed).toBe(1);
        // What every screen reads "running" from (`desiredState` in
        // `minecraft/service.ts` and the presence stream).
        expect(desiredState).toBe("running");
        expect(readCrashLoop(install.config)).toBeNull();
        expect(audits.map((event) => [event.action, event.actorId])).toContainEqual([
            "games.crash-loop-resumed",
            null
        ]);
        // And it is not stopped again by the pass after.
        await sweepCrashLoops(OWNER, at("2026-10-03T17:40:00.000Z"));
        expect(stops).toBe(1);
        expect(desiredState).toBe("running");
    });

    it("is not believed while it is still going round", async () => {
        await caughtLooping();
        runtime = { status: "running", restartCount: 12, startedAt: "2026-10-03T17:38:55.000Z" };
        log = LOADER_LOOP;
        const swept = await sweepCrashLoops(OWNER, at("2026-10-03T17:39:00.000Z"));
        expect(swept.resumed).toBe(0);
        expect(desiredState).toBe("stopped");
        expect(readCrashLoop(install.config)).not.toBeNull();
    });

    it("is taken back by the pass that halts stopped services, instead of halted", async () => {
        await caughtLooping();
        runtime = { status: "running", restartCount: 0, startedAt: "2026-10-03T17:38:00.000Z" };
        log = HEALTHY;
        expect(await adoptsRunningService(OWNER, APP, at("2026-10-03T17:39:00.000Z"))).toBe(true);
        expect(desiredState).toBe("running");
        expect(readCrashLoop(install.config)).toBeNull();
    });

    it("is left to that pass while it is still going round", async () => {
        await caughtLooping();
        expect(await adoptsRunningService(OWNER, APP, at("2026-10-03T17:19:40.000Z"))).toBe(false);
        expect(desiredState).toBe("stopped");
        expect(readCrashLoop(install.config)?.stoppedByPolaris).toBe(true);
    });
});

describe("a server its operator stopped", () => {
    it("is not inspected, and stays stopped", async () => {
        desiredState = "stopped";
        runtime = { status: "running", restartCount: 0, startedAt: "2026-10-03T17:38:00.000Z" };
        log = HEALTHY;
        const swept = await sweepCrashLoops(OWNER, at("2026-10-03T17:39:00.000Z"));
        expect(swept.resumed).toBe(0);
        expect(inspections).toBe(0);
        expect(desiredState).toBe("stopped");
        expect(await adoptsRunningService(OWNER, APP)).toBe(false);
    });

    it("stays stopped when the record says the stop was not Polaris's", async () => {
        desiredState = "stopped";
        install.config = JSON.stringify({
            crashLoop: { restarts: 4, cause: null, advice: null, at: "x", stoppedByPolaris: false }
        });
        runtime = { status: "running", restartCount: 0, startedAt: "2026-10-03T17:38:00.000Z" };
        log = HEALTHY;
        await sweepCrashLoops(OWNER, at("2026-10-03T17:39:00.000Z"));
        expect(desiredState).toBe("stopped");
        expect(await adoptsRunningService(OWNER, APP)).toBe(false);
    });

    it("reads a record from before the flag existed as the guard's own", () => {
        expect(
            readCrashLoop(
                JSON.stringify({ crashLoop: { restarts: 4, cause: null, advice: null, at: "x" } })
            )?.stoppedByPolaris
        ).toBe(true);
    });
});
