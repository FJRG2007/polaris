/**
 * The password-on-join project, which a server carries only when its operator
 * turned it on.
 *
 * A server with Mojang authentication off has only a name to go on, so anybody
 * who learns a name on the player list can wear it. Closing that is the
 * operator's call, made on the join-password card: a new server, a reset and a
 * template add no project of their own. What they do is keep one that is
 * already there right for the server.
 *
 * Three rules matter more than the rest. It must never be the wrong project for
 * the loader, because a plugin on a modded server is not a weaker guard, it is a
 * jar that cannot load. It must never go on a release it cannot load on - the
 * plugin needs 1.20.5, and on 1.20.4 the server does not start. And it must never
 * be written twice, or over an entry somebody made more specific than Polaris
 * knows how to.
 */

import { findApp } from "@/lib/apps/catalog";
import { describe, expect, it, vi } from "vitest";
import { protectionFor } from "@polaris-app/game-servers/src/lib/games-create";
import {
    parseProjectList,
    projectSlug
} from "@polaris-app/game-servers/src/lib/minecraft/modrinth";
import {
    foreignLogin,
    guardAsTemplate,
    guardForSave,
    guardMovedTo,
    joinGuardEntry,
    joinGuardFits,
    joinGuardFor,
    joinGuardSlugs,
    JOIN_GUARD_SLUGS,
    PROJECTS_KEY,
    SOFTWARE_KEY,
    unfitGuardRemoved,
    withJoinGuardOn
} from "@polaris-app/game-servers/src/lib/minecraft/join-guard";

/** The newest release, which every guard loads on. */
const LATEST = { version: "LATEST" } as const;

vi.mock("@polaris-app/game-servers/src/lib/minecraft/mod-token", () => ({
    modToken: () => "key",
    modTokenMatches: (token: string) => token === "key"
}));

/** The slugs on a list, lowercased, suffixes and pins dropped. */
function slugs(list: string): string[] {
    return parseProjectList(list)
        .map((entry) => projectSlug(entry)?.toLowerCase())
        .filter((slug): slug is string => typeof slug === "string");
}

/** Which of the guards a list carries. Two would be the bug worth catching. */
function guardsOn(list: string): string[] {
    return slugs(list).filter((slug) => JOIN_GUARD_SLUGS.includes(slug));
}

describe("which guard a server can take", () => {
    it("gives a plugin server the plugin, with commands of its own", () => {
        for (const software of ["PAPER", "SPIGOT", "PURPUR"]) {
            const guard = joinGuardFor(software);
            expect(guard, software).not.toBeNull();
            expect(guard?.entry, software).toBe("command");
        }
    });

    it("gives a modded server the mod, and says the password is a number", () => {
        // Not a smaller version of the same thing: it is packaged as a data pack,
        // so a player drives it through `/trigger` and the password is an integer.
        // The screen reads `entry` to decide what to tell a player to type, and
        // telling a modded server's players to type `/register` would lock them
        // out of a server whose command does not exist.
        for (const software of ["FABRIC", "FORGE", "NEOFORGE"]) {
            const guard = joinGuardFor(software);
            expect(guard, software).not.toBeNull();
            expect(guard?.entry, software).toBe("trigger");
        }
    });

    it("gives the plugin and the mod different projects", () => {
        expect(joinGuardFor("PAPER")?.slug).not.toBe(joinGuardFor("NEOFORGE")?.slug);
    });

    it("offers a vanilla server nothing, because it loads nothing", () => {
        expect(joinGuardFor("VANILLA")).toBeNull();
        expect(joinGuardEntry("VANILLA")).toBeNull();
    });

    it("offers nothing for software it has never heard of", () => {
        expect(joinGuardFor("SPONGE")).toBeNull();
    });

    it("seeds it as optional, so a release with no build skips it", () => {
        // The alternative is a required entry the image cannot resolve, which does
        // not start the server without the guard - it does not start the server.
        expect(joinGuardEntry("PAPER")).toMatch(/\?$/);
        expect(joinGuardEntry("NEOFORGE")).toMatch(/\?$/);
    });

    it("names every slug it may seed, so one can be recognised anywhere", () => {
        expect(JOIN_GUARD_SLUGS).toContain(joinGuardFor("PAPER")?.slug);
        expect(JOIN_GUARD_SLUGS).toContain(joinGuardFor("NEOFORGE")?.slug);
    });
});

describe("what a new server's project list comes out with", () => {
    it("adds no guard to a plugin server", () => {
        // Opt-in: closing the server is the operator's call, not a default.
        const list = protectionFor("java", "PAPER", "grimac?:alpha,coreprotect?,luckperms?", LATEST);
        expect(guardsOn(list)).toEqual([]);
    });

    it("keeps the plugins it was already given", () => {
        // The guard is added to the list, not substituted for it.
        const list = protectionFor("java", "PAPER", "grimac?:alpha,coreprotect?,luckperms?", LATEST);
        expect(slugs(list)).toEqual(expect.arrayContaining(["grimac", "coreprotect", "luckperms"]));
    });

    it("carries no guard, and none of the plugins, on a modded server", () => {
        // Those three are Bukkit plugins and a modded server cannot load them.
        const list = protectionFor("java", "NEOFORGE", "grimac?:alpha,coreprotect?,luckperms?", LATEST);
        expect(guardsOn(list)).toEqual([]);
        expect(slugs(list)).not.toContain("grimac");
        expect(slugs(list)).not.toContain("luckperms");
    });

    it("never puts the plugin guard on a modded server", () => {
        const list = protectionFor("java", "FABRIC", `${joinGuardFor("PAPER")!.slug}?`, LATEST);
        expect(slugs(list)).not.toContain(joinGuardFor("PAPER")!.slug);
        expect(guardsOn(list)).toEqual([joinGuardFor("FABRIC")!.slug]);
    });

    it("adds nothing to a vanilla server", () => {
        expect(guardsOn(protectionFor("java", "VANILLA", "", LATEST))).toEqual([]);
    });

    it("seeds it exactly once when it is already there", () => {
        const slug = joinGuardFor("PAPER")!.slug;
        expect(guardsOn(protectionFor("java", "PAPER", `${slug}?`, LATEST))).toEqual([slug]);
    });

    it("leaves a pinned version alone rather than seeding beside it", () => {
        // A pin is somebody saying something more specific than this knows. Seeding
        // the loose entry next to it would leave the image two instructions for one
        // project, and the pin is the one that was meant.
        const slug = joinGuardFor("PAPER")!.slug;
        const list = protectionFor("java", "PAPER", `${slug}:1.2.3`, LATEST);
        expect(list).toContain(`${slug}:1.2.3`);
        expect(guardsOn(list)).toEqual([slug]);
    });

    it("keeps a required entry required", () => {
        // Without the "?" the operator is saying the server should not start
        // without it. Seeding the optional form beside that would quietly undo it.
        const slug = joinGuardFor("PAPER")!.slug;
        const list = protectionFor("java", "PAPER", slug, LATEST);
        expect(guardsOn(list)).toEqual([slug]);
        expect(list).not.toContain(`${slug}?`);
    });

    it("adds nothing to an empty list", () => {
        expect(guardsOn(protectionFor("java", "PAPER", "", LATEST))).toEqual([]);
        expect(guardsOn(protectionFor("java", "FABRIC", "", LATEST))).toEqual([]);
    });

    it("keeps the guard of a server that had it on", () => {
        // A reset is not a request to open the server either.
        const slug = joinGuardFor("PAPER")!.slug;
        expect(guardsOn(protectionFor("java", "PAPER", `coreprotect?,${slug}?`, LATEST))).toEqual([
            slug
        ]);
    });

    it("puts the guard back after Polaris login comes off, where the release loads it", () => {
        const slug = joinGuardFor("PAPER")!.slug;
        const closed = { version: "1.20.6", keepClosed: true };
        expect(guardsOn(protectionFor("java", "PAPER", "coreprotect?", closed))).toEqual([slug]);
        const old = { version: "1.20.4", keepClosed: true };
        expect(guardsOn(protectionFor("java", "PAPER", "coreprotect?", old))).toEqual([]);
    });

    it("keeps the plugin guard it used to seed instead of adding a second", () => {
        // Servers created before the swap carry the old slug, and their players
        // registered with it. A reset must not leave them with two login plugins,
        // nor move them to one where whoever joins first sets the password.
        const list = protectionFor("java", "PAPER", "coreprotect?,mylogin", LATEST);
        expect(guardsOn(list)).toEqual(["mylogin"]);
        expect(parseProjectList(list)).toContain("mylogin");
        expect(slugs(list)).toContain("coreprotect");
    });

    it("takes the mod guard off a server moved to plugins", () => {
        const list = protectionFor("java", "PAPER", "auth?", LATEST);
        expect(guardsOn(list)).toEqual([joinGuardFor("PAPER")!.slug]);
    });

    it("takes the old plugin guard off a server moved to mods", () => {
        const list = protectionFor("java", "FABRIC", "mylogin?", LATEST);
        expect(slugs(list)).not.toContain("mylogin");
        expect(guardsOn(list)).toEqual([joinGuardFor("FABRIC")!.slug]);
    });
});

/**
 * simple-login's current builds need Java 21, which Minecraft moved to at
 * 1.20.5. On 1.20.4 and older Paper stops at the plugin, so the server does not
 * start: it must never be put there, and comes off a server moved there.
 */
describe("a release the plugin guard cannot load on", () => {
    const plugin = joinGuardFor("PAPER")!.slug;
    const old = { version: "1.20.4" };

    it("is 1.20.4 and older, never 1.20.5, a later one or LATEST", () => {
        for (const version of ["1.20.4", "1.20", "1.19.4", "1.8.8", "1.20.4-R0.1"]) {
            expect(joinGuardFits("PAPER", version), version).toBeNull();
        }
        for (const version of ["1.20.5", "1.20.6", "1.21.4", "LATEST", "latest", "", "  "]) {
            expect(joinGuardFits("PAPER", version)?.slug, version).toBe(plugin);
        }
    });

    it("leaves the mod guard on every release", () => {
        expect(joinGuardFits("NEOFORGE", "1.20.1")?.slug).toBe(joinGuardFor("NEOFORGE")!.slug);
    });

    it("comes off a reset onto such a release, and nothing goes on instead", () => {
        const list = protectionFor("java", "PAPER", `coreprotect?,${plugin}?`, old);
        expect(guardsOn(list)).toEqual([]);
        expect(slugs(list)).toContain("coreprotect");
        // Pinned or required makes no difference: it would still stop the boot.
        expect(guardsOn(protectionFor("java", "PAPER", `${plugin}:1.2.3`, old))).toEqual([]);
        // The mod guard moving onto old Paper does not become the plugin either.
        expect(guardsOn(protectionFor("java", "PAPER", "auth?", old))).toEqual([]);
    });

    it("leaves an older slug it replaced as the server had it", () => {
        expect(guardsOn(protectionFor("java", "PAPER", "mylogin?", old))).toEqual(["mylogin"]);
    });

    it("is never put on by turning the guard on", () => {
        expect(guardsOn(withJoinGuardOn("coreprotect?", "PAPER", "1.20.4"))).toEqual([]);
        expect(guardsOn(withJoinGuardOn("coreprotect?", "PAPER", "1.20.5"))).toEqual([plugin]);
    });

    it("comes off a server whose software moves onto such a release", () => {
        const moved = guardMovedTo(`coreprotect?,${plugin}?`, "PAPER", "1.20.4");
        expect(moved).toBe("coreprotect?");
        expect(guardMovedTo("auth?", "PAPER", "1.20.4")).toBe("");
        expect(guardMovedTo(`${plugin}?`, "PAPER", "1.20.5")).toBeNull();
    });

    it("comes off on a save that moves the release below 1.20.5", async () => {
        const read = vi.fn(
            async () =>
                new Map([
                    ["TYPE", "PAPER"],
                    ["VERSION", "1.21.1"],
                    ["MODRINTH_PROJECTS", `coreprotect?,${plugin}?`]
                ])
        );
        const writes = await guardForSave([{ key: "VERSION", value: "1.20.4" }], read);
        expect(writes).toContainEqual({ key: PROJECTS_KEY, value: "coreprotect?" });
        // And nothing on a release it loads on.
        expect(
            (await guardForSave([{ key: "VERSION", value: "1.21.4" }], read)).filter(
                (entry) => entry.key === PROJECTS_KEY
            )
        ).toEqual([]);
    });

    it("is taken off an existing server by the periodic pass, and nothing else is", () => {
        expect(unfitGuardRemoved(`coreprotect?,${plugin}?`, "PAPER", "1.20.4")).toBe(
            "coreprotect?"
        );
        // A release it loads on, a server without it, or another guard: untouched,
        // because whether somebody asked for it cannot be told from here.
        expect(unfitGuardRemoved(`${plugin}?`, "PAPER", "1.21.4")).toBeNull();
        expect(unfitGuardRemoved(`${plugin}?`, "PAPER", "LATEST")).toBeNull();
        expect(unfitGuardRemoved("coreprotect?", "PAPER", "1.20.4")).toBeNull();
        expect(unfitGuardRemoved("mylogin?", "PAPER", "1.20.4")).toBeNull();
        expect(unfitGuardRemoved("auth?", "NEOFORGE", "1.20.1")).toBeNull();
    });
});

describe("which slugs count as the guard being on", () => {
    it("counts the plugin guard's old slug as the plugin guard", () => {
        expect(joinGuardSlugs(joinGuardFor("PAPER")!)).toContain("mylogin");
        expect(joinGuardSlugs(joinGuardFor("NEOFORGE")!)).not.toContain("mylogin");
        expect(JOIN_GUARD_SLUGS).toContain("mylogin");
    });
});

/**
 * A server whose software is changed after it was built.
 *
 * The guard is the one thing on the mod list that was closing the server, and it
 * is the one thing a change of software silently invalidates: a plugin does not
 * load on a mod loader, the entry is optional so the image skips it rather than
 * complaining, and the server comes back up with nobody asked for a password.
 * Nothing on screen would have said so.
 *
 * What it must not do is decide for the operator. Whether a server asks for a
 * password is their answer, and changing the software is not them changing it -
 * in either direction.
 */
describe("moving the guard when the software changes", () => {
    const plugin = joinGuardFor("PAPER")!.slug;
    const mod = joinGuardFor("NEOFORGE")!.slug;

    it("swaps the plugin for the mod on the way to a mod loader", () => {
        const moved = guardMovedTo(`coreprotect?,${plugin}?`, "NEOFORGE", "LATEST");
        expect(moved).not.toBeNull();
        expect(guardsOn(moved!)).toEqual([mod]);
        expect(slugs(moved!)).toContain("coreprotect");
    });

    it("swaps the mod for the plugin on the way back", () => {
        const moved = guardMovedTo(`${mod}?`, "PAPER", "LATEST");
        expect(guardsOn(moved!)).toEqual([plugin]);
    });

    it("leaves a server that never asked for a password alone", () => {
        // The half that keeps this from being a decision Polaris makes: no guard
        // on the list is an answer, and a change of software is not a request to
        // start asking.
        expect(guardMovedTo("coreprotect?,luckperms?", "NEOFORGE", "LATEST")).toBeNull();
        expect(guardMovedTo("", "PAPER", "LATEST")).toBeNull();
    });

    it("says nothing when the guard already suits the software", () => {
        // Null rather than the same list back, so the caller writes nothing at
        // all on the saves that are not a change of software - which is almost
        // all of them.
        expect(guardMovedTo(`coreprotect?,${plugin}?`, "PAPER", "LATEST")).toBeNull();
        expect(guardMovedTo(`${mod}?`, "FABRIC", "LATEST")).toBeNull();
    });

    it("counts a legacy slug as already suiting a plugin server", () => {
        // The same rule `replaces` states: an older server keeps what it has,
        // because the two projects hold their passwords in different places.
        expect(guardMovedTo("mylogin?", "PAPER", "LATEST")).toBeNull();
    });

    it("moves a legacy slug off a server that is no longer a plugin server", () => {
        const moved = guardMovedTo("mylogin?", "NEOFORGE", "LATEST");
        expect(slugs(moved!)).not.toContain("mylogin");
        expect(guardsOn(moved!)).toEqual([mod]);
    });

    it("leaves the guard on software that can load neither", () => {
        // Vanilla installs nothing from the list, so the entry costs nothing
        // there, and it is the only record that the server was closed.
        expect(guardMovedTo(`coreprotect?,${plugin}?`, "VANILLA", "LATEST")).toBeNull();
    });

    it("puts the guard back on a server moved to Vanilla and off again", () => {
        const list = `coreprotect?,${plugin}?`;
        expect(guardMovedTo(list, "VANILLA", "LATEST")).toBeNull();
        expect(guardMovedTo(list, "PAPER", "LATEST")).toBeNull();
        expect(guardsOn(guardMovedTo(list, "NEOFORGE", "LATEST")!)).toEqual([mod]);
    });
});

/**
 * Which settings saves move the guard. The card that turns the password off
 * writes the project list itself, and a save that is not a change of software or
 * release has nothing to move - neither may reach for the current environment.
 */
describe("reconciling the guard on a settings save", () => {
    const plugin = joinGuardFor("PAPER")!.slug;
    const mod = joinGuardFor("NEOFORGE")!.slug;
    const listed = `coreprotect?,${plugin}?`;

    const reader = (env: Record<string, string> = { MODRINTH_PROJECTS: listed, TYPE: "PAPER" }) =>
        vi.fn(async () => new Map(Object.entries(env)));
    const written = (writes: { key: string; value: string }[]) =>
        new Map(writes.map((entry) => [entry.key, entry.value]));

    it("moves the guard when the save changes the software", async () => {
        const read = reader();
        const moved = await guardForSave([{ key: "TYPE", value: "NEOFORGE" }], read);
        expect(guardsOn(written(moved).get(PROJECTS_KEY) ?? "")).toEqual([mod]);
        expect(read).toHaveBeenCalledTimes(1);
    });

    it("leaves the card's Turn off alone", async () => {
        const read = reader();
        const vars = [
            { key: "TYPE", value: "NEOFORGE" },
            { key: "MODRINTH_PROJECTS", value: "coreprotect?" }
        ];
        expect(await guardForSave(vars, read)).toEqual([]);
        expect(await guardForSave([{ key: "MODRINTH_PROJECTS", value: "" }], read)).toEqual([]);
        expect(read).not.toHaveBeenCalled();
    });

    it("does not read the environment on a save that keeps the software", async () => {
        const read = reader();
        expect(await guardForSave([{ key: "DIFFICULTY", value: "hard" }], read)).toEqual([]);
        expect(await guardForSave([{ key: "TYPE", value: "" }], read)).toEqual([]);
        expect(read).not.toHaveBeenCalled();
    });

    it("writes nothing when the guard already suits the new software", async () => {
        const read = reader();
        expect(await guardForSave([{ key: "TYPE", value: "PURPUR" }], read)).toEqual([]);
    });

    const modded = {
        TYPE: "NEOFORGE",
        VERSION: "1.21.4",
        MODRINTH_PROJECTS: "open-parties-and-claims?",
        MODS: "https://polaris.example/api/minecraft/mod/key/polaris-neoforge-1.21.4.jar",
        POLARIS_LOGIN: "on"
    };

    it("keeps Polaris login where it has a build, and seeds nothing beside it", async () => {
        const vars = [
            { key: "TYPE", value: "NEOFORGE" },
            { key: "VERSION", value: "1.21.4" }
        ];
        expect(await guardForSave(vars, reader(modded))).toEqual([]);
    });

    it("takes Polaris login off a release with no build, and closes the server another way", async () => {
        const writes = written(
            await guardForSave([{ key: "VERSION", value: "1.21.1" }], reader(modded))
        );
        expect(writes.get("POLARIS_LOGIN")).toBe("off");
        // Emptied rather than dropped, which is what makes the image remove the jar.
        expect(writes.get("MODS")).toBe("");
        expect(guardsOn(writes.get(PROJECTS_KEY) ?? "")).toEqual([mod]);
    });

    it("moves Polaris login to the plugin on a plugin server, and seeds nothing beside it", async () => {
        const writes = written(
            await guardForSave([{ key: "TYPE", value: "PAPER" }], reader(modded))
        );
        expect(writes.get("MODS")).toBe(
            "https://polaris.example/api/minecraft/mod/key/polaris-paper.jar"
        );
        expect(writes.has("POLARIS_LOGIN")).toBe(false);
        expect(writes.has(PROJECTS_KEY)).toBe(false);
    });

    it("takes Polaris login off a plugin server on 1.20.5, and seeds the plugin guard", async () => {
        const writes = written(
            await guardForSave(
                [
                    { key: "TYPE", value: "PAPER" },
                    { key: "VERSION", value: "1.20.5" }
                ],
                reader(modded)
            )
        );
        expect(writes.get("POLARIS_LOGIN")).toBe("off");
        expect(guardsOn(writes.get(PROJECTS_KEY) ?? "")).toEqual([plugin]);
    });

    it("takes Polaris login off a plugin server on 1.20.4, and seeds no plugin it cannot load", async () => {
        const writes = written(
            await guardForSave(
                [
                    { key: "TYPE", value: "PAPER" },
                    { key: "VERSION", value: "1.20.4" }
                ],
                reader(modded)
            )
        );
        expect(writes.get("POLARIS_LOGIN")).toBe("off");
        expect(guardsOn(writes.get(PROJECTS_KEY) ?? "")).toEqual([]);
    });

    it("puts no guard on a server that had none, whatever the save moves", async () => {
        const read = reader({ TYPE: "PAPER", VERSION: "1.21.4", MODRINTH_PROJECTS: "coreprotect?" });
        for (const vars of [
            [{ key: "TYPE", value: "NEOFORGE" }],
            [{ key: "VERSION", value: "1.20.6" }],
            [{ key: "TYPE", value: "FABRIC" }, { key: "VERSION", value: "1.21.1" }]
        ]) {
            expect(await guardForSave(vars, read), JSON.stringify(vars)).toEqual([]);
        }
    });

    it("takes Polaris login off software with no build, and seeds its guard", async () => {
        const writes = written(
            await guardForSave([{ key: "TYPE", value: "FABRIC" }], reader(modded))
        );
        expect(writes.get("POLARIS_LOGIN")).toBe("off");
        expect(guardsOn(writes.get(PROJECTS_KEY) ?? "")).toEqual([mod]);
    });
});

/**
 * A reset rebuilds the list around the new blueprint, and a server running
 * Polaris's login mod must come out of it with that mod as its only guard.
 */
describe("the list of a server running Polaris login", () => {
    it("gets no project guard, and loses one it had", () => {
        expect(guardsOn(protectionFor("java", "NEOFORGE", "auth?", { version: "LATEST", modOn: true }))).toEqual([]);
        expect(guardsOn(protectionFor("java", "PAPER", "", { version: "LATEST", modOn: true }))).toEqual([]);
    });

    it("keeps everything that is not a guard", () => {
        expect(slugs(protectionFor("java", "NEOFORGE", "create?,auth?", { version: "LATEST", modOn: true }))).toContain("create");
    });
});

/**
 * A template remembers the kind of server, never this one's login: the mod's id
 * and token are never copied, and no project guard goes on in its place - the
 * password is opt-in.
 */
describe("a template made from a server running Polaris login", () => {
    const env = new Map([
        ["TYPE", "NEOFORGE"],
        ["MODRINTH_PROJECTS", "create?"],
        [
            "MODS",
            "https://example.org/extra.jar,https://polaris.example/api/minecraft/mod/key/polaris-neoforge-1.21.4.jar"
        ],
        ["POLARIS_LOGIN", "on"]
    ]);

    it("keeps the other jars and adds no project guard", () => {
        const kept = guardAsTemplate(env);
        expect(kept.get("MODS")).toBe("https://example.org/extra.jar");
        expect(guardsOn(kept.get(PROJECTS_KEY) ?? "")).toEqual([]);
        expect(slugs(kept.get(PROJECTS_KEY) ?? "")).toContain("create");
    });

    it("takes the plugin guard off a template on a release it cannot load", () => {
        const old = new Map([
            ["TYPE", "PAPER"],
            ["VERSION", "1.20.4"],
            ["MODRINTH_PROJECTS", "coreprotect?,simple-login?"],
            ["MODS", "https://polaris.example/api/minecraft/mod/key/polaris-paper.jar"],
            ["POLARIS_LOGIN", "on"]
        ]);
        expect(guardAsTemplate(old).get(PROJECTS_KEY)).toBe("coreprotect?");
    });

    it("leaves a server without it alone", () => {
        const plain = new Map([["MODRINTH_PROJECTS", "create?"]]);
        expect(guardAsTemplate(plain)).toEqual(plain);
    });

    it("does not carry Polaris anti-cheat's jar, with the login on or off", () => {
        const jar = "https://polaris.example/api/minecraft/mod/key/polaris-anticheat-bukkit.jar";
        const paper = new Map([
            ["TYPE", "PAPER"],
            ["MODS", `https://example.org/extra.jar,${jar}`]
        ]);
        expect(guardAsTemplate(paper).get("MODS")).toBe("https://example.org/extra.jar");
        const both = new Map([
            ["TYPE", "PAPER"],
            ["MODS", `https://polaris.example/api/minecraft/mod/key/polaris-paper.jar,${jar}`],
            ["POLARIS_LOGIN", "on"]
        ]);
        expect(guardAsTemplate(both).get("MODS")).toBe("");
    });
});

/**
 * A login Polaris does not manage: recognised, and never joined by a second one.
 */
describe("a server with a login Polaris does not manage", () => {
    it("is recognised by its slug", () => {
        for (const slug of ["easyauth", "basic-login", "simple-auth"]) {
            expect(foreignLogin(`create?,${slug}:1.0`)).toBe(slug);
        }
        expect(foreignLogin("auth?,simple-login?")).toBeNull();
    });

    it("seeds no project guard beside a login Polaris does not manage", () => {
        for (const software of ["NEOFORGE", "PAPER"]) {
            const list = protectionFor("java", software, "easyauth?,auth?,simple-login?", LATEST);
            expect(slugs(list), software).toContain("easyauth");
            expect(
                slugs(list).some((slug) => JOIN_GUARD_SLUGS.includes(slug)),
                software
            ).toBe(false);
        }
    });
});

/**
 * The one spelling of the key that is not an import.
 *
 * The manifest declares `MODRINTH_PROJECTS` as a literal and has to: it is the
 * catalog, and making a generic catalog import a Minecraft module to name one of
 * its own fields points the dependency the wrong way. So the two are held
 * together here instead. It matters because an undeclared key is dropped in
 * silence at install time - a manifest and a constant that disagree would not
 * fail to compile, they would produce servers with no mod list at all.
 */
describe("the key the manifest declares", () => {
    it("is the one the code reads and writes", () => {
        const declared = (findApp("minecraft")?.template?.env ?? []).map((entry) => entry.key);
        expect(declared).toContain(PROJECTS_KEY);
    });

    it("holds for the software key too, which is what triggers the move", () => {
        // `guardForSave` watches this key to decide a save changed the software.
        // Declared under another name, every such save would look like it changed
        // nothing and the guard would never follow the server across.
        const declared = (findApp("minecraft")?.template?.env ?? []).map((entry) => entry.key);
        expect(declared).toContain(SOFTWARE_KEY);
    });
});
