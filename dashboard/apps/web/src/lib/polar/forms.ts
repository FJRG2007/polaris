/**
 * Forms Polar draws inside an answer (`polar_form`): only fields from a closed
 * set, each with its own schema, so a model can never hand the page markup or
 * script. What the person submits goes back as their next message, carrying
 * the call it answers and the values (`metadata.form`); the server checks the
 * values against the form the model drew and writes the message's text from
 * them itself (`checkFormReply`), so what the model reads is what was valid.
 *
 * Client-safe: no database, no provider.
 */

import { z } from "zod";

export const POLAR_FORM_TOOL = "polar_form";
export const FORM_FIELDS_MAX = 12;
export const FORM_TEXT_MAX = 500;
export const FORM_TEXTAREA_MAX = 4000;

const DATE = /^\d{4}-\d{2}-\d{2}$/;

/** A YYYY-MM-DD that is a real calendar day. */
export function isDay(value: string): boolean {
    if (!DATE.test(value)) return false;
    const day = new Date(`${value}T00:00:00Z`);
    return !Number.isNaN(day.getTime()) && day.toISOString().slice(0, 10) === value;
}

const base = {
    id: z.string().regex(/^[A-Za-z][\w-]{0,39}$/),
    label: z.string().trim().min(1).max(120),
    hint: z.string().max(200).optional(),
    required: z.boolean().optional()
};

export const formFieldSchema = z.discriminatedUnion("type", [
    z.object({ ...base, type: z.literal("text"), placeholder: z.string().max(120).optional() }),
    z.object({ ...base, type: z.literal("textarea"), placeholder: z.string().max(120).optional() }),
    z.object({
        ...base,
        type: z.literal("choice"),
        options: z.array(z.string().trim().min(1).max(100)).min(2).max(12),
        multiple: z.boolean().optional()
    }),
    z.object({ ...base, type: z.literal("rating"), max: z.number().int().min(3).max(10).optional() }),
    z.object({
        ...base,
        type: z.literal("number"),
        min: z.number().finite().optional(),
        max: z.number().finite().optional(),
        step: z.number().positive().finite().optional()
    }),
    z.object({
        ...base,
        type: z.literal("date"),
        min: z.string().refine(isDay).optional(),
        max: z.string().refine(isDay).optional()
    })
]);
export type FormField = z.infer<typeof formFieldSchema>;

export const polarFormSchema = z
    .object({
        title: z.string().trim().max(120).optional(),
        description: z.string().max(500).optional(),
        fields: z.array(formFieldSchema).min(1).max(FORM_FIELDS_MAX),
        submitLabel: z.string().trim().max(40).optional()
    })
    .superRefine((form, context) => {
        const ids = new Set<string>();
        form.fields.forEach((field, index) => {
            if (ids.has(field.id)) context.addIssue({ code: "custom", path: ["fields", index, "id"], message: "duplicate id" });
            ids.add(field.id);
            if (field.type === "choice" && new Set(field.options).size !== field.options.length)
                context.addIssue({ code: "custom", path: ["fields", index, "options"], message: "duplicate option" });
            if ((field.type === "number" || field.type === "date") && field.min !== undefined && field.max !== undefined && field.min > field.max)
                context.addIssue({ code: "custom", path: ["fields", index], message: "min above max" });
        });
    });
export type PolarForm = z.infer<typeof polarFormSchema>;

export type FormValue = string | number | string[];
export type FormValues = Record<string, FormValue>;

/** Starred fields count from 1 to this. */
export function ratingMax(field: Extract<FormField, { type: "rating" }>): number {
    return field.max ?? 5;
}

/** One field's value schema; an optional field also takes nothing. */
function valueSchema(field: FormField): z.ZodType<FormValue | undefined> {
    const one = (() => {
        switch (field.type) {
            case "text":
                return z.string().trim().min(1).max(FORM_TEXT_MAX);
            case "textarea":
                return z.string().trim().min(1).max(FORM_TEXTAREA_MAX);
            case "choice":
                return field.multiple
                    ? z
                          .array(z.enum(field.options as [string, ...string[]]))
                          .min(1)
                          .max(field.options.length)
                          .refine((list) => new Set(list).size === list.length)
                    : z.enum(field.options as [string, ...string[]]);
            case "rating":
                return z.number().int().min(1).max(ratingMax(field));
            case "number": {
                let number = z.number().finite();
                if (field.min !== undefined) number = number.min(field.min);
                if (field.max !== undefined) number = number.max(field.max);
                return number;
            }
            case "date":
                return z
                    .string()
                    .refine(isDay)
                    .refine((day) => (field.min === undefined || day >= field.min) && (field.max === undefined || day <= field.max));
        }
    })() as z.ZodType<FormValue>;
    return field.required ? one : one.optional();
}

/** Trims text and drops what was left empty, before the values are checked. */
export function normalizeFormValues(values: Record<string, unknown>): Record<string, unknown> {
    const out: Record<string, unknown> = {};
    for (const [key, value] of Object.entries(values)) {
        const next = typeof value === "string" ? value.trim() : value;
        if (next === "" || next === null || next === undefined) continue;
        if (Array.isArray(next) && next.length === 0) continue;
        out[key] = next;
    }
    return out;
}

/** The schema a submission of this form must pass: only its own field ids. */
export function formValuesSchema(form: PolarForm): z.ZodType<FormValues> {
    return z.strictObject(Object.fromEntries(form.fields.map((field) => [field.id, valueSchema(field)]))) as never;
}

/** Normalized and checked values, or the ids of the fields that failed. */
export function checkFormValues(
    form: PolarForm,
    values: Record<string, unknown>
): { ok: true; values: FormValues } | { ok: false; fields: string[] } {
    const parsed = formValuesSchema(form).safeParse(normalizeFormValues(values));
    if (parsed.success) return { ok: true, values: parsed.data };
    return { ok: false, fields: [...new Set(parsed.error.issues.map((issue) => String(issue.path[0] ?? "")))] };
}

/** The message the model reads: one `label: value` line per answered field. */
export function formReplyText(form: PolarForm, values: FormValues): string {
    const lines = form.fields.flatMap((field) => {
        const value = values[field.id];
        if (value === undefined) return [];
        const shown =
            field.type === "rating"
                ? `${value}/${ratingMax(field)}`
                : Array.isArray(value)
                  ? value.join(", ")
                  : String(value);
        return [`${field.label}: ${shown}`];
    });
    return [form.title ? `${form.title}` : "", ...lines].filter(Boolean).join("\n");
}

export const formReplySchema = z.object({
    callId: z.string().min(1).max(200),
    values: z.record(z.string().max(40), z.unknown())
});
export type FormReply = z.infer<typeof formReplySchema>;

interface PartLike {
    type: string;
    state?: string;
    toolCallId?: string;
    input?: unknown;
}

interface MessageLike {
    role: string;
    parts: readonly unknown[];
    metadata?: unknown;
}

export function isFormPart(part: { type?: unknown } | null | undefined): boolean {
    return part?.type === `tool-${POLAR_FORM_TOOL}`;
}

/** A call's form, or null when the model drew something outside the set. */
export function formOf(input: unknown): PolarForm | null {
    const parsed = polarFormSchema.safeParse(input);
    return parsed.success ? parsed.data : null;
}

/** The reply a message carries, or null. */
export function formReplyOf(message: Pick<MessageLike, "role" | "metadata">): FormReply | null {
    if (message.role !== "user") return null;
    const meta = message.metadata as { form?: unknown } | null | undefined;
    if (!meta || typeof meta !== "object") return null;
    const parsed = formReplySchema.safeParse(meta.form);
    return parsed.success ? parsed.data : null;
}

/** The values each answered form was sent with, by call id. */
export function formRepliesIn(messages: readonly MessageLike[]): Map<string, FormValues> {
    const replies = new Map<string, FormValues>();
    for (const message of messages) {
        const reply = formReplyOf(message);
        if (reply) replies.set(reply.callId, reply.values as FormValues);
    }
    return replies;
}

/**
 * The newest message checked when it answers a form: the form must be one the
 * model drew earlier in this conversation and not yet answered, and the values
 * must pass its schema. The message's parts become the text written from the
 * checked values. Any other message passes through untouched.
 */
export function checkFormReply<T extends MessageLike>(messages: readonly T[]): T[] | null {
    const last = messages.at(-1);
    if (!last) return [...messages];
    const raw = (last.metadata as { form?: unknown } | null | undefined)?.form;
    if (last.role !== "user" || raw === undefined) return [...messages];
    const reply = formReplyOf(last);
    if (!reply) return null;
    const earlier = messages.slice(0, -1);
    if (earlier.some((message) => formReplyOf(message)?.callId === reply.callId)) return null;
    let form: PolarForm | null = null;
    for (const message of earlier) {
        if (message.role !== "assistant") continue;
        for (const part of message.parts as readonly PartLike[]) {
            if (isFormPart(part) && part.toolCallId === reply.callId && part.state === "output-available") form = formOf(part.input);
        }
    }
    if (!form) return null;
    const checked = checkFormValues(form, reply.values);
    if (!checked.ok) return null;
    const metadata = { ...(last.metadata as object), form: { callId: reply.callId, values: checked.values } };
    return [...earlier, { ...last, metadata, parts: [{ type: "text", text: formReplyText(form, checked.values) }] }];
}
