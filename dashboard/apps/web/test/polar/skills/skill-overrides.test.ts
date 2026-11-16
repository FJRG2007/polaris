/**
 * Edits over built-in and Enigma skills: the two tiers layer in order, an
 * upstream that moved after an edit is noticed, the diff and the three-way
 * merge behave, the inputs are bounded, and a chat loads the effective text.
 */

import { beforeEach, describe, expect, it, vi } from "vitest";

const rows: Record<string, unknown>[] = [];

vi.mock("@polaris/db", () => ({
    prisma: {
        polarSkillOverride: {
            findMany: vi.fn(async ({ where }: { where: { owner: { in: string[] } } }) =>
                rows.filter((row) => where.owner.in.includes(row.owner as string))
            )
        }
    }
}));
vi.mock("@/lib/polar/skills/enigma-catalogue", () => ({
    enigmaCatalogue: vi.fn(async () => ({ version: "1.0.0", available: true, skills: [], commands: [] }))
}));

import { SKILL_CATALOG } from "@/lib/polar/skills/catalog";
import { effectiveUpstreamSkills } from "@/lib/polar/skills/override-store";
import {
    OVERRIDE_INSTRUCTIONS_MAX,
    lineDiff,
    mergeThree,
    parseSkillKey,
    renderSkillMarkdown,
    resolveSkill,
    saveOverrideSchema,
    textHash,
    unifiedDiff
} from "@/lib/polar/skills/overrides";

const UP = { description: "Use when testing.", instructions: "# Test\n\nOne.\nTwo.\nThree." };

function row(owner: string, skill: string, text: Partial<Record<string, unknown>>) {
    return {
        owner,
        skill,
        description: null,
        instructions: null,
        baseDescription: null,
        baseInstructions: null,
        enabled: null,
        ...text
    };
}

describe("resolveSkill", () => {
    it("is the upstream text with no edits", () => {
        const resolved = resolveSkill(UP);
        expect(resolved.instructions).toBe(UP.instructions);
        expect(resolved.user).toBeNull();
        expect(resolved.instance).toBeNull();
    });

    it("puts a person's edit over the instance's, over upstream", () => {
        const instance = { ...UP, instructions: "instance", baseDescription: UP.description, baseInstructions: UP.instructions };
        const user = { ...UP, instructions: "mine", baseDescription: UP.description, baseInstructions: "instance" };
        expect(resolveSkill(UP, instance, null).instructions).toBe("instance");
        const both = resolveSkill(UP, instance, user);
        expect(both.instructions).toBe("mine");
        expect(both.belowUser.instructions).toBe("instance");
        expect(both.user?.upstreamChanged).toBe(false);
    });

    it("notices an upstream that changed after the edit", () => {
        const user = { ...UP, instructions: "mine", baseDescription: UP.description, baseInstructions: "old upstream" };
        const resolved = resolveSkill(UP, null, user);
        expect(resolved.instructions).toBe("mine");
        expect(resolved.user?.upstreamChanged).toBe(true);
    });

    it("treats a row with no text (only a switch) as no edit", () => {
        const resolved = resolveSkill(UP, null, { description: null, instructions: null, baseDescription: null, baseInstructions: null });
        expect(resolved.user).toBeNull();
        expect(resolved.instructions).toBe(UP.instructions);
    });
});

describe("diff and merge", () => {
    it("diffs by line", () => {
        const ops = lineDiff("a\nb\nc", "a\nB\nc");
        expect(ops).toEqual([
            { op: " ", line: "a" },
            { op: "-", line: "b" },
            { op: "+", line: "B" },
            { op: " ", line: "c" }
        ]);
        expect(unifiedDiff("a\nb\nc", "a\nb\nc", { from: "x", to: "y" })).toBe("");
        expect(unifiedDiff("a\nb\nc", "a\nB\nc", { from: "x", to: "y" })).toContain("@@ -1,3 +1,3 @@");
    });

    it("takes changes from both sides when they do not touch", () => {
        const base = "1\n2\n3\n4\n5\n6\n7";
        const merged = mergeThree(base, "1\nTWO\n3\n4\n5\n6\n7", "1\n2\n3\n4\n5\n6\nSEVEN", { mine: "mine", theirs: "up" });
        expect(merged).toEqual({ text: "1\nTWO\n3\n4\n5\n6\nSEVEN", conflicts: 0 });
    });

    it("marks a region both sides changed differently", () => {
        const merged = mergeThree("a\nb\nc", "a\nmine\nc", "a\ntheirs\nc", { mine: "mine", theirs: "up" });
        expect(merged.conflicts).toBe(1);
        expect(merged.text).toBe("a\n<<<<<<< mine\nmine\n=======\ntheirs\n>>>>>>> up\nc");
    });

    it("takes the same change on both sides once", () => {
        expect(mergeThree("a\nb", "a\nx", "a\nx", { mine: "m", theirs: "t" })).toEqual({ text: "a\nx", conflicts: 0 });
    });
});

describe("inputs", () => {
    it("accepts only known key shapes and bounded text", () => {
        expect(parseSkillKey("enigma:security-policy")).toEqual({ kind: "enigma", name: "security-policy" });
        expect(parseSkillKey("custom:x")).toBeNull();
        expect(parseSkillKey("enigma:../etc")).toBeNull();
        const good = { skill: "builtin:pr-review", tier: "user", against: textHash(UP), ...UP };
        expect(saveOverrideSchema.safeParse(good).success).toBe(true);
        for (const bad of [
            { ...good, tier: "org" },
            { ...good, against: "nothex!!" },
            { ...good, description: "   " },
            { ...good, instructions: "x".repeat(OVERRIDE_INSTRUCTIONS_MAX + 1) },
            { ...good, extra: true }
        ])
            expect(saveOverrideSchema.safeParse(bad).success).toBe(false);
    });

    it("renders a SKILL.md with quoted front matter", () => {
        const md = renderSkillMarkdown("x", { description: 'say "hi": now', instructions: "Body" });
        expect(md).toBe('---\nname: x\ndescription: "say \\"hi\\": now"\n---\n\nBody\n');
    });
});

describe("what a chat loads", () => {
    beforeEach(() => {
        rows.length = 0;
    });

    it("loads switched-on built-ins and Enigma skills with edits applied, the person's over the instance's", async () => {
        const builtin = SKILL_CATALOG[0]!;
        const enigma = { name: "security-policy", ...UP };
        rows.push(
            row("u1", `builtin:${builtin.id}`, {
                enabled: true,
                instructions: "my built-in",
                description: builtin.description,
                baseDescription: builtin.description,
                baseInstructions: builtin.instructions
            }),
            row("instance", "enigma:security-policy", {
                instructions: "instance enigma",
                description: UP.description,
                baseDescription: UP.description,
                baseInstructions: UP.instructions
            }),
            // Somebody else's edit never reaches this person.
            row("u2", "enigma:security-policy", { instructions: "theirs", description: "theirs" })
        );
        const loaded = await effectiveUpstreamSkills("u1", [enigma]);
        expect(loaded.builtins).toEqual([
            { name: builtin.name, description: builtin.description, instructions: "my built-in" }
        ]);
        expect(loaded.enigma).toEqual([{ name: "security-policy", description: UP.description, instructions: "instance enigma" }]);

        rows.push(
            row("u1", "enigma:security-policy", {
                instructions: "mine",
                description: UP.description,
                baseDescription: UP.description,
                baseInstructions: "instance enigma"
            })
        );
        expect((await effectiveUpstreamSkills("u1", [enigma])).enigma[0]!.instructions).toBe("mine");
    });

    it("leaves built-ins nobody switched on out, and Enigma untouched without edits", async () => {
        const enigma = { name: "security-policy", ...UP };
        const loaded = await effectiveUpstreamSkills("u1", [enigma]);
        expect(loaded.builtins).toEqual([]);
        expect(loaded.enigma).toEqual([enigma]);
    });
});
