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
/** Modrinth's project ids, to the slug each one is. */
const ids = new Map<string, string>();

vi.mock("@polaris-app/game-servers/src/lib/minecraft/modrinth", async (importOriginal) => {
    const real =
        await importOriginal<
            typeof import("@polaris-app/game-servers/src/lib/minecraft/modrinth")
        >();
    return {
        ...real,
        buildFor: vi.fn(
            async (entry: string) => builds.get(real.projectSlug(entry) ?? entry) ?? null
        ),
        readInstalledProjects: vi.fn(async (entries: readonly string[]) =>
            entries.map((entry) => {
                const asked = real.projectSlug(entry) ?? entry;
                const slug = ids.get(asked) ?? asked;
                return {
                    entry,
                    slug,
                    title: slug.toUpperCase(),
                    description: `${slug} does things`,
                    iconUrl: null,
                    serverOnly: sides.get(slug) === "unsupported"
                };
            })
        ),
        readRequirements: vi.fn(async (entries: readonly string[]) => {
            const resolved = (entry: string) => {
                const asked = real.projectSlug(entry) ?? entry;
                return ids.get(asked) ?? asked;
            };
            return entries.flatMap((entry) => {
                const slug = resolved(entry);
                return (needs.get(slug) ?? []).map((needed) => ({
                    slug,
                    needs: needed,
                    needsTitle: needed.toUpperCase(),
                    available: true,
                    onList: entries.some((other) => resolved(other) === needed),
                    needsServerOnly: sides.get(needed) === "unsupported",
                    release: real.entryReleaseType(entry)
                }));
            });
        })
    };
});

const {
    clientMods,
    isJarName,
    packCommands,
    packEntries,
    packToken,
    packTokenMatches,
    packUrl,
    resolvePack,
    setAsidePlan
} = await import("@polaris-app/game-servers/src/lib/minecraft/client-pack");

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
    ids.clear();
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

    it("asks for a library at the release type of the mod that needs it", async () => {
        builds.set("somemod", build("somemod"));
        builds.set("somelib", build("somelib"));
        needs.set("somemod", ["somelib"]);
        const pack = await resolvePack({
            name: "Offgrid",
            software: "NEOFORGE",
            version: "1.21.4",
            projects: "somemod:beta",
            config: {}
        });

        expect(pack.mods.map((mod) => mod.entry)).toEqual(["somemod:beta", "somelib:beta"]);
    });

    it("hands out a library once when the list names it by its id", async () => {
        builds.set("sodium", build("sodium"));
        builds.set("P7dR8mSH", build("fabric-api"));
        builds.set("fabric-api", build("fabric-api"));
        ids.set("P7dR8mSH", "fabric-api");
        needs.set("sodium", ["fabric-api"]);
        const pack = await resolvePack({
            name: "Offgrid",
            software: "FABRIC",
            version: "1.21.4",
            projects: "P7dR8mSH",
            config: { clientMods: ["sodium"] }
        });

        expect(pack.mods.map((mod) => [mod.entry, mod.where])).toEqual([
            ["P7dR8mSH", "server"],
            ["sodium", "player"]
        ]);
    });

    it("hands out a mod on both lists once", async () => {
        const pack = await resolvePack({
            name: "Offgrid",
            software: "NEOFORGE",
            version: "1.21.4",
            projects: "securitycraft",
            config: { clientMods: ["securitycraft"] }
        });

        expect(pack.mods.map((mod) => [mod.entry, mod.where])).toEqual([
            ["securitycraft", "server"]
        ]);
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
    it("is what the install hands out, with the libraries labelled by what needs them", async () => {
        needs.set("trashslot", ["balm"]);
        needs.set("comforts", ["balm"]);
        needs.set("balm", ["balm-core"]);
        sides.set("spark", "unsupported");
        const shown = await packEntries({
            server: ["trashslot", "comforts", "spark", "@/data/local.jar"],
            player: [],
            loader: "neoforge",
            version: "1.21.4"
        });

        expect(shown.map((mod) => [mod.key, mod.title, mod.neededBy])).toEqual([
            ["trashslot", "TRASHSLOT", []],
            ["comforts", "COMFORTS", []],
            ["balm", "BALM", ["TRASHSLOT", "COMFORTS"]],
            ["balm-core", "BALM-CORE", ["BALM"]]
        ]);
    });

    it("does not repeat a library already on the list, or one the game never loads", async () => {
        needs.set("rechiseled", ["core-lib", "fusion"]);
        sides.set("fusion", "unsupported");
        const shown = await packEntries({
            server: ["rechiseled", "core-lib"],
            player: [],
            loader: "neoforge",
            version: "1.21.4"
        });

        expect(shown.map((mod) => mod.key)).toEqual(["rechiseled", "core-lib"]);
    });

    it("puts a library on the server's side when a server mod needs it too", async () => {
        needs.set("xaeros-minimap", ["balm"]);
        needs.set("trashslot", ["balm"]);
        const shown = await packEntries({
            server: ["trashslot"],
            player: ["xaeros-minimap"],
            loader: "neoforge",
            version: "1.21.4"
        });

        expect(shown.map((mod) => [mod.key, mod.where])).toEqual([
            ["trashslot", "server"],
            ["xaeros-minimap", "player"],
            ["balm", "server"]
        ]);
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

describe("a player's own jars", () => {
    function mod(entry: string, projectId: string, incompatible: string[] = []) {
        return {
            entry,
            filename: `${entry}-1.0.jar`,
            url: `https://cdn.modrinth.com/${entry}.jar`,
            sha1: "a".repeat(40),
            version: "1.0",
            where: "player" as const,
            projectId,
            incompatible
        };
    }
    const mods = [mod("sodium", "SODIUM", ["EMBEDDIUM"]), mod("balm", "BALM")];
    const jar = (name: string, sha1: string) => ({ name, sha1 });
    const build = (projectId: string, incompatible: string[] = []) => ({ projectId, incompatible });
    const projects = new Map([
        ["1".repeat(40), build("SODIUM")],
        ["2".repeat(40), build("EMBEDDIUM")],
        ["3".repeat(40), build("XAERO")],
        ["5".repeat(40), build("OPTIFINE", ["BALM"])]
    ]);

    it("moves aside another copy of a mod in the pack, whatever it is called", () => {
        expect(setAsidePlan(mods, [jar("sodium-0.6.9-old.jar", "1".repeat(40))], projects)).toEqual(
            [
                {
                    name: "sodium-0.6.9-old.jar",
                    reason: "another copy of sodium, installed as sodium-1.0.jar"
                }
            ]
        );
    });

    it("moves aside a mod a mod in the pack cannot run beside", () => {
        expect(setAsidePlan(mods, [jar("embeddium.jar", "2".repeat(40))], projects)).toEqual([
            { name: "embeddium.jar", reason: "sodium cannot run beside it" }
        ]);
    });

    it("moves aside a mod whose own build cannot run beside one in the pack", () => {
        expect(setAsidePlan(mods, [jar("optifine.jar", "5".repeat(40))], projects)).toEqual([
            { name: "optifine.jar", reason: "it cannot run beside balm" }
        ]);
    });

    it("leaves every other jar of theirs alone, known to Modrinth or not", () => {
        expect(
            setAsidePlan(
                mods,
                [jar("xaeros-minimap.jar", "3".repeat(40)), jar("homemade.jar", "4".repeat(40))],
                projects
            )
        ).toEqual([]);
    });

    it("never names a file the pack itself installs", () => {
        expect(setAsidePlan(mods, [jar("sodium-1.0.jar", "1".repeat(40))], projects)).toEqual([]);
    });
});

describe("a jar name the installers may be told", () => {
    it("takes square brackets, which SecurityCraft publishes with", () => {
        expect(isJarName("[1.21.4] SecurityCraft v1.10.1.jar")).toBe(true);
    });

    it("refuses anything that could reach outside the mods folder", () => {
        expect(isJarName("../evil.jar")).toBe(false);
        expect(isJarName("mods/evil.jar")).toBe(false);
        expect(isJarName("a..b.jar")).toBe(false);
        expect(isJarName(".hidden.jar")).toBe(false);
        expect(isJarName("evil.jar\nrm -rf")).toBe(false);
    });
});
