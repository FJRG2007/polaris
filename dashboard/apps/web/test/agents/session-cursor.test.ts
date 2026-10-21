/**
 * Where a page of agent sessions ends: a time and an id, read back as they
 * were written, and nothing else accepted.
 */

import { describe, expect, it } from "vitest";
import { readSessionCursor, sessionCursor, sessionCursorSchema } from "@/lib/agents/session-cursor";

const ID = "11111111-1111-4111-8111-111111111111";
const AT = "2026-10-20T10:00:00.000Z";

describe("sessionCursor", () => {
    it("reads back the time and id it was made from", () => {
        const cursor = sessionCursor({ id: ID, createdAt: AT });
        expect(sessionCursorSchema.safeParse(cursor).success).toBe(true);
        expect(readSessionCursor(cursor)).toEqual({ at: new Date(AT), id: ID });
    });

    it("refuses a bare id, a bad time or a bad id", () => {
        for (const value of [ID, `nope_${ID}`, `${AT}_nope`, `${AT}${ID}`, ""]) {
            expect(sessionCursorSchema.safeParse(value).success).toBe(false);
            expect(readSessionCursor(value)).toBeNull();
        }
    });
});
