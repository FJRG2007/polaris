/**
 * Folders Polaris makes inside a server's own disk.
 *
 * `docker exec` runs as root while the game runs as its own user, so a folder
 * made from here and left alone is one the server cannot write to - and the very
 * first thing it does with a new level is take `session.lock` inside it. A world
 * carried over from a reset was exactly that folder: the server booted, hit
 * `AccessDeniedException`, and the container restarted every seventeen seconds
 * against a map nobody could see was unwritable.
 */

import { beforeEach, describe, expect, it, vi } from "vitest";

/** Every command the container was asked to run, in order. */
let ran: string[][] = [];

/** What `stat -c %u:%g /data` answers, per test. */
let owner = { code: 0, output: "1000:1000\n" };

/** The edition the fake container reports. */
let edition: "java" | "bedrock" = "java";

/** What a listing of the level parent holds. */
let listing = "world\nlogs\nplugins";

/** What the level marker search finds. */
let markers = "/data/world/level.dat";

/** What an unpacked archive holds, for the restore path. */
let unpacked = "world\nworld_nether";

function answer(argv: readonly string[]): { code: number; output: string } {
    const [command, ...rest] = argv;
    if (command === "stat" && rest.includes("/data")) return owner;
    if (command === "ls") return { code: 0, output: rest[rest.length - 1] === "/data/.polaris-restore" ? unpacked : listing };
    if (command === "find" && rest.includes("level.dat")) {
        // A level put in place by a restore is on disk from that moment, so the
        // marker search has to find it too - the switch that follows looks for it.
        const moved = ran.filter((entry) => entry[0] === "mv").map((entry) => `${entry[entry.length - 1]}/level.dat`);
        return { code: 0, output: [markers, ...moved].join("\n") };
    }
    return { code: 0, output: "" };
}

vi.mock("@/lib/apps/minecraft/service", () => ({
    withServerContainer: async (_ownerId: string, installedAppId: string, work: (server: unknown) => Promise<unknown>) =>
        work({
            installedAppId,
            applicationId: "app-1",
            get edition() {
                return edition;
            },
            running: true,
            run: async (argv: readonly string[]) => {
                ran.push([...argv]);
                return answer(argv);
            },
            runOk: async (argv: readonly string[]) => {
                ran.push([...argv]);
                const result = answer(argv);
                if (result.code !== 0) throw new Error(result.output);
                return result.output;
            },
            say: async (argv: readonly string[]) => {
                ran.push(["say", ...argv]);
                return "";
            },
            readFile: async () => new ReadableStream<Uint8Array>()
        })
}));
vi.mock("@polaris/db", () => ({
    prisma: {
        installedApp: {
            findFirst: vi.fn(async () => ({ applicationId: "app-1" })),
            findUnique: vi.fn(async () => ({ config: null })),
            findMany: vi.fn(async () => [])
        }
    }
}));
vi.mock("@/lib/apps/catalog", () => ({ findApp: () => null, appHasCapability: () => false }));
vi.mock("@/lib/env-var-service", () => ({
    listEnvVars: vi.fn(async () => [{ key: "LEVEL", value: "world" }]),
    setEnvVars: vi.fn(async () => undefined)
}));
vi.mock("@/lib/notification-service", () => ({ createNotification: vi.fn(async () => undefined) }));
vi.mock("@/lib/deploy-service", () => ({
    deployApplication: vi.fn(async () => undefined),
    setApplicationRunning: vi.fn(async () => undefined)
}));
vi.mock("@/lib/apps/install-config", () => ({
    patchInstallConfig: vi.fn(async () => undefined),
    readInstallConfig: () => ({})
}));

const { newWorld, restoreWorldBackup } = await import("@/lib/apps/minecraft/world-service");

/** What was done to one path from the moment it was made, as verbs in order. */
function verbsFor(path: string): string[] {
    const verbs = ran.filter((argv) => argv.includes(path)).map((argv) => argv[0] as string);
    const made = verbs.indexOf("mkdir");
    return made === -1 ? verbs : verbs.slice(made);
}

beforeEach(() => {
    ran = [];
    owner = { code: 0, output: "1000:1000\n" };
    edition = "java";
    listing = "world\nlogs\nplugins";
    markers = "/data/world/level.dat";
    unpacked = "world\nworld_nether";
});

describe("a world folder made for the server", () => {
    it("is given to the user the game runs as, and made writable by them", async () => {
        const created = await newWorld("owner-1", "install-1", { keepPlayers: true }, "actor-1");
        const path = `/data/${created.level}`;

        expect(verbsFor(path).slice(0, 3)).toEqual(["mkdir", "chown", "chmod"]);
        expect(ran.find((argv) => argv[0] === "chown")).toEqual(["chown", "1000:1000", "--", path]);
        expect(ran.find((argv) => argv[0] === "chmod")).toEqual(["chmod", "u+rwx", "--", path]);
    });

    it("is handed over before what players are carrying is copied into it", async () => {
        const created = await newWorld("owner-1", "install-1", { keepPlayers: true }, "actor-1");
        const path = `/data/${created.level}`;
        const handedOver = ran.findIndex((argv) => argv[0] === "chmod" && argv.includes(path));
        const firstCopy = ran.findIndex((argv) => argv[0] === "cp");

        expect(firstCopy).toBeGreaterThan(handedOver);
    });

    it("still makes the world when the owner cannot be read, rather than refusing", async () => {
        owner = { code: 1, output: "stat: cannot stat '/data'" };
        const created = await newWorld("owner-1", "install-1", { keepPlayers: true }, "actor-1");

        expect(created.level).toMatch(/^world-\d{8}-\d{6}/);
        expect(ran.some((argv) => argv[0] === "chown")).toBe(false);
        expect(ran.some((argv) => argv[0] === "chmod")).toBe(true);
    });

    it("does not chown anything on an answer that is not an owner", async () => {
        owner = { code: 0, output: "$(rm -rf /)\n" };
        await newWorld("owner-1", "install-1", { keepPlayers: true }, "actor-1");

        expect(ran.some((argv) => argv[0] === "chown")).toBe(false);
    });

    it("is not made at all when nothing is being carried across, because the server makes it itself", async () => {
        await newWorld("owner-1", "install-1", { keepPlayers: false }, "actor-1");

        expect(ran.some((argv) => argv[0] === "mkdir")).toBe(false);
    });

    it("covers the folder Bedrock keeps every level under", async () => {
        edition = "bedrock";
        listing = "Bedrock level";
        markers = "/data/worlds/world-20260101-000000/level.dat";
        unpacked = "Bedrock level";

        await restoreWorldBackup("owner-1", "install-1", "2026-01-01T00-00-00-000.tar.gz", "actor-1");

        expect(verbsFor("/data/worlds").slice(0, 3)).toEqual(["mkdir", "chown", "chmod"]);
    });
});
