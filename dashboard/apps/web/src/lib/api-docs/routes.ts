/**
 * Every route that answers to an API key, described once.
 *
 * This list is the API reference and the usage screen's vocabulary at the same
 * time: the OpenAPI document is built from it, and a call a key made is filed
 * under the path template here that it matched. Request schemas are the ones
 * the routes themselves parse with, imported rather than restated, so the
 * reference cannot describe a field the route no longer reads. Responses are
 * written out here from what each route returns.
 *
 * A test reads every `file` and fails when it does not authenticate with a key,
 * and when a route under /api/v1 is missing from this list.
 */

import { z, type ZodTypeAny } from "zod";
import * as schemas from "@/lib/deploy/api/schemas";

export type HttpMethod = "GET" | "POST" | "PUT" | "DELETE";

export interface DocumentedResponse {
    description: string;
    /** JSON body; absent for a response with no body. */
    schema?: ZodTypeAny;
    /** Also answers in text/plain (`?format=text`, or a streamed log). */
    text?: boolean;
}

export interface DocumentedRoute {
    method: HttpMethod;
    /** OpenAPI path template, `{name}` for a segment. */
    path: string;
    /** The route file, relative to src/app. */
    file: string;
    tag: "Account" | "Deploy" | "MCP";
    summary: string;
    description?: string;
    /** Changes something, and counts against the stricter rate limit. */
    changes: boolean;
    params?: Record<string, ZodTypeAny>;
    query?: z.AnyZodObject;
    body?: ZodTypeAny;
    /** The body is raw bytes rather than JSON (an image archive). */
    binaryBody?: { contentType: string; headers: Record<string, string> };
    responses: Record<number, DocumentedResponse>;
}

const ok = (schema: ZodTypeAny, text = true): DocumentedResponse => ({
    description: "OK",
    schema,
    text
});
const accepted = (schema: ZodTypeAny): DocumentedResponse => ({
    description: "Accepted",
    schema,
    text: true
});

/** An entity whose fields this reference does not pin down. */
const entity = (description: string) => z.object({}).passthrough().describe(description);

const serviceId = {
    id: z.string().describe("A service id, or project/service, or project/environment/service")
};
const uuidParam = { id: schemas.idSchema };
const formatQuery = z.object({
    format: z
        .enum(["json", "text"])
        .optional()
        .describe("text answers in plain text instead of JSON")
});
const redeployQuery = formatQuery.merge(schemas.redeployQuerySchema);
const redeployed = z.boolean().describe("Whether the change is being redeployed");

const variableRoutes = (
    prefix: string,
    file: string,
    param: Record<string, ZodTypeAny>
): DocumentedRoute[] => [
    {
        method: "GET",
        path: `${prefix}/variables`,
        file: `${file}/variables/route.ts`,
        tag: "Deploy",
        summary: "List variables",
        description: "Secret values are withheld.",
        changes: false,
        params: param,
        query: formatQuery,
        responses: {
            200: ok(
                z.object({
                    variables: z.array(
                        z
                            .object({
                                id: z.string(),
                                key: z.string(),
                                isSecret: z.boolean(),
                                value: z.string().nullable()
                            })
                            .passthrough()
                    )
                })
            )
        }
    },
    {
        method: "POST",
        path: `${prefix}/variables`,
        file: `${file}/variables/route.ts`,
        tag: "Deploy",
        summary: "Set a variable",
        changes: true,
        params: param,
        query: formatQuery,
        body: schemas.setVariableSchema,
        responses: { 200: ok(z.object({ saved: z.string(), redeployed })) }
    },
    {
        method: "POST",
        path: `${prefix}/variables/import`,
        file: `${file}/variables/import/route.ts`,
        tag: "Deploy",
        summary: "Import a .env file",
        changes: true,
        params: param,
        query: formatQuery,
        body: schemas.importVariablesSchema,
        responses: { 200: ok(z.object({ count: z.number().int(), redeployed })) }
    }
];

export const DOCUMENTED_ROUTES: readonly DocumentedRoute[] = [
    {
        method: "GET",
        path: "/api/v1/me",
        file: "api/v1/me/route.ts",
        tag: "Account",
        summary: "Who this key acts as",
        description: "Needs no scope. Use it to check that a key works.",
        changes: false,
        responses: {
            200: ok(
                z.object({
                    user: z.object({
                        id: z.string(),
                        name: z.string().nullable(),
                        email: z.string(),
                        username: z.string().nullable()
                    }),
                    key: z.object({ id: z.string(), scopes: z.array(z.string()) })
                }),
                false
            )
        }
    },
    {
        method: "DELETE",
        path: "/api/cli/session",
        file: "api/cli/session/route.ts",
        tag: "Account",
        summary: "End a CLI sign-in",
        description:
            "Only a key issued by `plr login` can end itself; any other key is answered 409.",
        changes: true,
        responses: {
            204: { description: "Signed out" },
            409: {
                description: "This key is not a CLI sign-in",
                schema: z.object({ error: z.string() })
            }
        }
    },
    {
        method: "POST",
        path: "/api/mcp",
        file: "api/mcp/route.ts",
        tag: "MCP",
        summary: "Model Context Protocol endpoint",
        description:
            "JSON-RPC 2.0 over streamable HTTP: one message or a batch of up to 20. The tools offered follow the key's scopes.",
        changes: true,
        body: z.union([
            z
                .object({
                    jsonrpc: z.literal("2.0"),
                    id: z.union([z.string(), z.number()]).optional(),
                    method: z.string(),
                    params: z.record(z.unknown()).optional()
                })
                .passthrough(),
            z.array(z.record(z.unknown()))
        ]),
        responses: {
            200: ok(
                z.record(z.unknown()).describe("A JSON-RPC 2.0 response, or a batch of them"),
                false
            )
        }
    },
    {
        method: "GET",
        path: "/api/v1/deploy/projects",
        file: "api/v1/deploy/projects/route.ts",
        tag: "Deploy",
        summary: "List projects",
        changes: false,
        query: formatQuery,
        responses: {
            200: ok(
                z.object({
                    projects: z.array(entity("A project with its environments and services"))
                })
            )
        }
    },
    {
        method: "GET",
        path: "/api/v1/deploy/services",
        file: "api/v1/deploy/services/route.ts",
        tag: "Deploy",
        summary: "Find a service",
        changes: false,
        query: formatQuery.extend({ ref: schemas.serviceRefSchema }),
        responses: { 200: ok(z.object({ service: entity("The service") })) }
    },
    {
        method: "GET",
        path: "/api/v1/deploy/services/{id}",
        file: "api/v1/deploy/services/[id]/route.ts",
        tag: "Deploy",
        summary: "Read a service",
        changes: false,
        params: serviceId,
        query: formatQuery,
        responses: { 200: ok(z.object({ service: entity("The service") })) }
    },
    {
        method: "POST",
        path: "/api/v1/deploy/services/{id}/deploy",
        file: "api/v1/deploy/services/[id]/deploy/route.ts",
        tag: "Deploy",
        summary: "Deploy a service",
        changes: true,
        params: serviceId,
        query: formatQuery,
        responses: { 202: accepted(z.object({ deploymentId: z.string() })) }
    },
    {
        method: "GET",
        path: "/api/v1/deploy/services/{id}/deployments",
        file: "api/v1/deploy/services/[id]/deployments/route.ts",
        tag: "Deploy",
        summary: "List deployments",
        changes: false,
        params: serviceId,
        query: formatQuery,
        responses: { 200: ok(z.object({ deployments: z.array(entity("A deployment")) })) }
    },
    {
        method: "GET",
        path: "/api/v1/deploy/services/{id}/domains",
        file: "api/v1/deploy/services/[id]/domains/route.ts",
        tag: "Deploy",
        summary: "List domains",
        changes: false,
        params: serviceId,
        query: formatQuery,
        responses: { 200: ok(z.object({ domains: z.array(entity("A domain")) })) }
    },
    {
        method: "POST",
        path: "/api/v1/deploy/services/{id}/domains",
        file: "api/v1/deploy/services/[id]/domains/route.ts",
        tag: "Deploy",
        summary: "Add a domain",
        changes: true,
        params: serviceId,
        query: formatQuery,
        body: schemas.addDomainSchema,
        responses: { 201: { description: "Created", schema: entity("The domain"), text: true } }
    },
    {
        method: "GET",
        path: "/api/v1/deploy/services/{id}/env",
        file: "api/v1/deploy/services/[id]/env/route.ts",
        tag: "Deploy",
        summary: "List variable names",
        changes: false,
        params: serviceId,
        query: formatQuery,
        responses: {
            200: ok(
                z.object({
                    variables: z.array(
                        z
                            .object({
                                key: z.string(),
                                isSecret: z.boolean(),
                                updatedAt: z.string()
                            })
                            .passthrough()
                    )
                })
            )
        }
    },
    {
        method: "PUT",
        path: "/api/v1/deploy/services/{id}/env/{name}",
        file: "api/v1/deploy/services/[id]/env/[name]/route.ts",
        tag: "Deploy",
        summary: "Create or replace a variable",
        changes: true,
        params: { ...serviceId, name: schemas.variableKeySchema },
        query: formatQuery,
        body: schemas.putVariableSchema,
        responses: { 200: ok(z.object({ saved: z.string(), created: z.boolean(), redeployed })) }
    },
    {
        method: "DELETE",
        path: "/api/v1/deploy/services/{id}/env/{name}",
        file: "api/v1/deploy/services/[id]/env/[name]/route.ts",
        tag: "Deploy",
        summary: "Remove a variable by name",
        changes: true,
        params: { ...serviceId, name: schemas.variableKeySchema },
        query: redeployQuery,
        responses: { 200: ok(z.object({ removed: z.string(), redeployed })) }
    },
    {
        method: "GET",
        path: "/api/v1/deploy/services/{id}/image",
        file: "api/v1/deploy/services/[id]/image/route.ts",
        tag: "Deploy",
        summary: "Where to tag an uploaded image",
        changes: false,
        params: serviceId,
        query: formatQuery,
        responses: { 200: ok(z.object({ repository: z.string() }).passthrough()) }
    },
    {
        method: "POST",
        path: "/api/v1/deploy/services/{id}/image",
        file: "api/v1/deploy/services/[id]/image/route.ts",
        tag: "Deploy",
        summary: "Deploy an uploaded image",
        description: "The body is a gzipped image archive of at most 16 GB.",
        changes: true,
        params: serviceId,
        query: formatQuery,
        binaryBody: {
            contentType: "application/gzip",
            headers: {
                "x-polaris-commit": "The commit the image was built from",
                "x-polaris-message": "The commit message, URI-encoded"
            }
        },
        responses: { 202: accepted(z.object({ deploymentId: z.string() }).passthrough()) }
    },
    {
        method: "GET",
        path: "/api/v1/deploy/services/{id}/logs",
        file: "api/v1/deploy/services/[id]/logs/route.ts",
        tag: "Deploy",
        summary: "Read a service's logs",
        changes: false,
        params: serviceId,
        query: formatQuery.extend({
            tail: schemas.tailSchema,
            since: z.string().max(64).optional()
        }),
        responses: { 200: ok(z.object({ log: z.string() })) }
    },
    ...(
        [
            ["restart", "restarted"],
            ["start", "started"],
            ["stop", "stopped"]
        ] as const
    ).map(
        ([action, done]): DocumentedRoute => ({
            method: "POST",
            path: `/api/v1/deploy/services/{id}/${action}`,
            file: `api/v1/deploy/services/[id]/${action}/route.ts`,
            tag: "Deploy",
            summary: `${action[0]!.toUpperCase()}${action.slice(1)} a service`,
            changes: true,
            params: serviceId,
            query: formatQuery,
            responses: { 200: ok(z.object({ [done]: z.literal(true) })) }
        })
    ),
    ...variableRoutes("/api/v1/deploy/services/{id}", "api/v1/deploy/services/[id]", serviceId),
    ...variableRoutes(
        "/api/v1/deploy/environments/{id}",
        "api/v1/deploy/environments/[id]",
        uuidParam
    ),
    {
        method: "DELETE",
        path: "/api/v1/deploy/variables/{id}",
        file: "api/v1/deploy/variables/[id]/route.ts",
        tag: "Deploy",
        summary: "Remove a variable",
        changes: true,
        params: uuidParam,
        query: redeployQuery,
        responses: { 200: ok(z.object({ removed: z.string(), redeployed })) }
    },
    {
        method: "GET",
        path: "/api/v1/deploy/variables/{id}/value",
        file: "api/v1/deploy/variables/[id]/value/route.ts",
        tag: "Deploy",
        summary: "Reveal a variable's value",
        changes: false,
        params: uuidParam,
        query: formatQuery,
        responses: { 200: ok(z.object({ key: z.string(), value: z.string().nullable() })) }
    },
    {
        method: "GET",
        path: "/api/v1/deploy/deployments/{id}",
        file: "api/v1/deploy/deployments/[id]/route.ts",
        tag: "Deploy",
        summary: "Read a deployment's build log",
        description: "With follow=1 the log is streamed as text/plain until the build ends.",
        changes: false,
        params: uuidParam,
        query: formatQuery.extend({
            tail: z.coerce.number().int().min(1).max(5000).optional(),
            offset: schemas.offsetSchema,
            follow: z.enum(["1", "true", "0", "false"]).optional()
        }),
        responses: { 200: ok(z.object({ log: z.string() }).passthrough()) }
    },
    {
        method: "POST",
        path: "/api/v1/deploy/deployments/{id}/cancel",
        file: "api/v1/deploy/deployments/[id]/cancel/route.ts",
        tag: "Deploy",
        summary: "Cancel a deployment",
        changes: true,
        params: uuidParam,
        query: formatQuery,
        responses: { 200: ok(z.object({ cancelled: z.string() })) }
    },
    {
        method: "POST",
        path: "/api/v1/deploy/deployments/{id}/rollback",
        file: "api/v1/deploy/deployments/[id]/rollback/route.ts",
        tag: "Deploy",
        summary: "Roll back to a deployment",
        changes: true,
        params: uuidParam,
        query: formatQuery,
        responses: { 202: accepted(z.object({ deploymentId: z.string() })) }
    },
    {
        method: "DELETE",
        path: "/api/v1/deploy/domains/{id}",
        file: "api/v1/deploy/domains/[id]/route.ts",
        tag: "Deploy",
        summary: "Remove a domain",
        changes: true,
        params: uuidParam,
        query: formatQuery,
        responses: { 200: ok(z.object({ removed: z.string() })) }
    }
];

/** One compiled matcher per documented path, most specific first: a literal
 *  segment outranks a `{param}` in the same position. */
const MATCHERS = DOCUMENTED_ROUTES.map((route) => ({
    route,
    pattern: new RegExp(`^${route.path.replace(/\{[^}]+\}/g, "[^/]+")}/?$`),
    params: (route.path.match(/\{/g) ?? []).length
})).sort((a, b) => a.params - b.params);

/** The documented route a request landed on, or null for one this list does not hold. */
export function matchDocumentedRoute(method: string, pathname: string): DocumentedRoute | null {
    const upper = method.toUpperCase();
    for (const { route, pattern } of MATCHERS) {
        if (route.method === upper && pattern.test(pathname)) return route;
    }
    return null;
}
