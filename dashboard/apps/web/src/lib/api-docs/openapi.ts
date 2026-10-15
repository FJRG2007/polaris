/**
 * The OpenAPI 3.1 document for the routes an API key can call, built from
 * DOCUMENTED_ROUTES. Pure: the same list and base address give the same
 * document, so a test can hold it to the routes on disk.
 */

import type { ZodTypeAny } from "zod";
import { curlCommand } from "./curl";
import { DOCUMENTED_ROUTES, type DocumentedRoute } from "./routes";
import { isOptional, toJsonSchema, type JsonSchema } from "./json-schema";

/** What a key looks like in an example. Never a real one. */
export const PLACEHOLDER_KEY = "plk_YOUR_API_KEY";

const ERROR_SCHEMA: JsonSchema = {
    type: "object",
    properties: { error: { type: "string" } },
    required: ["error"]
};

/** What every keyed route can answer besides its own responses. */
const COMMON_ERRORS: Record<number, string> = {
    400: "The request did not match the schema; the message names the field",
    401: "The key is missing, invalid, revoked, expired, or not allowed from here",
    403: "The key or its owner lacks the permission this needs",
    404: "Not found, or not visible to this key",
    429: "Too many calls with this key; wait the seconds in Retry-After"
};

/** `{id}` -> `id`, in order. */
export function pathParams(path: string): string[] {
    return [...path.matchAll(/\{([^}]+)\}/g)].map((match) => match[1]!);
}

/** The operationId: the method and the path's segments, camel-cased, `{id}` read as "ById". */
export function operationId(route: DocumentedRoute): string {
    const words = route.path
        .replace(/^\/api\/(v1\/)?/, "")
        .split("/")
        .filter(Boolean)
        .map((part) => (part.startsWith("{") ? `by-${part.slice(1, -1)}` : part))
        .flatMap((part) => part.split(/[^A-Za-z0-9]+/))
        .filter(Boolean);
    return [
        route.method.toLowerCase(),
        ...words.map((word) => word[0]!.toUpperCase() + word.slice(1))
    ].join("");
}

function parameters(route: DocumentedRoute): JsonSchema[] {
    const out: JsonSchema[] = pathParams(route.path).map((name) => {
        const schema = route.params?.[name];
        return {
            name,
            in: "path",
            required: true,
            schema: schema ? toJsonSchema(schema) : { type: "string" }
        };
    });
    const shape = (route.query?.shape ?? {}) as Record<string, ZodTypeAny>;
    for (const [name, schema] of Object.entries(shape)) {
        const json = toJsonSchema(schema);
        out.push({
            name,
            in: "query",
            required: !isOptional(schema),
            schema: json,
            ...(json.description ? { description: json.description } : {})
        });
    }
    for (const [name, description] of Object.entries(route.binaryBody?.headers ?? {})) {
        out.push({ name, in: "header", required: false, description, schema: { type: "string" } });
    }
    return out;
}

function responses(route: DocumentedRoute): Record<string, JsonSchema> {
    const out: Record<string, JsonSchema> = {};
    for (const [status, response] of Object.entries(route.responses)) {
        const content: Record<string, JsonSchema> = {};
        if (response.schema)
            content["application/json"] = { schema: toJsonSchema(response.schema) };
        if (response.text) content["text/plain"] = { schema: { type: "string" } };
        out[status] =
            Object.keys(content).length > 0
                ? { description: response.description, content }
                : { description: response.description };
    }
    for (const [status, description] of Object.entries(COMMON_ERRORS)) {
        if (out[status]) continue;
        if (status === "429" && route.tag === "Account") continue;
        out[status] = { description, content: { "application/json": { schema: ERROR_SCHEMA } } };
    }
    return out;
}

function operation(route: DocumentedRoute): JsonSchema {
    const op: JsonSchema = {
        operationId: operationId(route),
        tags: [route.tag],
        summary: route.summary,
        ...(route.description ? { description: route.description } : {}),
        security: [{ apiKey: [] }],
        parameters: parameters(route),
        responses: responses(route)
    };
    if (route.body) {
        op.requestBody = {
            required: true,
            content: { "application/json": { schema: toJsonSchema(route.body) } }
        };
    } else if (route.binaryBody) {
        op.requestBody = {
            required: true,
            content: {
                [route.binaryBody.contentType]: {
                    schema: { type: "string", contentMediaType: route.binaryBody.contentType }
                }
            }
        };
    }
    return op;
}

/** The whole document. `baseUrl` is the instance's own address, without a trailing slash. */
export function buildOpenApi(
    baseUrl: string,
    routes: readonly DocumentedRoute[] = DOCUMENTED_ROUTES
): JsonSchema {
    const paths: Record<string, Record<string, JsonSchema>> = {};
    for (const route of routes) {
        (paths[route.path] ??= {})[route.method.toLowerCase()] = operation(route);
    }
    return {
        openapi: "3.1.0",
        info: {
            title: "Polaris API",
            version: "1",
            description:
                "Calls an API key can make. A key acts as the person who made it, and never with more than they can do themselves."
        },
        servers: [{ url: baseUrl }],
        tags: [{ name: "Account" }, { name: "Deploy" }, { name: "MCP" }],
        components: {
            securitySchemes: {
                apiKey: {
                    type: "http",
                    scheme: "bearer",
                    description:
                        "An API key from Account > API keys, sent as `Authorization: Bearer plk_...`."
                }
            }
        },
        security: [{ apiKey: [] }],
        paths
    };
}

/** A curl line for one route, with the placeholder key and example path values. */
export function curlExample(route: DocumentedRoute, baseUrl: string): string {
    const bodyExample = route.body ? JSON.stringify(exampleOf(toJsonSchema(route.body))) : null;
    return curlCommand(
        {
            method: route.method,
            path: route.path,
            bodyExample,
            binaryType: route.binaryBody?.contentType
        },
        baseUrl,
        PLACEHOLDER_KEY
    );
}

/** A minimal example value for a JSON schema: required fields only, defaults where given. */
export function exampleOf(schema: JsonSchema): unknown {
    if ("default" in schema) return schema.default;
    if ("const" in schema) return schema.const;
    if (Array.isArray(schema.enum)) return schema.enum[0];
    if (Array.isArray(schema.anyOf)) return exampleOf(schema.anyOf[0] as JsonSchema);
    switch (schema.type) {
        case "object": {
            const properties = (schema.properties ?? {}) as Record<string, JsonSchema>;
            const required = new Set((schema.required ?? []) as string[]);
            return Object.fromEntries(
                Object.entries(properties)
                    .filter(([name]) => required.has(name))
                    .map(([name, property]) => [name, exampleOf(property)])
            );
        }
        case "array":
            return [];
        case "integer":
        case "number":
            return typeof schema.minimum === "number" ? schema.minimum : 1;
        case "boolean":
            return false;
        case "string":
            return schema.format === "uuid" ? "00000000-0000-0000-0000-000000000000" : "string";
        default:
            return null;
    }
}
