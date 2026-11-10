/**
 * Polar skills: what one is, as the settings editor and the server both check
 * it. One schema, read by the form on every keystroke and by every server
 * action and the chat route before anything is stored or sent to a model.
 *
 * A skill is a name the model calls it by, a description of when it applies,
 * and instructions in Markdown that the model reads only once it decides the
 * skill applies. Client-safe.
 */

import { z } from "zod";

/** Kebab-case, as a tool argument reads it. */
export const SKILL_NAME_MAX = 64;
export const SKILL_DESCRIPTION_MAX = 1024;
export const SKILL_INSTRUCTIONS_MAX = 20_000;
/** More skills than one person keeps; bounds every list and every prompt. */
export const SKILL_LIMIT = 50;

const NAME = /^[a-z0-9]+(?:-[a-z0-9]+)*$/;

/** A name as somebody typed it: trimmed, lowercase, spaces and underscores as hyphens. */
export function normalizeSkillName(raw: string): string {
    return raw
        .trim()
        .toLowerCase()
        .replace(/[\s_]+/g, "-")
        .replace(/-{2,}/g, "-");
}

export const skillFieldSchemas = {
    name: z
        .string()
        .transform(normalizeSkillName)
        .pipe(z.string().min(1).max(SKILL_NAME_MAX).regex(NAME, "name_format")),
    description: z.string().trim().min(1).max(SKILL_DESCRIPTION_MAX),
    instructions: z.string().trim().min(1).max(SKILL_INSTRUCTIONS_MAX)
};

export const skillInputSchema = z.object(skillFieldSchemas);
export type SkillInput = z.infer<typeof skillInputSchema>;
export type SkillField = keyof typeof skillFieldSchemas;

/**
 * What a field's value is missing, as a code the form has words for: null when
 * it is fine or simply not filled in yet (incomplete is not invalid).
 */
export function skillFieldError(field: SkillField, value: string): "name_format" | "too_long" | null {
    if (!value.trim()) return null;
    const checked = skillFieldSchemas[field].safeParse(value);
    if (checked.success) return null;
    const issue = checked.error.issues[0];
    if (issue?.code === "too_big") return "too_long";
    if (issue?.message === "name_format") return "name_format";
    return null;
}

/**
 * The skill a temporary chat is trying out: a catalog entry by id, or a draft
 * from the editor that was never saved. The draft is held to the same schema
 * as one being saved; the server reads it again on every turn.
 */
export const trialSkillSchema = z.union([
    z.object({ catalog: z.string().trim().min(1).max(64) }).strict(),
    z.object({ draft: skillInputSchema }).strict()
]);
export type TrialSkill = z.infer<typeof trialSkillSchema>;

/** A skill as the settings screen shows it. */
export interface SkillView {
    id: string;
    name: string;
    description: string;
    instructions: string;
    enabled: boolean;
    /** The catalog id it was added from, or "custom". */
    source: string;
}

/** Where a draft waits between the editor and the chat that tries it. */
export const TRIAL_SKILL_KEY = "polar.trialSkill";
