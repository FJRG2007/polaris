/**
 * Shared request validation and authorization for the Containers API routes.
 *
 * Every route takes the same two things - which connection, which container - so
 * they are parsed once here rather than re-derived per route, and the answer to
 * "may this user touch this engine at all" is decided in one place. The local
 * engine is host-wide, so it is gated on system.manage; every other connection
 * is resolved owner-scoped further down and needs no extra gate.
 */

import { z } from "zod";
import { requireUser, userHasManage } from "@/lib/session";
import { LOCAL_DOCKER_CONNECTION_ID } from "@/lib/docker-service";

/** A Docker id or name, plus the prefixed forms a Containers connection id
 *  takes (`local`, `host:<id>`, or a stored row's cuid). */
const connectionId = z.string().min(1).max(200);
const containerId = z
    .string()
    .min(1)
    .max(128)
    .regex(/^[A-Za-z0-9][A-Za-z0-9_.-]*$/, "Invalid container id");

export const listQuerySchema = z.object({ c: connectionId });

export const containerQuerySchema = z.object({ c: connectionId, id: containerId });

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
    if (!parsed.success) return { ok: false, error: parsed.error.issues[0]?.message ?? "Invalid request" };
    return { ok: true, data: parsed.data };
}

export interface AuthorizedCaller {
    userId: string;
}

/**
 * The signed-in user, when they may reach this connection at all. Null for the
 * local engine when the caller cannot manage the system; a stored or Host
 * connection resolves owner-scoped later, which is what stops one operator
 * reaching another's engine. These routes only read - acting on a container goes
 * through the server actions, which re-check system.manage themselves.
 */
export async function authorizeConnection(connection: string): Promise<AuthorizedCaller | null> {
    const user = await requireUser();
    if (connection === LOCAL_DOCKER_CONNECTION_ID && !(await userHasManage(user, "system.manage"))) return null;
    return { userId: user.id };
}
