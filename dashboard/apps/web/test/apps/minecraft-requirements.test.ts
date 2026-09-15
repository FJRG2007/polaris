/**
 * Reading what a mod list needs, once the answer is in.
 *
 * The walk that asks Modrinth is I/O and is not tested here. What is tested is
 * the half a row is drawn from, and it exists because of a real server: Dynamic
 * Lights declares Fabric API as required, Fabric API has no NeoForge build, and
 * the image treats a required dependency it cannot resolve as a reason to END THE
 * BOOT rather than a mod to skip. One press of Add, nine restarts, and a stopped
 * server with the reason in a log nobody opens.
 *
 * So two questions have to be answerable from one fetched answer: what is this
 * missing, and who would break if I took it away.
 */

import { describe, expect, it } from "vitest";
import { neededBy, requiredBy, type ModrinthRequirement } from "@/lib/apps/minecraft/modrinth";

/** One requirement, with only the fields a given test cares about spelled out. */
function need(
    fields: Partial<ModrinthRequirement> & { slug: string; needs: string }
): ModrinthRequirement {
    return {
        needsTitle: fields.needs,
        available: true,
        onList: false,
        ...fields
    };
}

describe("what a project still needs", () => {
    it("names the dependency that is not on the list", () => {
        const requires = [need({ slug: "dynamic-lights", needs: "fabric-api", available: false })];
        expect(neededBy(requires, "dynamic-lights").map((one) => one.needs)).toEqual([
            "fabric-api"
        ]);
    });

    it("says nothing about a dependency already on the list", () => {
        // It has a row of its own. Repeating it beside the thing that wanted it is
        // a warning about something that is already done.
        const requires = [need({ slug: "corpse", needs: "balm", onList: true })];
        expect(neededBy(requires, "corpse")).toEqual([]);
    });

    it("keeps the two apart when one project needs several things", () => {
        const requires = [
            need({ slug: "a", needs: "one" }),
            need({ slug: "a", needs: "two" }),
            need({ slug: "b", needs: "three" })
        ];
        expect(neededBy(requires, "a").map((one) => one.needs)).toEqual(["one", "two"]);
        expect(neededBy(requires, "b").map((one) => one.needs)).toEqual(["three"]);
    });

    it("carries whether this server can have it at all", () => {
        // The difference between a mod that is missing something and a server that
        // will not start. Nothing else on the row can say which it is.
        const requires = [
            need({ slug: "a", needs: "fabric-api", available: false }),
            need({ slug: "b", needs: "balm", available: true })
        ];
        expect(neededBy(requires, "a")[0]?.available).toBe(false);
        expect(neededBy(requires, "b")[0]?.available).toBe(true);
    });

    it("matches however the slug is cased", () => {
        expect(neededBy([need({ slug: "Corpse", needs: "balm" })], "corpse")).toHaveLength(1);
    });

    it("says nothing for a project nobody recorded anything about", () => {
        expect(neededBy([], "anything")).toEqual([]);
    });
});

describe("who needs a project", () => {
    it("names what would break without it", () => {
        const requires = [need({ slug: "dynamic-lights", needs: "fabric-api" })];
        expect(requiredBy(requires, "fabric-api")).toEqual(["dynamic-lights"]);
    });

    it("names every one of them, once each", () => {
        const requires = [
            need({ slug: "a", needs: "balm" }),
            need({ slug: "b", needs: "balm" }),
            need({ slug: "a", needs: "balm" })
        ];
        expect(requiredBy(requires, "balm")).toEqual(["a", "b"]);
    });

    it("matches however the slug is cased", () => {
        expect(requiredBy([need({ slug: "a", needs: "Balm" })], "balm")).toEqual(["a"]);
    });

    it("says nothing about a project nothing depends on", () => {
        // Which is most of them, and is what leaves an ordinary row unmarked.
        expect(requiredBy([need({ slug: "a", needs: "balm" })], "jei")).toEqual([]);
    });

    it("does not confuse needing with being needed", () => {
        // The two ends of the same record. Reading one for the other would mark
        // every dependency as the thing that wanted it.
        const requires = [need({ slug: "dynamic-lights", needs: "fabric-api" })];
        expect(requiredBy(requires, "dynamic-lights")).toEqual([]);
        expect(neededBy(requires, "fabric-api")).toEqual([]);
    });
});
