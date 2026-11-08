/**
 * The login a new Minecraft server is created with: none.
 *
 * The join password is opt-in. A new server gets neither Polaris login nor a
 * Modrinth password project, whatever it runs; the operator turns one on from
 * the join-password card. Polaris anti-cheat is unaffected and still seeded.
 */

import { beforeEach, describe, expect, it, vi } from "vitest";
import { createGameServerSchema } from "@polaris-app/game-servers/src/lib/games-schema";

vi.mock("@polaris-app/game-servers/src/lib/minecraft/mod-token", () => ({
    modToken: () => "key",
    modTokenMatches: (token: string) => token === "key"
}));

const installApp = vi.fn(async (..._args: unknown[]) => ({
    installedAppId: "created",
    applicationId: "app"
}));

vi.mock("@/lib/apps/install-service", () => ({ installApp }));
const publicAppUrl = vi.fn(async (): Promise<string | null> => "https://polaris.example");
vi.mock("@/lib/domain-service", () => ({ publicAppUrl }));
vi.mock("@/lib/apps/install-config", () => ({ patchInstallConfig: vi.fn(async () => undefined) }));
vi.mock("@polaris-app/game-servers/src/lib/minecraft/player-access", () => ({
    grantPlayerAccess: vi.fn(async () => undefined)
}));
vi.mock("@polaris-app/game-servers/src/lib/minecraft/address", () => ({
    setGameHostname: vi.fn(async () => null)
}));
vi.mock("@polaris-app/game-servers/src/lib/minecraft/polaris-mod-files", async (original) => ({
    ...(await original<
        typeof import("@polaris-app/game-servers/src/lib/minecraft/polaris-mod-files")
    >()),
    anticheatBundled: vi.fn(async () => true)
}));
vi.mock("@/lib/apps/port-registry", () => ({ availableHostPort: vi.fn(async () => 19132) }));
vi.mock("@polaris-app/game-servers/src/lib/minecraft/blueprint-version", async (original) => ({
    ...(await original<
        typeof import("@polaris-app/game-servers/src/lib/minecraft/blueprint-version")
    >()),
    commonVersions: vi.fn(async () => [])
}));

const { createGameServer } = await import("@polaris-app/game-servers/src/lib/games-create");

type Env = { key: string; value: string }[];
type Seed = { installedAppId: string; env: { key: string; value: string; isSecret: boolean }[] };

function server(software: string, version: string) {
    return createGameServerSchema.parse({
        game: "minecraft",
        name: "ExampleSMP",
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

/** The login and anti-cheat settings a seed carries, beside the world's. */
function polarisKeys(seed: Seed | undefined): string[] {
    return (seed?.env ?? []).map((entry) => entry.key).filter((key) => key.startsWith("POLARIS_"));
}

beforeEach(() => {
    installApp.mockClear();
    publicAppUrl.mockClear();
});

describe("a new server's login", () => {
    // The join password is opt-in: no new server is given Polaris login or a
    // password project, whatever its software and release. The operator turns it
    // on from the join-password card.
    const GUARDS = /\b(simple-login|mylogin|auth)\b/;

    for (const [software, version] of [
        ["NEOFORGE", "1.21.4"],
        ["NEOFORGE", "1.21.1"],
        ["PAPER", "1.21.4"],
        ["PAPER", "1.20.4"]
    ] as const) {
        it(`is none on ${software} ${version}`, async () => {
            await createGameServer("owner", "actor", server(software, version));
            const { env, seed } = created();
            const written = new Map((seed?.env ?? []).map((entry) => [entry.key, entry.value]));
            expect(written.has("POLARIS_LOGIN")).toBe(false);
            expect(env.has("POLARIS_LOGIN")).toBe(false);
            expect(written.get("MODS") ?? "").not.toMatch(/polaris-paper\.jar/);
            expect(env.get("MODRINTH_PROJECTS") ?? "").not.toMatch(GUARDS);
        });
    }

    it("is none where Polaris has no public address either", async () => {
        publicAppUrl.mockResolvedValue(null);
        await createGameServer("owner", "actor", server("NEOFORGE", "1.21.4"));
        publicAppUrl.mockResolvedValue("https://polaris.example");
        const { env, seed } = created();
        expect(polarisKeys(seed)).toEqual([]);
        expect(env.get("MODRINTH_PROJECTS") ?? "").not.toMatch(GUARDS);
    });

    it("still gets Polaris anti-cheat on a plugin server", async () => {
        await createGameServer("owner", "actor", server("PAPER", "1.20.4"));
        const { seed } = created();
        const written = new Map(seed!.env.map((entry) => [entry.key, entry.value]));
        expect(written.get("POLARIS_ANTICHEAT")).toBe("on");
        expect(written.get("MODS")).toBe(
            "https://polaris.example/api/minecraft/mod/key/polaris-anticheat-bukkit.jar"
        );
    });

    it("gets a fresh id and token per server", async () => {
        await createGameServer("owner", "actor", server("PAPER", "1.21.4"));
        await createGameServer("owner", "actor", server("PAPER", "1.21.4"));
        const seeds = installApp.mock.calls.map((call) => call[4] as Seed);
        expect(seeds[0]!.installedAppId).not.toBe(seeds[1]!.installedAppId);
        const token = (seed: Seed) =>
            seed.env.find((entry) => entry.key === "POLARIS_SERVER_TOKEN")?.value;
        expect(token(seeds[0]!)).not.toBe(token(seeds[1]!));
    });
});

describe("a new server built on a map", () => {
    it("is given the map's world and level, which its form does not declare", async () => {
        await createGameServer(
            "owner",
            "actor",
            createGameServerSchema.parse({
                game: "minecraft",
                name: "Parkour",
                serverId: "local",
                ownerPlayer: "Steve",
                ownerAddress: "203.0.113.9",
                edition: "java",
                software: "PAPER",
                version: "LATEST",
                blueprintId: "parkour",
                mapId: "parkour-spiral"
            })
        );
        const { seed } = created();
        const written = new Map((seed?.env ?? []).map((entry) => [entry.key, entry.value]));
        expect(written.get("LEVEL")).toBe("parkour-spiral");
        expect(written.get("WORLD")).toBe(
            "https://polaris.example/api/minecraft/world/key/parkour-spiral.zip"
        );
    });
});
