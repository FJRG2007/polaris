/**
 * Polaris's anti-cheat on the servers made before it came on by default.
 *
 * What is pinned: every server it runs on that nobody decided about gets it
 * written - the plugin, the switch, where to report, the old anti-cheat off its
 * list - using the token the server already has; a server whose owner turned it
 * off, or that runs software it cannot load, is left alone; nothing is written
 * where Polaris has no public address or the image has no jar to serve; and one
 * server failing does not stop the rest.
 */

import { beforeEach, describe, expect, it, vi } from "vitest";

const fake = vi.hoisted(() => ({
    installs: [] as { id: string; ownerId: string; applicationId: string }[],
    env: new Map<string, Map<string, string>>(),
    tokens: new Map<string, string>(),
    written: new Map<string, { key: string; value: string; isSecret: boolean }[]>(),
    publicUrl: "https://polaris.example" as string | null,
    broken: new Set<string>(),
    read: [] as string[],
    bundled: true
}));

vi.mock("@polaris/db", () => ({
    prisma: {
        installedApp: { findMany: async () => fake.installs },
        envVar: {
            findMany: async ({
                where
            }: {
                where: { scopeId: { in: string[] }; key: { in: string[] } };
            }) =>
                where.scopeId.in.flatMap((scopeId) =>
                    [...(fake.env.get(scopeId) ?? new Map<string, string>())]
                        .filter(([key]) => where.key.in.includes(key))
                        .map(([key, value]) => ({ scopeId, key, value }))
                )
        }
    }
}));
vi.mock("@polaris-app/game-servers/src/lib/minecraft/polaris-mod-files", () => ({
    anticheatBundled: async () => fake.bundled
}));
vi.mock("@polaris/app-host", () => ({
    host: {
        domainService: { publicAppUrl: async () => fake.publicUrl },
        envVarService: {
            listEnvVars: async (_scope: string, applicationId: string) => {
                fake.read.push(applicationId);
                if (fake.broken.has(applicationId)) throw new Error("unreadable");
                return [...(fake.env.get(applicationId) ?? new Map())].map(([key, value]) => ({
                    key,
                    value
                }));
            },
            setEnvVars: async (
                _scope: string,
                applicationId: string,
                _owner: string,
                writes: { key: string; value: string; isSecret: boolean }[]
            ) => {
                fake.written.set(applicationId, writes);
            }
        },
        appsInstallSecret: {
            readInstallEnvSecret: async (applicationId: string) =>
                fake.tokens.get(applicationId) ?? null
        },
        rateLimitService: { rateLimit: async () => ({ ok: true }) },
        notificationService: { createNotification: async () => undefined }
    }
}));

const { adoptAnticheatDefaults, adoptPolarisComponent } = await import(
    "@polaris-app/game-servers/src/lib/minecraft/polaris-anticheat-service"
);

const server = (id: string, env: Record<string, string>) => {
    fake.installs.push({
        id: `0000000${id}-0000-4000-8000-000000000000`,
        ownerId: "owner",
        applicationId: `app-${id}`
    });
    fake.env.set(`app-${id}`, new Map(Object.entries(env)));
};

beforeEach(() => {
    fake.installs = [];
    fake.env = new Map();
    fake.tokens = new Map();
    fake.written = new Map();
    fake.publicUrl = "https://polaris.example";
    fake.broken = new Set();
    fake.read = [];
    fake.bundled = true;
});

describe("switching it on for the servers made before", () => {
    it("writes it where it runs and nobody decided, with the server's own token", async () => {
        server("1", { TYPE: "PAPER", MODRINTH_PROJECTS: "grimac?:alpha,coreprotect?" });
        fake.tokens.set("app-1", "login-token");
        expect(await adoptAnticheatDefaults()).toEqual({ adopted: 1 });
        const written = new Map(fake.written.get("app-1")!.map((one) => [one.key, one]));
        expect(written.get("POLARIS_ANTICHEAT")?.value).toBe("on");
        expect(written.get("MODS")?.value).toBe(
            "https://polaris.example/api/minecraft/mod/polaris-anticheat-bukkit.jar"
        );
        expect(written.get("MODRINTH_PROJECTS")?.value).toBe("coreprotect?");
        expect(written.get("POLARIS_SERVER_TOKEN")).toEqual({
            key: "POLARIS_SERVER_TOKEN",
            value: "login-token",
            isSecret: true
        });
    });

    it("leaves an owner's off, a mod loader, and a server already on", async () => {
        server("1", { TYPE: "PAPER", POLARIS_ANTICHEAT: "off" });
        server("2", { TYPE: "NEOFORGE" });
        server("3", { TYPE: "PURPUR", POLARIS_ANTICHEAT: "on" });
        expect(await adoptAnticheatDefaults()).toEqual({ adopted: 0 });
        expect(fake.written.size).toBe(0);
        // Decided from one read of the two keys, not a full read per server.
        expect(fake.read).toEqual([]);
    });

    it("writes it again on a server that moved back to software it runs on", async () => {
        server("1", { TYPE: "PAPER", POLARIS_ANTICHEAT: "" });
        expect(await adoptAnticheatDefaults()).toEqual({ adopted: 1 });
    });

    it("writes nothing while this image has no jar to serve", async () => {
        server("1", { TYPE: "PAPER" });
        fake.bundled = false;
        expect(await adoptAnticheatDefaults()).toEqual({ adopted: 0 });
        expect(fake.written.size).toBe(0);
    });

    it("writes nothing while Polaris has no public address", async () => {
        server("1", { TYPE: "PAPER" });
        fake.publicUrl = null;
        expect(await adoptAnticheatDefaults()).toEqual({ adopted: 0 });
    });

    it("carries on past a server it cannot read", async () => {
        server("1", { TYPE: "PAPER" });
        server("2", { TYPE: "FOLIA" });
        fake.broken.add("app-1");
        const quiet = vi.spyOn(console, "error").mockImplementation(() => undefined);
        expect(await adoptAnticheatDefaults()).toEqual({ adopted: 1 });
        quiet.mockRestore();
        expect(fake.written.has("app-2")).toBe(true);
    });
});

describe("the Polaris mod on every server it has a build for", () => {
    const JAR = "https://polaris.example/api/minecraft/mod/polaris-neoforge-1.21.4.jar";

    it("adds it whatever the switches say, keeping the rest of the list", async () => {
        server("1", {
            TYPE: "NEOFORGE",
            VERSION: "1.21.4",
            MODS: "https://example.org/other.jar",
            POLARIS_ANTICHEAT: "off",
            POLARIS_ANTIXRAY: "off"
        });
        expect(await adoptPolarisComponent()).toEqual({ adopted: 1 });
        expect(fake.written.get("app-1")).toEqual([
            { key: "MODS", value: `https://example.org/other.jar,${JAR}`, isSecret: false }
        ]);
    });

    it("leaves a server that has it, one with no build, and a plugin server", async () => {
        server("1", {
            TYPE: "NEOFORGE",
            VERSION: "1.21.4",
            MODS: JAR.replace("polaris.example", "old.example")
        });
        server("2", { TYPE: "NEOFORGE", VERSION: "1.21.1" });
        server("3", { TYPE: "PAPER", VERSION: "1.21.4" });
        server("4", { TYPE: "VANILLA", VERSION: "1.21.4" });
        expect(await adoptPolarisComponent()).toEqual({ adopted: 0 });
        expect(fake.written.size).toBe(0);
    });

    it("writes nothing without a public address or a jar to serve", async () => {
        server("1", { TYPE: "NEOFORGE", VERSION: "1.21.4" });
        fake.publicUrl = null;
        expect(await adoptPolarisComponent()).toEqual({ adopted: 0 });
        fake.publicUrl = "https://polaris.example";
        fake.bundled = false;
        expect(await adoptPolarisComponent()).toEqual({ adopted: 0 });
        expect(fake.written.size).toBe(0);
    });
});
