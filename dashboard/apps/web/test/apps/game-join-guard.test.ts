/**
 * The password-on-join project every new server is given.
 *
 * A server with Mojang authentication off has only a name to go on, so anybody
 * who learns a name on the player list can wear it. Closing that was a switch
 * somebody had to find, which protects the servers whose owner read the screen
 * and no others - so it is a default now, and these are the rules that default
 * has to keep.
 *
 * Two of them matter more than the rest. It must never be the wrong project for
 * the loader, because a plugin on a modded server is not a weaker guard, it is a
 * jar that cannot load. And it must never be seeded twice, or written over an
 * entry somebody made more specific than Polaris knows how to.
 */

import { describe, expect, it } from "vitest";
import { protectionFor } from "@/lib/apps/games-create";
import { parseProjectList, projectSlug } from "@/lib/apps/minecraft/modrinth";
import {
    joinGuardEntry,
    joinGuardFor,
    joinGuardSlugs,
    JOIN_GUARD_SLUGS
} from "@/lib/apps/minecraft/join-guard";

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
    it("carries the guard on a plugin server", () => {
        const list = protectionFor("java", "PAPER", "grimac?:alpha,coreprotect?,luckperms?");
        expect(guardsOn(list)).toEqual([joinGuardFor("PAPER")!.slug]);
    });

    it("keeps the plugins it was already given", () => {
        // The guard is added to the list, not substituted for it.
        const list = protectionFor("java", "PAPER", "grimac?:alpha,coreprotect?,luckperms?");
        expect(slugs(list)).toEqual(expect.arrayContaining(["grimac", "coreprotect", "luckperms"]));
    });

    it("carries the mod, and none of the plugins, on a modded server", () => {
        // The existing rule, which the guard must not undo: those three are Bukkit
        // plugins and a modded server cannot load them.
        const list = protectionFor("java", "NEOFORGE", "grimac?:alpha,coreprotect?,luckperms?");
        expect(guardsOn(list)).toEqual([joinGuardFor("NEOFORGE")!.slug]);
        expect(slugs(list)).not.toContain("grimac");
        expect(slugs(list)).not.toContain("luckperms");
    });

    it("never puts the plugin guard on a modded server", () => {
        const list = protectionFor("java", "FABRIC", `${joinGuardFor("PAPER")!.slug}?`);
        expect(slugs(list)).not.toContain(joinGuardFor("PAPER")!.slug);
        expect(guardsOn(list)).toEqual([joinGuardFor("FABRIC")!.slug]);
    });

    it("adds nothing to a vanilla server", () => {
        expect(guardsOn(protectionFor("java", "VANILLA", ""))).toEqual([]);
    });

    it("seeds it exactly once when it is already there", () => {
        const slug = joinGuardFor("PAPER")!.slug;
        expect(guardsOn(protectionFor("java", "PAPER", `${slug}?`))).toEqual([slug]);
    });

    it("leaves a pinned version alone rather than seeding beside it", () => {
        // A pin is somebody saying something more specific than this knows. Seeding
        // the loose entry next to it would leave the image two instructions for one
        // project, and the pin is the one that was meant.
        const slug = joinGuardFor("PAPER")!.slug;
        const list = protectionFor("java", "PAPER", `${slug}:1.2.3`);
        expect(list).toContain(`${slug}:1.2.3`);
        expect(guardsOn(list)).toEqual([slug]);
    });

    it("keeps a required entry required", () => {
        // Without the "?" the operator is saying the server should not start
        // without it. Seeding the optional form beside that would quietly undo it.
        const slug = joinGuardFor("PAPER")!.slug;
        const list = protectionFor("java", "PAPER", slug);
        expect(guardsOn(list)).toEqual([slug]);
        expect(list).not.toContain(`${slug}?`);
    });

    it("works from an empty list", () => {
        expect(guardsOn(protectionFor("java", "PAPER", ""))).toEqual([joinGuardFor("PAPER")!.slug]);
    });

    it("replaces the plugin guard it used to seed instead of adding a second", () => {
        // Servers created before the swap carry the old slug. A reset must not
        // leave them with two login plugins.
        const list = protectionFor("java", "PAPER", "coreprotect?,mylogin?");
        expect(guardsOn(list)).toEqual([joinGuardFor("PAPER")!.slug]);
        expect(slugs(list)).toContain("coreprotect");
    });

    it("takes the old plugin guard off a server moved to mods", () => {
        const list = protectionFor("java", "FABRIC", "mylogin?");
        expect(slugs(list)).not.toContain("mylogin");
        expect(guardsOn(list)).toEqual([joinGuardFor("FABRIC")!.slug]);
    });
});

describe("which slugs count as the guard being on", () => {
    it("counts the plugin guard's old slug as the plugin guard", () => {
        expect(joinGuardSlugs(joinGuardFor("PAPER")!)).toContain("mylogin");
        expect(joinGuardSlugs(joinGuardFor("NEOFORGE")!)).not.toContain("mylogin");
        expect(JOIN_GUARD_SLUGS).toContain("mylogin");
    });
});
