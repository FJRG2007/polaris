/**
 * The JSON Schema an MCP client is handed for a tool's arguments.
 *
 * Every tool already has a Zod schema, because everything crossing into Polaris
 * is validated against one. MCP wants the same shape a second time, as JSON
 * Schema, so the model on the other end knows what to send. Writing both by hand
 * is how the two drift: the validator gains a field, the description does not,
 * and the model stops being able to call a tool that would have worked.
 *
 * So the schema is derived from the validator, and only the subset the tools
 * actually use is supported. That is deliberate rather than lazy - a converter
 * that silently produces `{}` for something it does not understand hands the
 * model a tool with no arguments and no way to discover that, which is a worse
 * failure than the loud one below.
 */

import { z } from "zod";

export interface JsonSchema {
    type?: string | string[];
    description?: string;
    properties?: Record<string, JsonSchema>;
    required?: string[];
    items?: JsonSchema;
    enum?: readonly unknown[];
    additionalProperties?: boolean | JsonSchema;
    minLength?: number;
    maxLength?: number;
    minimum?: number;
    maximum?: number;
    format?: string;
    default?: unknown;
}

/** Zod does not expose its internals as types, and reading `_def` is the only way
 *  to walk a schema. Confined to this file. */
type AnyDef = { typeName: string } & Record<string, unknown>;

function def(schema: z.ZodTypeAny): AnyDef {
    return (schema as unknown as { _def: AnyDef })._def;
}

/** The string checks worth carrying across. A model does better with "at most 80
 *  characters" in the schema than with a 400 it has to learn from. */
function stringSchema(node: AnyDef): JsonSchema {
    const schema: JsonSchema = { type: "string" };
    for (const check of (node.checks as { kind: string; value?: number }[] | undefined) ?? []) {
        if (check.kind === "min" && typeof check.value === "number") schema.minLength = check.value;
        if (check.kind === "max" && typeof check.value === "number") schema.maxLength = check.value;
        if (check.kind === "uuid") schema.format = "uuid";
        if (check.kind === "email") schema.format = "email";
        if (check.kind === "url") schema.format = "uri";
    }
    return schema;
}

function numberSchema(node: AnyDef): JsonSchema {
    const schema: JsonSchema = { type: node.checks && isInt(node) ? "integer" : "number" };
    for (const check of (node.checks as { kind: string; value?: number }[] | undefined) ?? []) {
        if (check.kind === "min" && typeof check.value === "number") schema.minimum = check.value;
        if (check.kind === "max" && typeof check.value === "number") schema.maximum = check.value;
    }
    return schema;
}

function isInt(node: AnyDef): boolean {
    return ((node.checks as { kind: string }[] | undefined) ?? []).some(
        (check) => check.kind === "int"
    );
}

/**
 * One schema, converted.
 *
 * Throws on anything unsupported. The tools are a fixed list checked by a test,
 * so this can only fire while somebody is writing a new one - which is exactly
 * when they can do something about it.
 */
export function toJsonSchema(schema: z.ZodTypeAny): JsonSchema {
    const node = def(schema);
    const described = (result: JsonSchema): JsonSchema => {
        const description = (node.description as string | undefined) ?? undefined;
        return description ? { ...result, description } : result;
    };

    switch (node.typeName) {
        case "ZodString":
            return described(stringSchema(node));
        case "ZodNumber":
            return described(numberSchema(node));
        case "ZodBoolean":
            return described({ type: "boolean" });
        case "ZodLiteral":
            return described({ enum: [node.value] });
        case "ZodEnum":
            return described({ type: "string", enum: node.values as readonly string[] });
        case "ZodNativeEnum":
            return described({ enum: Object.values(node.values as Record<string, unknown>) });
        case "ZodArray":
            return described({ type: "array", items: toJsonSchema(node.type as z.ZodTypeAny) });
        case "ZodRecord":
            return described({
                type: "object",
                additionalProperties: toJsonSchema(node.valueType as z.ZodTypeAny)
            });
        case "ZodObject": {
            const shape = (node.shape as () => Record<string, z.ZodTypeAny>)();
            const properties: Record<string, JsonSchema> = {};
            const required: string[] = [];
            for (const [key, value] of Object.entries(shape)) {
                properties[key] = toJsonSchema(value);
                if (!isOptional(value)) required.push(key);
            }
            const result: JsonSchema = { type: "object", properties, additionalProperties: false };
            if (required.length > 0) result.required = required;
            return described(result);
        }
        case "ZodOptional":
        case "ZodNullable":
            return described(toJsonSchema(node.innerType as z.ZodTypeAny));
        case "ZodDefault": {
            const inner = toJsonSchema(node.innerType as z.ZodTypeAny);
            return described({ ...inner, default: (node.defaultValue as () => unknown)() });
        }
        // A refinement narrows a value without changing its shape, so the shape is
        // the inner one and the rule stays where it is enforced.
        case "ZodEffects":
            return described(toJsonSchema(node.schema as z.ZodTypeAny));
        default:
            throw new Error(
                `No JSON Schema for ${node.typeName}. Add it, or use a shape the tools already use.`
            );
    }
}

/** Whether a field may be left out. A default counts: the caller does not have to
 *  send it, which is the only question the `required` list is asking. */
function isOptional(schema: z.ZodTypeAny): boolean {
    const node = def(schema);
    if (node.typeName === "ZodOptional" || node.typeName === "ZodDefault") return true;
    if (node.typeName === "ZodEffects") return isOptional(node.schema as z.ZodTypeAny);
    return false;
}
