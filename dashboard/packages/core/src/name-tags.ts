/**
 * Name tags: a short label an organization (or the instance itself) defines,
 * which a member may choose to wear right after their name.
 *
 * The text is normalized one way everywhere: trimmed and uppercased, so "acme"
 * and " Acme " are the same tag and two organizations cannot tell readers apart
 * by case alone. It is one to four letters or digits.
 *
 * Words that read as the instance's own staff - STAFF, ADMIN, MOD and their
 * short forms, and the instance's name - are refused unless the instance
 * administrators set them, so an organization cannot dress its members up as
 * the people who run the place.
 *
 * Pure, so the screens validate with exactly what the server enforces.
 */

import { z } from "zod";

/** The drawn emblems a tag can carry. Drawn by the dashboard; named here. */
export const NAME_TAG_EMBLEMS = [
    "spark",
    "shield",
    "bolt",
    "leaf",
    "flame",
    "gem",
    "wave",
    "orbit"
] as const;
export type NameTagEmblem = (typeof NAME_TAG_EMBLEMS)[number];

/** The organization's own avatar instead of a drawn emblem. Organizations only. */
export const NAME_TAG_AVATAR = "avatar";

/** The colors an emblem may be drawn in. */
export const NAME_TAG_COLORS = [
    "slate",
    "red",
    "amber",
    "green",
    "teal",
    "blue",
    "violet",
    "pink"
] as const;
export type NameTagColor = (typeof NAME_TAG_COLORS)[number];

/** What this instance is called, whose short forms are reserved. */
export const NAME_TAG_INSTANCE_NAME = "Polaris";

export const NAME_TAG_MAX = 4;

/**
 * Refused for anybody but the instance administrators. Every entry is already
 * normalized, and at most four characters - a longer word could not be typed.
 */
export const RESERVED_NAME_TAGS: readonly string[] = [
    "ADM",
    "ADMN",
    "ADMI",
    "STAF",
    "STF",
    "MOD",
    "MODS",
    "ROOT",
    "SYS",
    "OPS",
    "OWNR",
    "SUPP",
    "HELP",
    "OFFI",
    "OFCL"
];

/** The one form a tag's text is stored and compared in. */
export function normalizeNameTagText(value: string): string {
    return value.trim().toUpperCase();
}

/** The instance's name as tags it would collide with: the whole name when it
 *  fits, and its first three and four characters. */
function instanceForms(instanceName: string): string[] {
    const compact = normalizeNameTagText(instanceName).replace(/[^\p{L}\p{N}]/gu, "");
    if (compact === "") return [];
    return [...new Set([compact, compact.slice(0, 4), compact.slice(0, 3)])].filter(
        (form) => form.length <= NAME_TAG_MAX
    );
}

/** Whether this text reads as the instance's staff or the instance itself. */
export function isReservedNameTag(text: string, instanceName: string): boolean {
    const normalized = normalizeNameTagText(text);
    return (
        RESERVED_NAME_TAGS.includes(normalized) || instanceForms(instanceName).includes(normalized)
    );
}

/** The text alone: normalized first, then checked, so a check cannot pass on a
 *  value that was patched into shape. */
export const nameTagTextSchema = z.preprocess(
    (value) => (typeof value === "string" ? normalizeNameTagText(value) : value),
    z
        .string()
        .min(1, "required")
        .max(NAME_TAG_MAX, "tooLong")
        .regex(/^[\p{L}\p{N}]+$/u, "characters")
);

export interface NameTagContext {
    /** What this instance is called, whose forms are reserved. */
    instanceName: string;
    /** The instance administrators, who may use any word - and the instance's
     *  own tag, which is theirs. */
    staff: boolean;
    /** Whether the organization's avatar may stand in for an emblem. */
    allowAvatar: boolean;
}

/**
 * A tag definition as one form submits it. One schema, built for who is
 * submitting it, on both the screen and the server.
 */
export function nameTagDefinitionSchema(context: NameTagContext) {
    const emblems: readonly string[] = context.allowAvatar
        ? [...NAME_TAG_EMBLEMS, NAME_TAG_AVATAR]
        : NAME_TAG_EMBLEMS;
    return z
        .object({
            enabled: z.boolean(),
            text: nameTagTextSchema,
            emblem: z.string().refine((value) => emblems.includes(value), "emblem"),
            color: z.enum(NAME_TAG_COLORS)
        })
        .superRefine((value, ctx) => {
            if (!context.staff && isReservedNameTag(value.text, context.instanceName))
                ctx.addIssue({ code: "custom", path: ["text"], message: "reserved" });
        });
}
export type NameTagDefinition = z.infer<ReturnType<typeof nameTagDefinitionSchema>>;

/** Which tag a member wears: an organization's, the instance's, or none. */
export const nameTagChoiceSchema = z.discriminatedUnion("source", [
    z.object({ source: z.literal("none") }),
    z.object({ source: z.literal("instance") }),
    z.object({ source: z.literal("org"), orgId: z.string().uuid() })
]);
export type NameTagChoice = z.infer<typeof nameTagChoiceSchema>;

/** The ids a batched tag lookup accepts at once. */
export const NAME_TAG_LOOKUP_MAX = 200;

export const nameTagLookupSchema = z.object({
    ids: z.array(z.string().uuid()).max(NAME_TAG_LOOKUP_MAX)
});

/** A tag as a viewer is shown it. */
export interface NameTagView {
    text: string;
    emblem: string;
    color: NameTagColor;
    /** Null for the instance's own tag. */
    orgId: string | null;
    /** The organization's avatar, when the emblem is it. */
    image: string | null;
}
