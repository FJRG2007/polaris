/**
 * The place a page of agent sessions ends, as `listSessions` reads it: the
 * time and id of the last session listed, not a row to look up, so a page goes
 * on from the right place after that session is deleted.
 */

import { z } from "zod";

export function sessionCursor(session: {
    readonly id: string;
    readonly createdAt: string;
}): string {
    return `${session.createdAt}_${session.id}`;
}

export const sessionCursorSchema = z
    .string()
    .trim()
    .max(80)
    .refine((value) => readSessionCursor(value) !== null);

export function readSessionCursor(value: string): { at: Date; id: string } | null {
    const split = value.indexOf("_");
    if (split < 0) return null;
    const at = z.string().datetime().safeParse(value.slice(0, split));
    const id = z
        .string()
        .uuid()
        .safeParse(value.slice(split + 1));
    if (!at.success || !id.success) return null;
    return { at: new Date(at.data), id: id.data };
}
