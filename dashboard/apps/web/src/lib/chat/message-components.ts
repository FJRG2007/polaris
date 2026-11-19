/**
 * Buttons and forms under a message Polar or an app wrote - the components a
 * Discord bot puts under its messages.
 *
 * Three kinds, at most five on a message:
 *
 * - **link**: goes somewhere in Polaris. Only a path on this dashboard, never
 *   an address elsewhere: a button in a conversation is trusted the way the
 *   conversation is, and that trust must not carry a reader off-site.
 * - **button**: runs an action on the server (`component-actions`).
 * - **form**: opens a small form, and its answers run an action.
 *
 * What a press runs is read from the stored message, never from the request:
 * the browser names which component (by position) and fills a form's fields,
 * and nothing else. `for` keeps a component to one person - the one who asked -
 * and everybody else sees it disabled.
 *
 * Shared by the server and the screen; nothing here reaches the database.
 */

import { z } from "zod";

/** The most components on one message. */
export const MOST_COMPONENTS = 5;
/** The most fields on one form, and the most choices in one field. */
export const MOST_FIELDS = 5;
export const MOST_CHOICES = 25;

const label = z.string().trim().min(1).max(80);
/** A path on this dashboard: one leading slash, and not two (`//host` leaves it). */
const internalPath = z
    .string()
    .trim()
    .max(500)
    .regex(/^\/(?![/\\])[^\s]*$/);
/** `<owner>.<name>`: the action registry's key. */
const actionName = z
    .string()
    .regex(/^[a-z][a-z0-9-]*\.[a-z][a-z0-9-]*$/)
    .max(64);
/** Who may press it: an account id. */
const owner = z.string().min(1).max(64).optional();

const choiceSchema = z.object({ value: z.string().trim().min(1).max(100), label });

export const formFieldSchema = z.object({
    name: z.string().regex(/^[a-z][a-zA-Z0-9]{0,31}$/),
    label,
    kind: z.enum(["text", "long", "choice"]),
    required: z.boolean().default(false),
    max: z.number().int().min(1).max(4000).default(200),
    placeholder: z.string().trim().max(120).optional(),
    /** What the field starts with: what the command was given, say. */
    value: z.string().max(4000).optional(),
    options: z.array(choiceSchema).max(MOST_CHOICES).optional()
});

export const messageComponentSchema = z.discriminatedUnion("type", [
    z.object({ type: z.literal("link"), label, href: internalPath }),
    z.object({
        type: z.literal("button"),
        label,
        style: z.enum(["primary", "secondary", "danger"]).default("secondary"),
        action: actionName,
        value: z.string().max(200).optional(),
        for: owner
    }),
    z.object({
        type: z.literal("form"),
        label,
        style: z.enum(["primary", "secondary"]).default("primary"),
        action: actionName,
        title: label,
        submit: label,
        fields: z.array(formFieldSchema).min(1).max(MOST_FIELDS),
        for: owner
    })
]);

export type MessageComponent = z.infer<typeof messageComponentSchema>;
export type FormField = z.infer<typeof formFieldSchema>;
/** What a caller writes: the defaults filled in on the way in. */
export type MessageComponentInput = z.input<typeof messageComponentSchema>;

/**
 * The components a stored value holds. Read total: a row a newer version
 * wrote, or one that no longer parses, gives its readable components and
 * drops the rest rather than failing the conversation.
 */
export function readComponents(raw: unknown): MessageComponent[] {
    if (!Array.isArray(raw)) return [];
    const out: MessageComponent[] = [];
    for (const one of raw.slice(0, MOST_COMPONENTS)) {
        const parsed = messageComponentSchema.safeParse(one);
        if (parsed.success) out.push(parsed.data);
    }
    return out;
}

/** Components as they are stored: checked on the way in, so a bad one fails where it was written. */
export function storedComponents(components: readonly MessageComponentInput[]): MessageComponent[] {
    return z.array(messageComponentSchema).max(MOST_COMPONENTS).parse(components);
}

/** A form's answers, checked against the form as it was stored. */
export function formAnswersSchema(fields: readonly FormField[]) {
    return z.object(
        Object.fromEntries(
            fields.map((field) => {
                let text = z.string().trim().max(field.max);
                if (field.required) text = text.min(1);
                const options = field.options ?? [];
                const checked =
                    field.kind === "choice"
                        ? text.refine((value) => value === "" || options.some((option) => option.value === value))
                        : text;
                return [field.name, field.required ? checked : checked.default("")];
            })
        )
    );
}
