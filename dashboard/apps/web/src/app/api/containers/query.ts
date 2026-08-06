/**
 * Shared request validation and authorization for the Containers API routes.
 *
 * Every route takes the same two things - which connection, which container - so
 * they are parsed once here rather than re-derived per route, and the answer to
 * "may this user touch this engine at all" is decided in one place. The local
 * engine is host-wide, so it is gated on system.manage; every other connection
 * is owned, and ownership is settled here rather than left to whatever the route
 * happens to do next - a route that answers from a cache resolves no driver and
 * would otherwise be gated by nothing at all.
 */

import { z } from "zod";
import { requireUser, userHasManage } from "@/lib/session";
import { LOCAL_DOCKER_CONNECTION_ID, ownsDockerConnection } from "@/lib/docker-service";

/** A Docker id or name, plus the prefixed forms a Containers connection id
 *  takes (`local`, `host:<id>`, or a stored row's cuid). */
const connectionId = z.string().min(1).max(200);
const containerId = z
    .string()
    .min(1)
    .max(128)
    .regex(/^[A-Za-z0-9][A-Za-z0-9_.-]*$/, "Invalid container id");

/** A yes/no flag in a query string. Spelled out rather than coerced, because
 *  every non-empty string coerces to true - "0" and "false" included. */
const flag = z
    .enum(["0", "1", "true", "false"])
    .default("0")
    .transform((value) => value === "1" || value === "true");

export const listQuerySchema = z.object({ c: connectionId });

export const containerQuerySchema = z.object({ c: connectionId, id: containerId });

/** `size` asks the daemon what the container occupies on disk, which it answers
 *  by walking the filesystem - off unless a caller says it is worth the wait. */
export const inspectQuerySchema = containerQuerySchema.extend({ size: flag });

export const logsQuerySchema = containerQuerySchema.extend({
    tail: z.coerce.number().int().min(1).max(5000).default(200)
});

export const filesQuerySchema = containerQuerySchema.extend({
    p: z.string().max(4096).default("/")
});

/** Parse a URL's query string with a schema, or return the first message. */
export function parseQuery<T extends z.ZodTypeAny>(
    url: string,
    schema: T
): { ok: true; data: z.infer<T> } | { ok: false; error: string } {
    const parsed = schema.safeParse(Object.fromEntries(new URL(url).searchParams));
    if (!parsed.success)
        return { ok: false, error: parsed.error.issues[0]?.message ?? "Invalid request" };
    return { ok: true, data: parsed.data };
}

export interface AuthorizedCaller {
    userId: string;
}

/**
 * The signed-in user, when they may reach this connection at all. Null for the
 * local engine when the caller cannot manage the system, and null for a stored
 * or Host connection somebody else owns - which is what stops one operator
 * reaching another's engine, whether the route goes on to open a driver or reads
 * a sample that engine already gave up. These routes only read - acting on a
 * container goes through the server actions, which re-check system.manage
 * themselves.
 */
export async function authorizeConnection(connection: string): Promise<AuthorizedCaller | null> {
    const user = await requireUser();
    if (connection === LOCAL_DOCKER_CONNECTION_ID) {
        return (await userHasManage(user, "system.manage")) ? { userId: user.id } : null;
    }
    if (!(await ownsDockerConnection(connection, user.id))) return null;
    return { userId: user.id };
}
