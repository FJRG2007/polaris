/**
 * The shape a payload is expected to have, as data: saved with whatever
 * receives payloads (a webhook trigger, a form, an alert topic), validated and
 * bounded by its own schema, and compiled to a zod schema when a payload
 * arrives. "Any" accepts whatever JSON comes; a structured shape is strict by
 * default, so an unknown key is refused rather than carried along.
 *
 * Patterns are user-written regular expressions run against untrusted input,
 * so a pattern that can backtrack catastrophically (a quantified group that is
 * itself quantified, or a backreference) is refused when the shape is saved.
 */

import { z } from "zod";

export const PAYLOAD_FIELD_TYPES = [
    "string",
    "number",
    "integer",
    "boolean",
    "enum",
    "array",
    "object",
    "null"
] as const;

export type PayloadFieldType = (typeof PAYLOAD_FIELD_TYPES)[number];

export const PAYLOAD_SHAPE_LIMITS = {
    depth: 6,
    fields: 200,
    patternLength: 200,
    enumValues: 50,
    nameLength: 64
} as const;

/** One value's rules. `fields` is for an object, `items` for an array. */
export interface PayloadField {
    name: string;
    type: PayloadFieldType;
    required: boolean;
    nullable: boolean;
    minLength?: number;
    maxLength?: number;
    pattern?: string;
    min?: number;
    max?: number;
    values?: string[];
    items?: PayloadField;
    fields?: PayloadField[];
    /** For an object: refuse keys it does not name. */
    strict?: boolean;
}

export type PayloadShape =
    | { kind: "any" }
    | { kind: "structured"; root: PayloadField; maxBytes?: number };

/**
 * Whether a pattern is safe to run on untrusted text: it compiles, is short,
 * has no backreference, and no quantified group containing a quantifier - the
 * shape behind every catastrophic-backtracking expression.
 */
export function safePattern(pattern: string): boolean {
    if (pattern.length > PAYLOAD_SHAPE_LIMITS.patternLength) return false;
    try {
        new RegExp(pattern);
    } catch {
        return false;
    }
    if (/\\[1-9]|\\k</.test(pattern)) return false;
    const stack: boolean[] = [];
    let quantifiedInside = false;
    for (let at = 0; at < pattern.length; at++) {
        const char = pattern[at];
        if (char === "\\") {
            at++;
            continue;
        }
        if (char === "[") {
            const close = pattern.indexOf("]", at + 1);
            if (close < 0) return false;
            at = close;
            continue;
        }
        if (char === "(") {
            stack.push(quantifiedInside);
            quantifiedInside = false;
            continue;
        }
        const quantifier = char === "*" || char === "+" || char === "{" || char === "?";
        if (char === ")") {
            const inner = quantifiedInside;
            quantifiedInside = stack.pop() ?? false;
            const next = pattern[at + 1];
            const quantified = next === "*" || next === "+" || next === "{";
            if (quantified && inner) return false;
            if (inner) quantifiedInside = true;
            continue;
        }
        if (quantifier && char !== "?") quantifiedInside = true;
    }
    return true;
}

const fieldName = z.string().trim().min(1).max(PAYLOAD_SHAPE_LIMITS.nameLength);
const bound = z.number().int().min(0).max(1_000_000).optional();
const limit = z.number().finite().optional();

export const payloadFieldSchema: z.ZodType<PayloadField> = z.lazy(() =>
    z
        .object({
            name: z.union([fieldName, z.literal("")]),
            type: z.enum(PAYLOAD_FIELD_TYPES),
            required: z.boolean().default(true),
            nullable: z.boolean().default(false),
            minLength: bound,
            maxLength: bound,
            pattern: z
                .string()
                .max(PAYLOAD_SHAPE_LIMITS.patternLength)
                .refine((value) => value === "" || safePattern(value), {
                    message: "unsafe pattern"
                })
                .optional(),
            min: limit,
            max: limit,
            values: z.array(z.string().max(200)).min(1).max(PAYLOAD_SHAPE_LIMITS.enumValues).optional(),
            items: payloadFieldSchema.optional(),
            fields: z.array(payloadFieldSchema).max(PAYLOAD_SHAPE_LIMITS.fields).optional(),
            strict: z.boolean().optional()
        })
        .strict()
        .superRefine((field, context) => {
            if (field.type === "enum" && !field.values?.length)
                context.addIssue({ code: "custom", path: ["values"], message: "values required" });
            if (field.type === "object" && field.fields) {
                const names = field.fields.map((entry) => entry.name);
                if (names.some((name) => name === "") || new Set(names).size !== names.length)
                    context.addIssue({ code: "custom", path: ["fields"], message: "names" });
            }
            if (field.minLength !== undefined && field.maxLength !== undefined && field.minLength > field.maxLength)
                context.addIssue({ code: "custom", path: ["maxLength"], message: "range" });
            if (field.min !== undefined && field.max !== undefined && field.min > field.max)
                context.addIssue({ code: "custom", path: ["max"], message: "range" });
        })
) as z.ZodType<PayloadField>;

function measure(field: PayloadField, depth: number): { depth: number; fields: number } {
    let deepest = depth;
    let count = 1;
    for (const child of [...(field.fields ?? []), ...(field.items ? [field.items] : [])]) {
        const inner = measure(child, depth + 1);
        deepest = Math.max(deepest, inner.depth);
        count += inner.fields;
    }
    return { depth: deepest, fields: count };
}

export const payloadShapeSchema = z
    .discriminatedUnion("kind", [
        z.object({ kind: z.literal("any") }),
        z.object({
            kind: z.literal("structured"),
            root: payloadFieldSchema,
            maxBytes: z.number().int().min(1).max(4 * 1024 * 1024).optional()
        })
    ])
    .superRefine((shape, context) => {
        if (shape.kind !== "structured") return;
        const size = measure(shape.root, 1);
        if (size.depth > PAYLOAD_SHAPE_LIMITS.depth)
            context.addIssue({ code: "custom", path: ["root"], message: "too deep" });
        if (size.fields > PAYLOAD_SHAPE_LIMITS.fields)
            context.addIssue({ code: "custom", path: ["root"], message: "too many fields" });
    }) as z.ZodType<PayloadShape>;

export const ANY_PAYLOAD: PayloadShape = { kind: "any" };

/** An empty structured shape: an object with no fields, strict. */
export function emptyStructuredShape(): PayloadShape {
    return { kind: "structured", root: { name: "", type: "object", required: true, nullable: false, strict: true, fields: [] } };
}

function compileField(field: PayloadField): z.ZodTypeAny {
    let schema: z.ZodTypeAny;
    switch (field.type) {
        case "string": {
            let text = z.string();
            if (field.minLength !== undefined) text = text.min(field.minLength);
            if (field.maxLength !== undefined) text = text.max(field.maxLength);
            if (field.pattern) text = text.regex(new RegExp(field.pattern));
            schema = text;
            break;
        }
        case "number":
        case "integer": {
            let number = field.type === "integer" ? z.number().int() : z.number();
            if (field.min !== undefined) number = number.min(field.min);
            if (field.max !== undefined) number = number.max(field.max);
            schema = number;
            break;
        }
        case "boolean":
            schema = z.boolean();
            break;
        case "enum":
            schema = z.enum((field.values?.length ? field.values : [""]) as [string, ...string[]]);
            break;
        case "null":
            schema = z.null();
            break;
        case "array": {
            let list = z.array(field.items ? compileField(field.items) : z.unknown());
            if (field.minLength !== undefined) list = list.min(field.minLength);
            if (field.maxLength !== undefined) list = list.max(field.maxLength);
            schema = list;
            break;
        }
        case "object": {
            const shape: Record<string, z.ZodTypeAny> = {};
            for (const child of field.fields ?? []) {
                const compiled = compileField(child);
                shape[child.name] = child.required ? compiled : compiled.optional();
            }
            const object = z.object(shape);
            schema = field.strict === false ? object.passthrough() : object.strict();
            break;
        }
    }
    return field.nullable ? schema.nullable() : schema;
}

/** The zod schema a stored shape describes. "Any" accepts any value. */
export function compileShape(shape: PayloadShape): z.ZodTypeAny {
    return shape.kind === "any" ? z.unknown() : compileField(shape.root);
}

/** Check a value against a shape; on failure, the path of the first field that failed. */
export function checkPayload(
    shape: PayloadShape,
    value: unknown
): { ok: true; value: unknown } | { ok: false; path: string } {
    if (shape.kind === "structured" && shape.maxBytes !== undefined) {
        const size = new TextEncoder().encode(JSON.stringify(value) ?? "").length;
        if (size > shape.maxBytes) return { ok: false, path: "(size)" };
    }
    const parsed = compileShape(shape).safeParse(value);
    if (parsed.success) return { ok: true, value: parsed.data };
    const path = parsed.error.issues[0]?.path.join(".") ?? "";
    return { ok: false, path: path || "(root)" };
}

function inferField(name: string, value: unknown, depth: number): PayloadField {
    const base = { name, required: true, nullable: false };
    if (value === null) return { ...base, type: "null" };
    if (typeof value === "boolean") return { ...base, type: "boolean" };
    if (typeof value === "number") return { ...base, type: Number.isInteger(value) ? "integer" : "number" };
    if (typeof value === "string") return { ...base, type: "string" };
    if (Array.isArray(value))
        return {
            ...base,
            type: "array",
            ...(value.length > 0 && depth < PAYLOAD_SHAPE_LIMITS.depth ? { items: inferField("", value[0], depth + 1) } : {})
        };
    if (typeof value === "object" && depth < PAYLOAD_SHAPE_LIMITS.depth) {
        const fields = Object.entries(value as Record<string, unknown>)
            .slice(0, 50)
            .filter(([key]) => key.length > 0 && key.length <= PAYLOAD_SHAPE_LIMITS.nameLength)
            .map(([key, inner]) => inferField(key, inner, depth + 1));
        return { ...base, type: "object", strict: true, fields };
    }
    return { ...base, type: "object", strict: false, fields: [] };
}

/** A strict shape that the sample matches, for "Use this request as the shape". */
export function inferShape(sample: unknown): PayloadShape {
    return { kind: "structured", root: inferField("", sample, 1) };
}

function sampleField(field: PayloadField): unknown {
    switch (field.type) {
        case "string":
            return "x".repeat(Math.max(field.minLength ?? 1, 1)).slice(0, field.maxLength ?? 64);
        case "number":
        case "integer":
            return field.min ?? (field.max !== undefined && field.max < 0 ? field.max : 0);
        case "boolean":
            return true;
        case "enum":
            return field.values?.[0] ?? "";
        case "null":
            return null;
        case "array":
            return field.items && (field.minLength ?? 0) > 0
                ? Array.from({ length: field.minLength ?? 0 }, () => sampleField(field.items as PayloadField))
                : [];
        case "object":
            return Object.fromEntries(
                (field.fields ?? []).filter((child) => child.required).map((child) => [child.name, sampleField(child)])
            );
    }
}

/** A value the shape accepts where it can say so (patterns aside), for a test request. */
export function sampleForShape(shape: PayloadShape): unknown {
    return shape.kind === "any" ? { test: true } : sampleField(shape.root);
}
