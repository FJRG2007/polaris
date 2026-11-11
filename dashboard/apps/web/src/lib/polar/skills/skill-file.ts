/**
 * Skills as files: the open `SKILL.md` format (YAML frontmatter with a `name`
 * and a `description`, the instructions as the Markdown under it) that Claude,
 * ChatGPT and the skills.sh directory share, and Polaris's own export of many
 * skills at once.
 *
 * Reading never trusts the file: whatever it says is put through the same
 * schema the editor uses, and a file that does not pass comes back with what is
 * wrong with it and the values it had, so the person can fix it before adding.
 *
 * Client-safe and pure.
 */

import { z } from "zod";
import { parse, stringify } from "yaml";
import { SKILL_NAME_MAX, skillInputSchema, type SkillInput } from "@/lib/polar/skills/shared";

/** What an import found, ready to add or to fix first. */
export interface SkillCandidate {
    /** The values the file gave, as far as it gave them. */
    readonly skill: SkillInput;
    /** Why it cannot be added as it is, or null when it can. */
    readonly problem: SkillProblem | null;
    /** Where it came from: a path in a repository, a file name, a directory id. */
    readonly origin: string;
}

export type SkillProblem = "invalid" | "too_long" | "duplicate";

/** The kind a Polaris skills export is marked with. */
export const SKILL_BUNDLE_KIND = "polaris.skills";

const bundleSchema = z.object({
    kind: z.literal(SKILL_BUNDLE_KIND),
    version: z.literal(1),
    skills: z
        .array(
            z.object({
                name: z.string().max(10_000),
                description: z.string().max(100_000),
                instructions: z.string().max(1_000_000)
            })
        )
        .max(200)
});

/**
 * A name in the one form a skill is called by: lowercase, every run of anything
 * but a letter or a digit as one hyphen. "Next.js Development" is
 * "next-js-development".
 */
export function skillSlug(raw: string): string {
    return raw
        .normalize("NFKD")
        .replace(/[̀-ͯ]/g, "")
        .toLowerCase()
        .replace(/[^a-z0-9]+/g, "-")
        .replace(/^-+|-+$/g, "")
        .slice(0, SKILL_NAME_MAX)
        .replace(/-+$/, "");
}

/** The frontmatter block and the body under it, or no frontmatter at all. */
function split(text: string): { head: string | null; body: string } {
    const normalized = text.replace(/^﻿/, "").replace(/\r\n?/g, "\n");
    if (!normalized.startsWith("---\n")) return { head: null, body: normalized };
    const end = normalized.indexOf("\n---", 3);
    if (end === -1) return { head: null, body: normalized };
    const after = normalized.indexOf("\n", end + 4);
    return {
        head: normalized.slice(4, end),
        body: after === -1 ? "" : normalized.slice(after + 1)
    };
}

function text(value: unknown): string {
    return typeof value === "string" ? value : "";
}

/** A candidate held to the editor's schema, with what fails named. */
export function candidate(skill: SkillInput, origin: string): SkillCandidate {
    const checked = skillInputSchema.safeParse(skill);
    if (checked.success) return { skill: checked.data, problem: null, origin };
    const tooLong = checked.error.issues.some((issue) => issue.code === "too_big");
    return { skill, problem: tooLong ? "too_long" : "invalid", origin };
}

/**
 * One `SKILL.md`. `fallbackName` names a file whose frontmatter does not, as
 * the folder or the directory entry it came from does.
 */
export function readSkillFile(
    source: string,
    fallbackName: string,
    origin: string
): SkillCandidate {
    const { head, body } = split(source);
    let fields: Record<string, unknown> = {};
    if (head !== null) {
        try {
            const parsed: unknown = parse(head, { maxAliasCount: 0 });
            if (parsed && typeof parsed === "object" && !Array.isArray(parsed))
                fields = parsed as Record<string, unknown>;
        } catch {
            fields = {};
        }
    }
    const name = skillSlug(text(fields.name) || fallbackName);
    const description = text(fields.description).replace(/\s+/g, " ").trim();
    return candidate({ name, description, instructions: body.trim() }, origin);
}

/** A Polaris export, or null when the text is not one. */
export function readSkillBundle(source: string, origin: string): SkillCandidate[] | null {
    let parsed: unknown;
    try {
        parsed = JSON.parse(source);
    } catch {
        return null;
    }
    const bundle = bundleSchema.safeParse(parsed);
    if (!bundle.success) return null;
    return bundle.data.skills.map((skill, index) =>
        candidate({ ...skill, name: skillSlug(skill.name) }, `${origin}#${index + 1}`)
    );
}

/** One skill as a `SKILL.md` any of those tools reads. */
export function skillFileOf(skill: SkillInput): string {
    const head = stringify(
        { name: skill.name, description: skill.description },
        { lineWidth: 0 }
    ).trimEnd();
    return `---\n${head}\n---\n\n${skill.instructions.trim()}\n`;
}

/** Many skills as one file Polaris reads back. */
export function skillBundleOf(skills: readonly SkillInput[]): string {
    return `${JSON.stringify(
        {
            kind: SKILL_BUNDLE_KIND,
            version: 1,
            skills: skills.map(({ name, description, instructions }) => ({
                name,
                description,
                instructions
            }))
        },
        null,
        2
    )}\n`;
}

/** Marks each candidate whose name is already taken, by the person or earlier in the list. */
export function markDuplicates(
    found: readonly SkillCandidate[],
    held: ReadonlySet<string>
): SkillCandidate[] {
    const seen = new Set(held);
    return found.map((entry) => {
        if (entry.problem) return entry;
        if (seen.has(entry.skill.name)) return { ...entry, problem: "duplicate" };
        seen.add(entry.skill.name);
        return entry;
    });
}
