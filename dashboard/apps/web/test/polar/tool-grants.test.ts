/**
 * Storing "Always allow": a destructive tool that names its target is never
 * allowed whole, and no grant is stored past the limit the turn reads.
 */

import { z } from "zod";
import { beforeEach, describe, expect, it, vi } from "vitest";

const rows: { ownerId: string; tool: string; target: string }[] = [];

vi.mock("@polaris/db", () => ({
    prisma: {
        polarToolGrant: {
            findUnique: async ({
                where
            }: {
                where: { ownerId_tool_target: { ownerId: string; tool: string; target: string } };
            }) => {
                const key = where.ownerId_tool_target;
                const found = rows.find(
                    (row) =>
                        row.ownerId === key.ownerId &&
                        row.tool === key.tool &&
                        row.target === key.target
                );
                return found ? { id: "g" } : null;
            },
            count: async ({ where }: { where: { ownerId: string } }) =>
                rows.filter((row) => row.ownerId === where.ownerId).length,
            upsert: async ({ create }: { create: (typeof rows)[number] }) => {
                rows.push(create);
                return create;
            }
        }
    }
}));

vi.mock("@/lib/mcp/catalog", () => ({ mcpTools: async () => [] }));

const { GRANT_LIMIT, grantScope, saveGrant } = await import("@/lib/polar/tool-grants");

const DOOR = {
    name: "places_control",
    description: "Operates a device",
    input: z.object({ id: z.string() }),
    scope: "places.manage",
    readOnly: false,
    target: async (input: { id: string }) => ({ id: input.id, name: "Studio door" }),
    run: async () => ({ text: "done" })
} as never;

const RENAME = {
    name: "tasks_rename",
    description: "Renames a task",
    input: z.object({}),
    scope: "tasks.manage",
    readOnly: false,
    destructive: false,
    run: async () => ({ text: "done" })
} as never;

beforeEach(() => {
    rows.length = 0;
});

describe("saveGrant", () => {
    it("refuses to allow a destructive tool whole when its target could not be read", async () => {
        expect(grantScope(DOOR, null)).toBeNull();
        expect(await saveGrant("u1", DOOR, null)).toBe("target_unknown");
        expect(rows).toEqual([]);
    });

    it("stores a destructive tool's grant under the one target it was shown", async () => {
        expect(await saveGrant("u1", DOOR, { id: "d1", name: "Studio door" })).toBeNull();
        expect(rows).toMatchObject([{ tool: "places_control", target: "d1" }]);
    });

    it("refuses a new grant at the limit, and still accepts one already held", async () => {
        for (let index = 0; index < GRANT_LIMIT; index++)
            rows.push({ ownerId: "u1", tool: "places_control", target: `d${index}` });
        expect(await saveGrant("u1", RENAME, null)).toBe("limit");
        expect(await saveGrant("u1", DOOR, { id: "d0", name: "Studio door" })).toBeNull();
        expect(rows).toHaveLength(GRANT_LIMIT);
    });
});
