/**
 * The control server's REST API (`/api/v1`, Headscale v0.29.6), every response
 * checked against a schema before Polaris reads a field of it.
 *
 * The API is grpc-gateway over Headscale's gRPC service with its default
 * marshaller, which writes field names in lowerCamelCase (`ipAddresses`,
 * `lastSeen`) and 64-bit ids as strings. Both spellings are accepted here, and
 * an id as a number too, because the gateway's options are Headscale's to change
 * and a device list that stops parsing is a screen that goes blank.
 *
 * Server-only: the key it carries opens every device on the tailnet.
 */

import { z } from "zod";

/** `last_seen` to `lastSeen`, for every key of an object, recursively. */
function camelKeys(value: unknown): unknown {
    if (Array.isArray(value)) return value.map(camelKeys);
    if (value === null || typeof value !== "object") return value;
    return Object.fromEntries(
        Object.entries(value as Record<string, unknown>).map(([key, inner]) => [
            key.replace(/_([a-z])/g, (_, letter: string) => letter.toUpperCase()),
            camelKeys(inner)
        ])
    );
}

const id = z.union([z.string().regex(/^\d+$/), z.number().int().nonnegative()]).transform(String);
const timestamp = z
    .string()
    .nullish()
    .transform((value) => value ?? null);
const strings = z
    .array(z.string())
    .nullish()
    .transform((value) => value ?? []);

export const headscaleUserSchema = z.object({
    id,
    name: z.string(),
    displayName: z
        .string()
        .nullish()
        .transform((value) => value ?? ""),
    email: z
        .string()
        .nullish()
        .transform((value) => value ?? "")
});
export type HeadscaleUser = z.infer<typeof headscaleUserSchema>;

export const headscaleNodeSchema = z.object({
    id,
    name: z.string(),
    givenName: z
        .string()
        .nullish()
        .transform((value) => value ?? ""),
    user: headscaleUserSchema.nullish().transform((value) => value ?? null),
    ipAddresses: strings,
    online: z
        .boolean()
        .nullish()
        .transform((value) => value ?? false),
    lastSeen: timestamp,
    expiry: timestamp,
    createdAt: timestamp,
    approvedRoutes: strings,
    availableRoutes: strings,
    subnetRoutes: strings,
    tags: strings
});
export type HeadscaleNode = z.infer<typeof headscaleNodeSchema>;

export const preAuthKeySchema = z.object({
    id,
    key: z.string().min(1),
    reusable: z
        .boolean()
        .nullish()
        .transform((value) => value ?? false),
    ephemeral: z
        .boolean()
        .nullish()
        .transform((value) => value ?? false),
    expiration: timestamp
});
export type PreAuthKey = z.infer<typeof preAuthKeySchema>;

const usersResponse = z.object({ users: z.array(headscaleUserSchema).nullish() });
const userResponse = z.object({ user: headscaleUserSchema });
const nodesResponse = z.object({ nodes: z.array(headscaleNodeSchema).nullish() });
const nodeResponse = z.object({ node: headscaleNodeSchema });
const preAuthKeyResponse = z.object({ preAuthKey: preAuthKeySchema });
const healthResponse = z.object({
    databaseConnectivity: z
        .boolean()
        .nullish()
        .transform((value) => value ?? false)
});

/** Parse a response body, camel-casing it first. Exported for the fixture tests. */
export function parseResponse<S extends z.ZodTypeAny>(schema: S, body: unknown): z.output<S> {
    return schema.parse(camelKeys(body));
}

/** Why a call to the control server did not succeed: its status and the
 *  message it gave, which is logged, never shown. */
export class HeadscaleError extends Error {
    constructor(
        readonly status: number,
        message: string
    ) {
        super(message);
        this.name = "HeadscaleError";
    }
}

export interface HeadscaleClient {
    health(): Promise<boolean>;
    listUsers(name?: string): Promise<HeadscaleUser[]>;
    createUser(input: { name: string; displayName: string; email: string }): Promise<HeadscaleUser>;
    listNodes(user?: string): Promise<HeadscaleNode[]>;
    renameNode(nodeId: string, name: string): Promise<HeadscaleNode>;
    deleteNode(nodeId: string): Promise<void>;
    /** Sign a device out now: it has to sign in again before it reconnects. */
    expireNode(nodeId: string): Promise<void>;
    /** Delete a user, which Headscale refuses while it still has devices. */
    deleteUser(userId: string): Promise<void>;
    approveRoutes(nodeId: string, routes: readonly string[]): Promise<HeadscaleNode>;
    createPreAuthKey(input: {
        userId: string;
        reusable: boolean;
        ephemeral: boolean;
        expiration: Date;
    }): Promise<PreAuthKey>;
    registerNode(user: string, authId: string): Promise<HeadscaleNode>;
    /** Replace the access policy (policy mode `database`). */
    setPolicy(policy: string): Promise<void>;
}

const TIMEOUT_MS = 8_000;

/** A client for the server at `origin` (`http://host:port`), signed with `apiKey`. */
export function headscaleClient(
    origin: string,
    apiKey: string,
    fetcher: typeof fetch = fetch
): HeadscaleClient {
    async function call<S extends z.ZodTypeAny>(
        method: "GET" | "POST" | "PUT" | "DELETE",
        path: string,
        schema: S,
        body?: unknown
    ): Promise<z.output<S>> {
        const response = await fetcher(`${origin}/api/v1${path}`, {
            method,
            headers: {
                Authorization: `Bearer ${apiKey}`,
                Accept: "application/json",
                ...(body === undefined ? {} : { "Content-Type": "application/json" })
            },
            body: body === undefined ? undefined : JSON.stringify(body),
            signal: AbortSignal.timeout(TIMEOUT_MS),
            cache: "no-store"
        });
        const text = await response.text();
        if (!response.ok) throw new HeadscaleError(response.status, text.slice(0, 500));
        return parseResponse(schema, text ? JSON.parse(text) : {});
    }
    const segment = encodeURIComponent;
    return {
        async health() {
            return (await call("GET", "/health", healthResponse)).databaseConnectivity;
        },
        async listUsers(name) {
            const query = name ? `?name=${segment(name)}` : "";
            return (await call("GET", `/user${query}`, usersResponse)).users ?? [];
        },
        async createUser(input) {
            return (await call("POST", "/user", userResponse, input)).user;
        },
        async listNodes(user) {
            const query = user ? `?user=${segment(user)}` : "";
            return (await call("GET", `/node${query}`, nodesResponse)).nodes ?? [];
        },
        async renameNode(nodeId, name) {
            return (
                await call("POST", `/node/${segment(nodeId)}/rename/${segment(name)}`, nodeResponse)
            ).node;
        },
        async deleteNode(nodeId) {
            await call("DELETE", `/node/${segment(nodeId)}`, z.unknown());
        },
        async expireNode(nodeId) {
            await call("POST", `/node/${segment(nodeId)}/expire`, z.unknown());
        },
        async deleteUser(userId) {
            await call("DELETE", `/user/${segment(userId)}`, z.unknown());
        },
        async approveRoutes(nodeId, routes) {
            return (
                await call("POST", `/node/${segment(nodeId)}/approve_routes`, nodeResponse, {
                    routes
                })
            ).node;
        },
        async createPreAuthKey(input) {
            return (
                await call("POST", "/preauthkey", preAuthKeyResponse, {
                    user: input.userId,
                    reusable: input.reusable,
                    ephemeral: input.ephemeral,
                    expiration: input.expiration.toISOString()
                })
            ).preAuthKey;
        },
        async registerNode(user, authId) {
            return (await call("POST", "/auth/register", nodeResponse, { user, auth_id: authId }))
                .node;
        },
        async setPolicy(policy) {
            await call("PUT", "/policy", z.unknown(), { policy });
        }
    };
}
