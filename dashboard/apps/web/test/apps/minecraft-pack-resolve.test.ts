/**
 * What a player is handed, and who may ask for it.
 *
 * The two things worth pinning down here are that the pack carries both lists -
 * the server's own mods and the ones only the players run, which is the whole
 * point of it - and that the address it is served from cannot be reached by
 * changing a character of the token, since the people who use it have no account
 * here and the link is all there is.
 */

import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("@polaris/config", () => ({ loadEnv: () => ({ POLARIS_AUTH_SECRET: "test-secret" }) }));

const builds = new Map<string, { version: string; filename: string; url: string; sha1: string }>();
/** Modrinth's client_side, by slug: "unsupported" is a server-only mod. */
const sides = new Map<string, string>();
/** Required dependencies, by the slug that needs them. */
const needs = new Map<string, string[]>();

vi.mock("@polaris-app/game-servers/src/lib/minecraft/modrinth", async (importOriginal) => {
    const real = await importOriginal<typeof import("@polaris-app/game-servers/src/lib/minecraft/modrinth")>();
    return {
        ...real,
        buildFor: vi.fn(
            async (entry: string) => builds.get(real.projectSlug(entry) ?? entry) ?? null
        ),
        readInstalledProjects: vi.fn(async (entries: readonly string[]) =>
            entries.map((entry) => {
                const slug = real.projectSlug(entry) ?? entry;
                return { entry, slug, serverOnly: sides.get(slug) === "unsupported" };
            })
        ),
        readRequirements: vi.fn(async (entries: readonly string[]) =>
            entries.flatMap((entry) => {
                const slug = real.projectSlug(entry) ?? entry;
                return (needs.get(slug) ?? []).map((needed) => ({
                    slug,
                    needs: needed,
                    needsTitle: needed,
                    available: true,
                    onList: entries.some((other) => real.projectSlug(other) === needed),
                    needsServerOnly: sides.get(needed) === "unsupported"
                }));
            })
        )
    };
});

const { clientMods, packCommands, packToken, packTokenMatches, packUrl, resolvePack } =
    await import("@polaris-app/game-servers/src/lib/minecraft/client-pack");
const { serverMods } = await import(
    "@polaris-app/game-servers/src/screens/installed/minecraft-client-mods"
);

function build(slug: string) {
    return {
        version: "1.0.0",
        filename: `${slug}-1.0.0.jar`,
        url: `https://cdn.modrinth.com/${slug}.jar`,
        sha1: "abc"
    };
}

beforeEach(() => {
    builds.clear();
    sides.clear();
    needs.clear();
    builds.set("securitycraft", build("securitycraft"));
    builds.set("xaeros-minimap", build("xaeros-minimap"));
});

describe("the pack a player installs", () => {
    it("carries the server's mods and the players' own, each marked with where it runs", async () => {
        const pack = await resolvePack({
            name: "Offgrid",
            software: "NEOFORGE",
            version: "1.21.4",
            projects: "securitycraft?",
            config: { clientMods: ["xaeros-minimap"] }
        });

        expect(pack.mods.map((mod) => [mod.filename, mod.where])).toEqual([
            ["securitycraft-1.0.0.jar", "server"],
            ["xaeros-minimap-1.0.0.jar", "player"]
        ]);
        expect(pack.missing).toEqual([]);
    });

    it("says which entries have no build here rather than dropping them", async () => {
        builds.delete("xaeros-minimap");
        const pack = await resolvePack({
            name: "Offgrid",
            software: "NEOFORGE",
            version: "1.21.4",
            projects: "securitycraft?",
            config: { clientMods: ["xaeros-minimap"] }
        });

        expect(pack.mods).toHaveLength(1);
        expect(pack.missing).toEqual(["xaeros-minimap"]);
    });

    it("reports a file it would not put on a player's machine rather than listing it", async () => {
        builds.set("securitycraft", {
            ...build("securitycraft"),
            filename: "../../evil.jar"
        });
        builds.set("xaeros-minimap", {
            ...build("xaeros-minimap"),
            url: "https://evil.example/xaeros.jar"
        });
        const pack = await resolvePack({
            name: "Offgrid",
            software: "NEOFORGE",
            version: "1.21.4",
            projects: "securitycraft?",
            config: { clientMods: ["xaeros-minimap"] }
        });

        expect(pack.mods).toEqual([]);
        expect(pack.missing).toEqual(["securitycraft?", "xaeros-minimap"]);
    });

    it("carries a checksum only when it is one, so a run never compares against nonsense", async () => {
        builds.set("securitycraft", { ...build("securitycraft"), sha1: "not-a-checksum" });
        const pack = await resolvePack({
            name: "Offgrid",
            software: "NEOFORGE",
            version: "1.21.4",
            projects: "securitycraft?",
            config: {}
        });

        expect(pack.mods[0]?.sha1).toBe("");
    });

    it("leaves out a mod that only runs on the server", async () => {
        builds.set("spark-server", build("spark-server"));
        sides.set("spark-server", "unsupported");
        const pack = await resolvePack({
            name: "Offgrid",
            software: "NEOFORGE",
            version: "1.21.4",
            projects: "securitycraft?,spark-server",
            config: {}
        });

        expect(pack.mods.map((mod) => mod.filename)).toEqual(["securitycraft-1.0.0.jar"]);
        expect(pack.missing).toEqual([]);
    });

    it("carries the libraries the server installs on its own, and theirs", async () => {
        builds.set("trashslot", build("trashslot"));
        builds.set("balm", build("balm"));
        builds.set("rechiseled", build("rechiseled"));
        builds.set("core-lib", build("core-lib"));
        builds.set("config-lib", build("config-lib"));
        needs.set("trashslot", ["balm"]);
        needs.set("rechiseled", ["core-lib"]);
        needs.set("core-lib", ["config-lib"]);
        needs.set("xaeros-minimap", ["balm"]);
        const pack = await resolvePack({
            name: "Offgrid",
            software: "NEOFORGE",
            version: "1.21.4",
            projects: "trashslot,rechiseled",
            config: { clientMods: ["xaeros-minimap"] }
        });

        expect(pack.mods.map((mod) => [mod.entry, mod.where])).toEqual([
            ["trashslot", "server"],
            ["rechiseled", "server"],
            ["xaeros-minimap", "player"],
            ["balm", "server"],
            ["core-lib", "server"],
            ["config-lib", "server"]
        ]);
    });

    it("does not hand a player a library that only runs on the server", async () => {
        builds.set("rechiseled", build("rechiseled"));
        builds.set("fusion", build("fusion"));
        needs.set("rechiseled", ["fusion"]);
        sides.set("fusion", "unsupported");
        const pack = await resolvePack({
            name: "Offgrid",
            software: "NEOFORGE",
            version: "1.21.4",
            projects: "rechiseled",
            config: {}
        });

        expect(pack.mods.map((mod) => mod.entry)).toEqual(["rechiseled"]);
    });

    it("has nothing to hand out for a server whose software loads no mods", async () => {
        const pack = await resolvePack({
            name: "Bedrock",
            software: "BEDROCK",
            version: "1.21.4",
            projects: "securitycraft?",
            config: {}
        });

        expect(pack.mods).toEqual([]);
        expect(pack.loader).toBe("");
    });

    it("reads the players' list off the install, and an absent one is empty", () => {
        expect(clientMods({ clientMods: ["a", "b"] })).toEqual(["a", "b"]);
        expect(clientMods({})).toEqual([]);
        expect(clientMods({ clientMods: "not a list" })).toEqual([]);
    });
});

describe("the server's mods a player is shown", () => {
    function project(slug: string, serverOnly = false) {
        return {
            entry: slug,
            slug,
            title: slug.toUpperCase(),
            description: `${slug} does things`,
            downloads: 0,
            categories: [],
            iconUrl: null,
            author: null,
            clientOnly: false,
            serverOnly,
            known: true,
            fitsVersion: null,
            fitsLoader: true
        };
    }
    function need(slug: string, needs: string, extra: Record<string, boolean> = {}) {
        return {
            slug,
            needs,
            needsTitle: needs.toUpperCase(),
            available: true,
            onList: false,
            needsServerOnly: false,
            ...extra
        };
    }

    it("lists what runs in the game, and the libraries it needs once each", () => {
        const shown = serverMods(
            [project("trashslot"), project("comforts"), project("spark", true)],
            [need("trashslot", "balm"), need("comforts", "balm"), need("spark", "lib")]
        );

        expect(shown.map((mod) => [mod.slug, mod.neededBy])).toEqual([
            ["trashslot", []],
            ["comforts", []],
            ["balm", ["TRASHSLOT", "COMFORTS"]]
        ]);
    });

    it("does not repeat a library already on the list, or one the game never loads", () => {
        const shown = serverMods(
            [project("rechiseled"), project("core-lib")],
            [
                need("rechiseled", "core-lib", { onList: true }),
                need("rechiseled", "fusion", { needsServerOnly: true })
            ]
        );

        expect(shown.map((mod) => mod.slug)).toEqual(["rechiseled", "core-lib"]);
    });
});

describe("the link the players are given", () => {
    it("is the same for one server and different for another", () => {
        expect(packToken("server-1")).toBe(packToken("server-1"));
        expect(packToken("server-1")).not.toBe(packToken("server-2"));
    });

    it("accepts only its own token", () => {
        const token = packToken("server-1");
        expect(packTokenMatches("server-1", token)).toBe(true);
        expect(packTokenMatches("server-2", token)).toBe(false);
        expect(packTokenMatches("server-1", `${token.slice(0, -1)}x`)).toBe(false);
        expect(packTokenMatches("server-1", "")).toBe(false);
    });

    it("carries the token in the address, without doubling the slash", () => {
        expect(packUrl("https://polaris.test/", "server-1", "install.sh")).toBe(
            `https://polaris.test/api/minecraft/pack/server-1/${packToken("server-1")}/install.sh`
        );
    });

    it("hands each system the line its own shell can run", () => {
        const commands = packCommands("https://polaris.test", "server-1");
        expect(commands.windows).toContain("powershell");
        expect(commands.windows).toContain("install.ps1");
        expect(commands.mac).toContain("curl -fsSL");
        expect(commands.mac).toContain("install.sh");
        expect(commands.linux).toBe(commands.mac);
    });
});
