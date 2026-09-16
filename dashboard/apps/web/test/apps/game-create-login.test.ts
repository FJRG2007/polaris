/**
 * The login a new Minecraft server is created with.
 *
 * Polaris login is the login wherever it has a build. The mod names its server by
 * the install's id, so the install is created with an id chosen up front and the
 * mod's settings written before the first boot - and the Modrinth guard it
 * replaces must not be seeded beside it.
 */

import { beforeEach, describe, expect, it, vi } from "vitest";
import { createGameServerSchema } from "@/lib/apps/games-schema";

const installApp = vi.fn(async (..._args: unknown[]) => ({
    installedAppId: "created",
    applicationId: "app"
}));

vi.mock("@/lib/apps/install-service", () => ({ installApp }));
vi.mock("@/lib/domain-service", () => ({ appBaseUrl: async () => "https://polaris.example" }));
vi.mock("@/lib/apps/install-config", () => ({ patchInstallConfig: vi.fn(async () => undefined) }));
vi.mock("@/lib/apps/minecraft/player-access", () => ({
    grantPlayerAccess: vi.fn(async () => undefined)
}));
vi.mock("@/lib/apps/minecraft/address", () => ({ setGameHostname: vi.fn(async () => null) }));
vi.mock("@/lib/apps/port-registry", () => ({ availableHostPort: vi.fn(async () => 19132) }));
vi.mock("@/lib/apps/minecraft/blueprint-version", async (original) => ({
    ...(await original<typeof import("@/lib/apps/minecraft/blueprint-version")>()),
    commonVersions: vi.fn(async () => [])
}));

const { createGameServer } = await import("@/lib/apps/games-create");

type Env = { key: string; value: string }[];
type Seed = { installedAppId: string; env: { key: string; value: string; isSecret: boolean }[] };

function server(software: string, version: string) {
    return createGameServerSchema.parse({
        game: "minecraft",
        name: "Offgrid",
        serverId: "local",
        ownerPlayer: "Steve",
        ownerAddress: "203.0.113.9",
        edition: "java",
        software,
        version
    });
}

function created() {
    const [, , input, , seed] = installApp.mock.calls[0] as [
        unknown,
        unknown,
        { env: Env },
        unknown,
        Seed | undefined
    ];
    const env = new Map(input.env.map((entry) => [entry.key, entry.value]));
    return { env, seed };
}

beforeEach(() => {
    installApp.mockClear();
});

describe("a new server's login", () => {
    it("is Polaris login where there is a build", async () => {
        await createGameServer("owner", "actor", server("NEOFORGE", "1.21.4"));
        const { env, seed } = created();
        expect(seed).toBeDefined();
        const written = new Map(seed!.env.map((entry) => [entry.key, entry]));
        expect(written.get("POLARIS_LOGIN")?.value).toBe("on");
        expect(written.get("POLARIS_SERVER_ID")?.value).toBe(seed!.installedAppId);
        expect(written.get("POLARIS_URL")?.value).toBe("https://polaris.example");
        expect(written.get("MODS")?.value).toBe(
            "https://polaris.example/api/minecraft/mod/polaris-neoforge-1.21.4.jar"
        );
        expect(written.get("POLARIS_SERVER_TOKEN")?.isSecret).toBe(true);
        expect(written.get("POLARIS_SERVER_TOKEN")?.value).toMatch(/^[0-9a-f]{64}$/);
        expect(env.get("MODRINTH_PROJECTS") ?? "").not.toMatch(/\bauth\b/);
    });

    it("is the Modrinth guard where there is none", async () => {
        await createGameServer("owner", "actor", server("NEOFORGE", "1.21.1"));
        const { env, seed } = created();
        expect(seed).toBeUndefined();
        expect(env.get("MODRINTH_PROJECTS")).toMatch(/\bauth\?/);
    });

    it("is the plugin on a plugin server", async () => {
        await createGameServer("owner", "actor", server("PAPER", "1.21.4"));
        const { env, seed } = created();
        expect(seed).toBeUndefined();
        expect(env.get("MODRINTH_PROJECTS")).toMatch(/simple-login\?/);
    });

    it("gets a fresh id and token per server", async () => {
        await createGameServer("owner", "actor", server("NEOFORGE", "1.21.4"));
        await createGameServer("owner", "actor", server("NEOFORGE", "1.21.4"));
        const seeds = installApp.mock.calls.map((call) => call[4] as Seed);
        expect(seeds[0]!.installedAppId).not.toBe(seeds[1]!.installedAppId);
        const token = (seed: Seed) =>
            seed.env.find((entry) => entry.key === "POLARIS_SERVER_TOKEN")?.value;
        expect(token(seeds[0]!)).not.toBe(token(seeds[1]!));
    });
});
