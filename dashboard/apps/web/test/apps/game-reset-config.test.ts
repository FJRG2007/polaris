/**
 * A reset that moves a server to another Minecraft release, and the settings the
 * last one wrote.
 *
 * The bug this file pins happened exactly once and cost a server: a reset onto a
 * map that pins 1.19.4 left `config/` written by a modern Paper on the volume, the
 * older jar threw while reading its own configuration, and the container restarted
 * forever. The regression test is the last one here - the release was not known,
 * and "not known" has to mean "move it".
 */

import { beforeEach, describe, expect, it, vi } from "vitest";
import { CONFIG_ASIDE_DIR, DATA_DIR, VERSIONED_CONFIG, folderStamp } from "@/lib/apps/minecraft/world";

/** Every command the fake container was asked to run, in order. */
let ran: string[][] = [];
/** What `ls` reports in the data directory. */
let present: string[] = [];
/** Which edition the fake server is. */
let edition: "java" | "bedrock" = "java";

vi.mock("@/lib/apps/minecraft/service", () => ({
    withServerContainer: async (_ownerId: string, _installedAppId: string, run: (server: unknown) => unknown) =>
        run({
            installedAppId: "install",
            applicationId: "app",
            edition,
            running: true,
            run: async (argv: readonly string[]) => {
                ran.push([...argv]);
                if (argv[0] === "ls") return { code: 0, output: present.join("\n") };
                if (argv[0] === "stat") return { code: 0, output: "1000:1000" };
                return { code: 0, output: "" };
            },
            runOk: async (argv: readonly string[]) => {
                ran.push([...argv]);
                return "";
            },
            say: async () => "",
            readFile: async () => new ReadableStream()
        }),
    editionOf: () => edition
}));

// Everything the module reaches for that is not the container. A reset happens on
// a server that may be stopped, and starting it is somebody else's code.
vi.mock("@/lib/deploy-service", () => ({
    setApplicationRunning: async () => undefined,
    deployApplication: async () => undefined,
    readAppRuntimeLog: async () => ""
}));
vi.mock("@polaris/db", () => ({
    prisma: {
        installedApp: { findFirst: async () => ({ applicationId: "app" }), findUnique: async () => null },
        application: { findFirst: async () => ({ desiredState: "running" }) }
    }
}));
vi.mock("@/lib/env-var-service", () => ({ setEnvVars: async () => undefined, listEnvVars: async () => [] }));
vi.mock("@/lib/notification-service", () => ({ createNotification: async () => undefined }));

const { setAsideVersionedConfig } = await import("@/lib/apps/minecraft/world-service");

beforeEach(() => {
    ran = [];
    edition = "java";
    present = ["config", "world", "server.properties", "plugins", "logs", "bukkit.yml"];
});

describe("what counts as a release's own config", () => {
    it("names the directory that actually breaks a downgrade", () => {
        // Paper's own settings, where the sentinel a newer build writes is read as
        // a number by an older one.
        expect(VERSIONED_CONFIG).toContain("config");
    });

    it("leaves server.properties alone, because the image rewrites it every boot", () => {
        expect(VERSIONED_CONFIG).not.toContain("server.properties");
    });

    it("leaves the plugins alone, because a bad one fails its own load", () => {
        // A plugin built for a newer API refuses to load and the server carries on.
        // That is a plugin that does not work, not a server that does not start,
        // and moving them would uninstall somebody's server by surprise.
        expect(VERSIONED_CONFIG).not.toContain("plugins");
        expect(VERSIONED_CONFIG).not.toContain("mods");
    });

    it("never names the world", () => {
        expect(VERSIONED_CONFIG).not.toContain("world");
    });
});

describe("setting the old release's config aside", () => {
    it("moves what is there, in one command, into a stamped folder", async () => {
        const aside = await setAsideVersionedConfig("owner", "install", { from: "26.2", to: "1.19.4" });
        expect(aside).toMatch(new RegExp(`^${CONFIG_ASIDE_DIR}/\\d{8}-\\d{6}$`));

        const move = ran.find((argv) => argv[0] === "mv");
        expect(move).toBeDefined();
        expect(move).toContain(`${DATA_DIR}/config`);
        expect(move).toContain(`${DATA_DIR}/bukkit.yml`);
        // Only what the listing reported, and nothing the set does not name.
        expect(move).not.toContain(`${DATA_DIR}/spigot.yml`);
        expect(move).not.toContain(`${DATA_DIR}/world`);
        expect(move?.at(-1)).toBe(aside);
        // On a crash-looping container every exec races the next restart, so the
        // whole set moves at once rather than one file at a time.
        expect(ran.filter((argv) => argv[0] === "mv")).toHaveLength(1);
    });

    it("does nothing when the release provably did not change", async () => {
        expect(await setAsideVersionedConfig("owner", "install", { from: "1.21.4", to: "1.21.4" })).toBeNull();
        expect(ran).toHaveLength(0);
    });

    it("moves when nobody knows what the release was, which is the usual case", async () => {
        // This is the bug as it happened. VERSION was LATEST, so the old release
        // could not be named, and treating unknown as unchanged is what left the
        // config in place. Setting it aside needlessly costs a regenerated file
        // that is still on disk; leaving it costs a server that never starts.
        expect(await setAsideVersionedConfig("owner", "install", { from: null, to: "1.19.4" })).not.toBeNull();
        expect(ran.some((argv) => argv[0] === "mv")).toBe(true);
    });

    it("does nothing on Bedrock, which has no config to spoil", async () => {
        edition = "bedrock";
        expect(await setAsideVersionedConfig("owner", "install", { from: null, to: "1.21.4" })).toBeNull();
        expect(ran.some((argv) => argv[0] === "mv")).toBe(false);
    });

    it("does nothing when the volume holds none of it", async () => {
        present = ["world", "logs", "server.properties"];
        expect(await setAsideVersionedConfig("owner", "install", { from: null, to: "1.19.4" })).toBeNull();
        expect(ran.some((argv) => argv[0] === "mkdir")).toBe(false);
    });
});

describe("the folder these land in", () => {
    it("sorts chronologically as text, since that is how a listing sorts", () => {
        const earlier = folderStamp(new Date("2026-08-12T21:04:56.000Z"));
        const later = folderStamp(new Date("2026-08-12T21:05:12.000Z"));
        expect(earlier < later).toBe(true);
        expect(earlier).toBe("20260812-210456");
    });
});
