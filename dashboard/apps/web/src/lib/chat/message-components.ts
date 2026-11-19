/**
 * Buttons and forms under a message Polar or an app wrote - the components a
 * Discord bot puts under its messages.
 *
 * Four kinds, at most five on a message, modelled on Discord's message
 * components (discord.com/developers/docs/components/reference):
 *
 * - **link**: goes somewhere in Polaris - Discord's Link button style. Only a
 *   path on this dashboard, never an address elsewhere: a button in a
 *   conversation is trusted the way the conversation is, and that trust must
 *   not carry a reader off-site.
 * - **button**: runs an action on the server (`component-actions`), drawn in
 *   one of Discord's styles: primary, secondary, success or danger.
 * - **form**: opens a small form, and its answers run an action.
 * - **select**: a menu of up to 25 options, one or several picked (`min` to
 *   `max`), and the picked values run an action.
 *
 * Any of them can be `disabled` (drawn, never pressed) and carry an `icon`
 * from a short fixed list.
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

/** The icons a component may carry: names, drawn by the screen, never markup. */
export const COMPONENT_ICONS = [
    "check",
    "x",
    "plus",
    "refresh",
    "pencil",
    "trash",
    "info",
    "alert",
    "link",
    "settings"
] as const;
export type ComponentIcon = (typeof COMPONENT_ICONS)[number];
/** An icon a newer version named and this one does not know is left off, not the button. */
const icon = z.enum(COMPONENT_ICONS).optional().catch(undefined);
const disabled = z.boolean().optional().catch(undefined);

/** Discord's button styles; Link is the `link` component. */
export const BUTTON_STYLES = ["primary", "secondary", "success", "danger"] as const;
export type ButtonStyle = (typeof BUTTON_STYLES)[number];

/** One option of a select menu: Discord's label, value, description and default. */
export const selectOptionSchema = z.object({
    value: z.string().trim().min(1).max(100),
    label,
    description: z.string().trim().max(100).optional(),
    default: z.boolean().optional()
});

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
    z.object({ type: z.literal("link"), label, href: internalPath, icon, disabled }),
    z.object({
        type: z.literal("button"),
        label,
        // A style a newer version added reads as the plain one rather than
        // dropping the button.
        style: z.enum(BUTTON_STYLES).default("secondary").catch("secondary"),
        action: actionName,
        value: z.string().max(200).optional(),
        for: owner,
        icon,
        disabled
    }),
    z.object({
        type: z.literal("form"),
        label,
        style: z.enum(BUTTON_STYLES).default("primary").catch("primary"),
        action: actionName,
        title: label,
        submit: label,
        fields: z.array(formFieldSchema).min(1).max(MOST_FIELDS),
        for: owner,
        icon,
        disabled
    }),
    z.object({
        type: z.literal("select"),
        /** What the closed menu says before anything is picked. */
        placeholder: z.string().trim().max(150).optional(),
        action: actionName,
        options: z.array(selectOptionSchema).min(1).max(MOST_CHOICES),
        /** How many may be picked: 1 and 1 is a single choice. */
        min: z.number().int().min(0).max(MOST_CHOICES).default(1),
        max: z.number().int().min(1).max(MOST_CHOICES).default(1),
        for: owner,
        disabled
    })
]);

/** What a well-formed select also needs, which the shape alone cannot say. */
function selectProblem(component: MessageComponent): string | null {
    if (component.type !== "select") return null;
    if (component.min > component.max) return "min is above max";
    if (component.max > component.options.length) return "max is above the options";
    if (new Set(component.options.map((option) => option.value)).size !== component.options.length) {
        return "two options share a value";
    }
    return null;
}

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
        if (parsed.success && !selectProblem(parsed.data)) out.push(parsed.data);
    }
    return out;
}

/** Components as they are stored: checked on the way in, so a bad one fails where it was written. */
export function storedComponents(components: readonly MessageComponentInput[]): MessageComponent[] {
    const stored = z.array(messageComponentSchema).max(MOST_COMPONENTS).parse(components);
    for (const component of stored) {
        const problem = selectProblem(component);
        if (problem) throw new Error(`A select menu is not well formed: ${problem}`);
    }
    return stored;
}

/** The values picked in a select, checked against the select as it was stored. */
export function selectValuesSchema(select: Extract<MessageComponent, { type: "select" }>) {
    const offered = new Set(select.options.map((option) => option.value));
    return z
        .array(z.string().max(100))
        .min(select.min)
        .max(select.max)
        .refine((values) => new Set(values).size === values.length, "picked twice")
        .refine((values) => values.every((value) => offered.has(value)), "not offered");
}

/**
 * The design system's button variant for a component - Discord's colours in
 * this dashboard's tokens: blurple is primary, grey secondary, red danger,
 * green success (the success tokens, as a class, since `Button` has no green
 * variant of its own), and a link grey, as Discord draws it.
 */
export function componentLook(component: MessageComponent): {
    variant: "primary" | "secondary" | "danger";
    className?: string;
} {
    if (component.type === "link") return { variant: "secondary" };
    if (component.type === "select") return { variant: "secondary" };
    switch (component.style) {
        case "primary":
            return { variant: "primary" };
        case "danger":
            return { variant: "danger" };
        case "success":
            return {
                variant: "primary",
                className:
                    "border-white/10 bg-success text-success-foreground hover:bg-success/90 active:bg-success/80"
            };
        default:
            return { variant: "secondary" };
    }
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
