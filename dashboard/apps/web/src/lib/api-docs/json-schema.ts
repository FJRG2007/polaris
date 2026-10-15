/**
 * Zod schemas -> JSON Schema (the 2020-12 dialect OpenAPI 3.1 uses), for the
 * API reference.
 *
 * Written here rather than taken from a package: the converter that is already
 * in the lockfile reads zod through `zod/v3`, which the zod this app pins does
 * not export, so it would silently resolve a different zod than the one the
 * routes were written with. The routes use a small, fixed set of zod types and
 * this covers exactly those; anything else throws, so a route that grows a type
 * this does not know fails the API reference test instead of being documented
 * as "anything".
 *
 * Schemas describe what a caller SENDS: a field with a default is optional,
 * and a transform or refinement documents the shape it was applied to.
 */

import type { ZodTypeAny } from "zod";

export type JsonSchema = { [key: string]: unknown };

interface Check {
    kind: string;
    value?: number;
    inclusive?: boolean;
    regex?: RegExp;
}

/** Whether a caller may leave this out of an object. */
export function isOptional(schema: ZodTypeAny): boolean {
    const name = schema._def.typeName as string;
    if (name === "ZodOptional" || name === "ZodDefault") return true;
    if (name === "ZodEffects") return isOptional(schema._def.schema);
    return false;
}

function withDescription(schema: ZodTypeAny, out: JsonSchema): JsonSchema {
    return schema.description ? { ...out, description: schema.description } : out;
}

function stringSchema(checks: Check[]): JsonSchema {
    const out: JsonSchema = { type: "string" };
    for (const check of checks) {
        if (check.kind === "min") out.minLength = check.value;
        else if (check.kind === "max") out.maxLength = check.value;
        else if (check.kind === "length") out.minLength = out.maxLength = check.value;
        else if (check.kind === "uuid") out.format = "uuid";
        else if (check.kind === "email") out.format = "email";
        else if (check.kind === "url") out.format = "uri";
        else if (check.kind === "datetime") out.format = "date-time";
        else if (check.kind === "regex" && check.regex) out.pattern = check.regex.source;
    }
    return out;
}

function numberSchema(checks: Check[]): JsonSchema {
    const out: JsonSchema = { type: checks.some((check) => check.kind === "int") ? "integer" : "number" };
    for (const check of checks) {
        if (check.kind === "min") out[check.inclusive === false ? "exclusiveMinimum" : "minimum"] = check.value;
        else if (check.kind === "max") out[check.inclusive === false ? "exclusiveMaximum" : "maximum"] = check.value;
    }
    return out;
}

/** Convert one zod schema. Throws on a zod type the API reference cannot describe. */
export function toJsonSchema(schema: ZodTypeAny): JsonSchema {
    const def = schema._def;
    const name = def.typeName as string;
    switch (name) {
        case "ZodString":
            return withDescription(schema, stringSchema(def.checks));
        case "ZodNumber":
            return withDescription(schema, numberSchema(def.checks));
        case "ZodBoolean":
            return withDescription(schema, { type: "boolean" });
        case "ZodLiteral":
            return withDescription(schema, { const: def.value });
        case "ZodEnum":
            return withDescription(schema, { type: "string", enum: [...def.values] });
        case "ZodUnknown":
        case "ZodAny":
            return withDescription(schema, {});
        case "ZodNull":
            return withDescription(schema, { type: "null" });
        case "ZodArray":
            return withDescription(schema, { type: "array", items: toJsonSchema(def.type) });
        case "ZodRecord":
            return withDescription(schema, {
                type: "object",
                additionalProperties: toJsonSchema(def.valueType)
            });
        case "ZodUnion":
            return withDescription(schema, { anyOf: (def.options as ZodTypeAny[]).map(toJsonSchema) });
        case "ZodNullable": {
            return withDescription(schema, { anyOf: [toJsonSchema(def.innerType), { type: "null" }] });
        }
        case "ZodOptional":
            return withDescription(schema, toJsonSchema(def.innerType));
        case "ZodDefault":
            return withDescription(schema, { ...toJsonSchema(def.innerType), default: def.defaultValue() });
        case "ZodEffects":
            return withDescription(schema, toJsonSchema(def.schema));
        case "ZodObject": {
            const shape = def.shape() as Record<string, ZodTypeAny>;
            const properties: Record<string, JsonSchema> = {};
            const required: string[] = [];
            for (const [key, field] of Object.entries(shape)) {
                properties[key] = toJsonSchema(field);
                if (!isOptional(field)) required.push(key);
            }
            const out: JsonSchema = { type: "object", properties };
            if (required.length > 0) out.required = required;
            if (def.unknownKeys === "strict") out.additionalProperties = false;
            return withDescription(schema, out);
        }
        default:
            throw new Error(`The API reference cannot describe a ${name}.`);
    }
}
