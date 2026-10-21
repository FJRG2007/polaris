/**
 * A world copy whose `tar` exited 1 over files moving under it.
 *
 * On Java with saving held only `level.dat` and player files are replaced while
 * the archive is read, so that copy is published. Anything else that exit
 * reports - a region file moving, or any file on Bedrock's LevelDB - is a copy
 * that may be torn, so it fails and the partial file is taken away.
 */

import { beforeEach, describe, expect, it, vi } from "vitest";

/** Every command the container was asked to run, in order. */
let ran: string[][] = [];

/** The edition the fake container reports. */
let edition: "java" | "bedrock" = "java";

/** How the archive command ends, per test. */
let archived = { code: 0, output: "" };

function answer(argv: readonly string[]): { code: number; output: string } {
    const [command] = argv;
    if (command === "ls") return { code: 0, output: edition === "java" ? "world\nlogs" : "Bedrock level" };
    if (command === "tar") return archived;
    if (command === "stat") return { code: 0, output: "4096\n" };
    return { code: 0, output: "" };
}

vi.mock("@polaris-app/game-servers/src/lib/minecraft/service", () => ({
    containerFailure: (output: string, failure: string) => output.trim() || failure,
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
    listEnvVars: vi.fn(async () => []),
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

const { createWorldBackup } = await import("@polaris-app/game-servers/src/lib/minecraft/world-service");

const published = () => ran.some((argv) => argv[0] === "mv" && !argv[argv.length - 1]!.endsWith(".part"));
const partialRemoved = () => ran.some((argv) => argv[0] === "rm" && argv[argv.length - 1]!.endsWith(".tar.gz.part"));

beforeEach(() => {
    ran = [];
    edition = "java";
    archived = { code: 0, output: "" };
});

describe("a world copy tar finished while files moved", () => {
    it("is published on Java when only the world folder and level.dat were replaced", async () => {
        archived = {
            code: 1,
            output: "tar: world: file changed as we read it\ntar: world/level123.dat: File removed before we read it\n"
        };

        const taken = await createWorldBackup("owner-1", "install-1");

        expect(taken.name).toMatch(/\.tar\.gz$/);
        expect(published()).toBe(true);
        expect(partialRemoved()).toBe(false);
        expect(ran).toContainEqual(["say", "save-on"]);
    });

    it("fails on Java when a region file moved, and takes the partial file away", async () => {
        archived = { code: 1, output: "tar: world/region/r.0.0.mca: file changed as we read it\n" };

        await expect(createWorldBackup("owner-1", "install-1")).rejects.toThrow("r.0.0.mca");
        expect(published()).toBe(false);
        expect(partialRemoved()).toBe(true);
        expect(ran).toContainEqual(["say", "save-on"]);
    });

    it("fails on Bedrock whatever moved, and takes the partial file away", async () => {
        edition = "bedrock";
        archived = { code: 1, output: "tar: worlds/Bedrock level/db/000123.log: file changed as we read it\n" };

        await expect(createWorldBackup("owner-1", "install-1")).rejects.toThrow("000123.log");
        expect(published()).toBe(false);
        expect(partialRemoved()).toBe(true);
        expect(ran).toContainEqual(["say", "save", "resume"]);
    });
});
