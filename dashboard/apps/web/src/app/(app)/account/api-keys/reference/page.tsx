/**
 * API reference (/account/api-keys/reference): every route a key can call, read
 * from the same list the OpenAPI document is built from. Nothing here waits on
 * data - the routes are known at build time and the instance's address comes
 * from the app-URL provider in the browser - so the page paints whole.
 */

import type { ZodTypeAny } from "zod";
import { requireUser } from "@/lib/session";
import { isOptional, toJsonSchema } from "@/lib/api-docs/json-schema";
import { DOCUMENTED_ROUTES } from "@/lib/api-docs/routes";
import { ApiReferenceView, type ReferenceEntry } from "./api-reference-view";
import { operationId, exampleOf, PLACEHOLDER_KEY } from "@/lib/api-docs/openapi";

export const dynamic = "force-dynamic";

function entries(): ReferenceEntry[] {
    return DOCUMENTED_ROUTES.map((route) => {
        const query = Object.entries((route.query?.shape ?? {}) as Record<string, ZodTypeAny>);
        const parameters = [
            ...Object.entries(route.params ?? {}).map(([name, schema]) => ({ name, where: "path" as const, schema: toJsonSchema(schema) })),
            ...query.map(([name, schema]) => ({ name, where: "query" as const, schema: toJsonSchema(schema) })),
            ...Object.entries(route.binaryBody?.headers ?? {}).map(([name, description]) => ({
                name,
                where: "header" as const,
                schema: { type: "string", description }
            }))
        ].map((parameter) => ({
            name: parameter.name,
            where: parameter.where,
            required: parameter.where === "path" || (parameter.where === "query" && !isOptional(route.query!.shape[parameter.name]!)),
            type: describeType(parameter.schema),
            description: typeof parameter.schema.description === "string" ? parameter.schema.description : null
        }));
        const body = route.body ? toJsonSchema(route.body) : null;
        return {
            id: operationId(route),
            method: route.method,
            path: route.path,
            tag: route.tag,
            summary: route.summary,
            description: route.description ?? null,
            changes: route.changes,
            parameters,
            body: body ? JSON.stringify(body, null, 2) : null,
            bodyExample: body ? JSON.stringify(exampleOf(body)) : null,
            binaryType: route.binaryBody?.contentType ?? null,
            responses: Object.entries(route.responses).map(([status, response]) => ({
                status: Number(status),
                description: response.description,
                schema: response.schema ? JSON.stringify(toJsonSchema(response.schema), null, 2) : null,
                text: Boolean(response.text)
            }))
        };
    });
}

/** A one-word type for a parameter row: integer 1-5000, one of a | b, uuid. */
function describeType(schema: Record<string, unknown>): string {
    if (Array.isArray(schema.enum)) return schema.enum.join(" | ");
    if (schema.format === "uuid") return "uuid";
    const type = typeof schema.type === "string" ? schema.type : "string";
    if (typeof schema.minimum === "number" && typeof schema.maximum === "number") return `${type} ${schema.minimum}-${schema.maximum}`;
    return type;
}

export default async function ApiReferencePage() {
    await requireUser();
    return <ApiReferenceView entries={entries()} placeholder={PLACEHOLDER_KEY} />;
}
