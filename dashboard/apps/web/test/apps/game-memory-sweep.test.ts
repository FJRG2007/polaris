/**
 * The sweep that keeps a server's heap in step with what it has become.
 *
 * Four things matter here and each is a way this could go wrong in somebody's
 * deployment rather than in a test: a server nobody asked to be planned must
 * never be touched, a planned one that has outgrown its heap must be given more,
 * a server that has actually run out must be repaired rather than merely noted,
 * and nothing may restart a server people are playing on.
 */

import { beforeEach, describe, expect, it, vi } from "vitest";

const OWNER = "11111111-1111-4111-8111-111111111111";
const INSTALL = "22222222-2222-4222-8222-222222222222";
const APP = "33333333-3333-4333-8333-333333333333";

interface Install {
    id: string;
    name: string;
    catalogId: string;
    applicationId: string | null;
    config: string | null;
    targetId: string | null;
}

let installs: Install[] = [];
let env: Record<string, string> = {};
let saved: Array<{ key: string; value: string }> = [];
let patched: Array<Record<string, unknown>> = [];
let log = "";
let logReads = 0;
let playersNow = 0;
let busiest = 0;
let deployed: string[] = [];
let deployFails = false;
let writeFails = false;
let redeployed = false;
let notified: Array<{ type: string; title: string; body: string }> = [];
let machines: Array<{ id: string; memoryTotalBytes: number | null; committedMb: number }> = [];

vi.mock("@polaris/db", () => ({
    prisma: {
        installedApp: {
            findMany: async () => installs,
            findFirst: async ({ where }: { where: { id: string } }) =>
                installs.find((install) => install.id === where.id) ?? null
        },
        application: { findFirst: async () => ({ desiredState: "running" }) },
        deployTarget: { findFirst: async () => null },
        deployment: { findFirst: async () => (redeployed ? { id: "deployment" } : null) },
        gameSample: {
            aggregate: async () => ({ _max: { playersOnline: busiest } }),
            findFirst: async () => ({ playersOnline: playersNow })
        }
    }
}));

vi.mock("@/lib/env-var-service", () => ({
    listEnvVars: async () => Object.entries(env).map(([key, value]) => ({ key, value })),
    setEnvVars: async (
        _scope: string,
        _scopeId: string,
        _ownerId: string,
        vars: Array<{ key: string; value: string }>
    ) => {
        if (writeFails) throw new Error("database unavailable");
        saved.push(...vars);
        for (const item of vars) env[item.key] = item.value;
        return vars.length;
    }
}));

vi.mock("@/lib/deploy-service", () => ({
    readAppRuntimeLog: async () => {
        logReads += 1;
        return log;
    },
    deployApplication: async (applicationId: string) => {
        if (deployFails) throw new Error("daemon refused");
        deployed.push(applicationId);
    }
}));

vi.mock("@/lib/notification-service", () => ({
    createNotification: async (input: { type: string; title: string; body: string }) => {
        notified.push(input);
    }
}));

vi.mock("@/lib/apps/install-config", async (importOriginal) => {
    const real = await importOriginal<typeof import("@/lib/apps/install-config")>();
    return {
        ...real,
        patchInstallConfig: async (_id: string, patch: Record<string, unknown>) => {
            patched.push(patch);
        }
    };
});

vi.mock("@/lib/apps/games-service", async (importOriginal) => {
    const real = await importOriginal<typeof import("@/lib/apps/games-service")>();
    return { ...real, listGameMachines: async () => machines };
});

const { resetHeapMb, sweepMemoryPlans } = await import("@/lib/apps/games-memory");

function server(config: Record<string, unknown>): Install {
    return {
        id: INSTALL,
        name: "Offgrid",
        catalogId: "minecraft",
        applicationId: APP,
        config: JSON.stringify(config),
        targetId: null
    };
}

beforeEach(() => {
    installs = [server({ memoryMode: "auto" })];
    // The server as it actually was: sized for a few friends, later given a mod
    // loader and six mods.
    env = {
        MEMORY: "1536M",
        TYPE: "NEOFORGE",
        VERSION: "1.21.4",
        MAX_PLAYERS: "20",
        MODRINTH_PROJECTS:
            "corpse:beta,dynamic-torches,security-craft?,comforts,trashslot,rechiseled"
    };
    saved = [];
    patched = [];
    log = "";
    logReads = 0;
    playersNow = 0;
    busiest = 5;
    deployed = [];
    deployFails = false;
    writeFails = false;
    redeployed = false;
    notified = [];
    machines = [{ id: "local", memoryTotalBytes: 32 * 1024 * 1024 * 1024, committedMb: 1536 }];
});

describe("the memory sweep", () => {
    it("gives a modded server more than the figure it was created with", async () => {
        const swept = await sweepMemoryPlans(OWNER);

        expect(swept.raised).toBe(1);
        expect(saved).toEqual([{ key: "MEMORY", value: "3G", isSecret: false }]);
        expect(notified[0]?.type).toBe("games.memory-raised");
        // Nothing has run out, so nothing is restarted for it.
        expect(deployed).toEqual([]);
        expect(swept.restarted).toBe(0);
    });

    it("leaves a server alone whose heap was typed by hand", async () => {
        installs = [server({})];

        const swept = await sweepMemoryPlans(OWNER);

        expect(swept.checked).toBe(0);
        expect(saved).toEqual([]);
        expect(notified).toEqual([]);
    });

    it("restarts a server that has run out, when nobody is playing", async () => {
        log = "[Worker-Main-25/ERROR] java.lang.OutOfMemoryError: Java heap space";

        const swept = await sweepMemoryPlans(OWNER);

        expect(swept.restarted).toBe(1);
        expect(deployed).toEqual([APP]);
        expect(notified[0]?.body).toContain("ran out of memory");
    });

    it("does not end anybody's evening to apply the new figure", async () => {
        log = "java.lang.OutOfMemoryError: Java heap space";
        playersNow = 3;

        const swept = await sweepMemoryPlans(OWNER);

        expect(swept.raised).toBe(1);
        expect(deployed).toEqual([]);
        expect(notified[0]?.body).toContain("next restart");
    });

    it("does not claim a restart that did not go through", async () => {
        log = "java.lang.OutOfMemoryError: Java heap space";
        deployFails = true;

        const swept = await sweepMemoryPlans(OWNER);

        expect(swept.restarted).toBe(0);
        expect(notified[0]?.body).not.toContain("It was restarted");
        expect(notified[0]?.body).toContain("did not go through");
    });

    it("acts on one out-of-memory once, until the server is deployed again", async () => {
        log = "java.lang.OutOfMemoryError: Java heap space";
        playersNow = 3;
        await sweepMemoryPlans(OWNER, new Date("2026-09-18T01:00:00Z"));
        const acted = patched.find((patch) => "memoryExhaustedAt" in patch);
        expect(acted?.memoryExhaustedAt).toBe("2026-09-18T01:00:00.000Z");
        expect(env.MEMORY).toBe("3G");

        // A quarter of an hour later the same run is still in the log, and nobody
        // has restarted it onto the new figure: that is not new evidence.
        installs = [
            server({
                memoryMode: "auto",
                memoryWatch: "2026-09-18T01:00:00.000Z",
                memoryExhaustedAt: "2026-09-18T01:00:00.000Z"
            })
        ];
        saved = [];
        notified = [];
        const again = await sweepMemoryPlans(OWNER, new Date("2026-09-18T01:15:00Z"));
        expect(again.raised).toBe(0);
        expect(saved).toEqual([]);
        expect(notified).toEqual([]);

        // Deployed onto it and out of memory again: that one counts.
        redeployed = true;
        const after = await sweepMemoryPlans(OWNER, new Date("2026-09-18T01:30:00Z"));
        expect(after.raised).toBe(1);
        expect(env.MEMORY).toBe("4G");
    });

    it("raises a server whose plan is one step above what it has", async () => {
        env.MEMORY = "2560M";

        const swept = await sweepMemoryPlans(OWNER);

        expect(swept.raised).toBe(1);
        expect(saved).toEqual([{ key: "MEMORY", value: "3G", isSecret: false }]);
    });

    it("does not read the log of a server with no heap", async () => {
        installs = [{ ...server({ memoryMode: "auto" }), catalogId: "minecraft-bedrock" }];
        env = { LEVEL_NAME: "world" };

        const swept = await sweepMemoryPlans(OWNER);

        expect(swept.checked).toBe(0);
        expect(logReads).toBe(0);
        expect(patched).toEqual([]);
    });

    it("never goes past the ceiling the operator set", async () => {
        installs = [server({ memoryMode: "auto", memoryCeilingMb: 2048 })];
        log = "java.lang.OutOfMemoryError: Java heap space";

        await sweepMemoryPlans(OWNER);

        expect(saved).toEqual([{ key: "MEMORY", value: "2G", isSecret: false }]);
    });

    it("never promises a machine memory it has not got", async () => {
        // Twenty people at a time on a mod loader wants three and a half
        // gigabytes. The machine has 4.5 GB in total and keeps two for itself, so
        // what it can actually back is 2.5 - and that, not the plan, is what gets
        // written.
        busiest = 20;
        machines = [{ id: "local", memoryTotalBytes: 4608 * 1024 * 1024, committedMb: 1536 }];

        await sweepMemoryPlans(OWNER);

        expect(saved).toEqual([{ key: "MEMORY", value: "2560M", isSecret: false }]);
    });

    it("reads the log four times an hour rather than every minute", async () => {
        await sweepMemoryPlans(OWNER, new Date("2026-09-18T01:00:00Z"));
        const watch = patched.find((patch) => "memoryWatch" in patch);
        expect(watch?.memoryWatch).toBe("2026-09-18T01:00:00.000Z");

        // A minute later, with the watch recorded, the log is not read again.
        installs = [server({ memoryMode: "auto", memoryWatch: "2026-09-18T01:00:00.000Z" })];
        log = "java.lang.OutOfMemoryError: Java heap space";
        patched = [];
        const swept = await sweepMemoryPlans(OWNER, new Date("2026-09-18T01:01:00Z"));

        expect(patched.some((patch) => "memoryWatch" in patch)).toBe(false);
        // The heap it wants is applied all the same - that costs no log read.
        expect(swept.restarted).toBe(0);
    });

    it("says so when a server runs out with nothing left to give it", async () => {
        installs = [server({ memoryMode: "auto", memoryCeilingMb: 2048 })];
        env.MEMORY = "2G";
        log = "java.lang.OutOfMemoryError: Java heap space";

        const swept = await sweepMemoryPlans(OWNER);

        expect(swept.raised).toBe(0);
        expect(saved).toEqual([]);
        expect(notified).toHaveLength(1);
        expect(notified[0]?.type).toBe("games.memory-exhausted");
        expect(notified[0]?.body).toContain("memory limit");
    });

    it("looks at an out-of-memory again when the raise could not be written", async () => {
        log = "java.lang.OutOfMemoryError: Java heap space";
        writeFails = true;

        await sweepMemoryPlans(OWNER, new Date("2026-09-18T01:00:00Z"));

        expect(patched.some((patch) => "memoryExhaustedAt" in patch)).toBe(false);
        expect(notified).toEqual([]);

        writeFails = false;
        installs = [server({ memoryMode: "auto", memoryWatch: "2026-09-18T01:00:00.000Z" })];
        const again = await sweepMemoryPlans(OWNER, new Date("2026-09-18T01:15:00Z"));
        expect(again.raised).toBe(1);
        expect(again.restarted).toBe(1);
    });
});

describe("the heap a reset settles on", () => {
    it("never passes the ceiling the operator set", async () => {
        installs = [server({ memoryMode: "auto", memoryCeilingMb: 2048 })];

        expect(await resetHeapMb(OWNER, INSTALL, 4096)).toBe(1536 + 512);
    });

    it("never lowers a planned server that grew", async () => {
        env.MEMORY = "4G";

        expect(await resetHeapMb(OWNER, INSTALL, 2048)).toBe(4096);
    });

    it("lets a reset settle a fixed server wherever the shape says, within bounds", async () => {
        installs = [server({})];
        env.MEMORY = "4G";

        expect(await resetHeapMb(OWNER, INSTALL, 2048)).toBe(2048);
    });

    it("never promises a machine memory it has not got", async () => {
        installs = [server({})];
        machines = [{ id: "local", memoryTotalBytes: 4608 * 1024 * 1024, committedMb: 1536 }];

        expect(await resetHeapMb(OWNER, INSTALL, 4096)).toBe(2560);
    });
});
