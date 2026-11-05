/**
 * The repositories a session or a task hand-off is started on, a page at a
 * time: the owner's enabled ones, searched and ordered by full name in the
 * database, continued on that name, and never more than one row past the page.
 */

import { beforeEach, describe, expect, it, vi } from "vitest";

const findMany = vi.fn(async (_args: Record<string, unknown>) => [] as unknown[]);

vi.mock("@polaris/db", () => ({
    prisma: { agentRepo: { findMany: (args: Record<string, unknown>) => findMany(args) } }
}));

const { repoOptionsInput, repoOptionsPage, firstRepoPage } =
    await import("@/lib/agents/repo-options");

const OWNER = "0190a000-0000-7000-8000-000000000001";
const row = (id: string, repoFullName: string) => ({ id, repoFullName });

beforeEach(() => findMany.mockReset());

describe("repoOptionsPage", () => {
    it("reads the owner's enabled repositories one page at a time, by name", async () => {
        findMany.mockResolvedValueOnce([row("a", "acme/api"), row("b", "acme/web")]);
        const page = await repoOptionsPage(
            OWNER,
            repoOptionsInput.parse({ limit: 1, query: " acme " })
        );
        const args = findMany.mock.calls[0]![0] as {
            where: unknown;
            take: number;
            orderBy: unknown;
        };
        expect(args.take).toBe(2);
        expect(args.orderBy).toEqual({ repoFullName: "asc" });
        expect(args.where).toEqual({
            ownerId: OWNER,
            enabled: true,
            repoFullName: { contains: "acme", mode: "insensitive" }
        });
        expect(page.items).toEqual([{ id: "a", name: "acme/api" }]);
        expect(page.next).not.toBeNull();

        findMany.mockResolvedValueOnce([row("b", "acme/web")]);
        const second = await repoOptionsPage(
            OWNER,
            repoOptionsInput.parse({ limit: 1, cursor: page.next })
        );
        const next = findMany.mock.calls[1]![0] as { where: Record<string, unknown> };
        expect(next.where.repoFullName).toEqual({ gt: "acme/api" });
        expect(second).toEqual({ items: [{ id: "b", name: "acme/web" }], next: null });
    });

    it("reads chosen repositories back by id, still only the owner's", async () => {
        const id = "0190a000-0000-7000-8000-000000000002";
        await repoOptionsPage(OWNER, repoOptionsInput.parse({ ids: [id] }));
        const args = findMany.mock.calls[0]![0] as { where: Record<string, unknown> };
        expect(args.where).toEqual({ ownerId: OWNER, enabled: true, id: { in: [id] } });
    });

    it("treats a cursor that is not one as the first page", async () => {
        await repoOptionsPage(OWNER, repoOptionsInput.parse({ cursor: "not-a-cursor" }));
        const args = findMany.mock.calls[0]![0] as { where: Record<string, unknown> };
        expect(args.where.repoFullName).toBeUndefined();
    });

    it("bounds the first page a dialog opens with", async () => {
        await firstRepoPage(OWNER);
        expect((findMany.mock.calls[0]![0] as { take: number }).take).toBe(51);
    });

    it("refuses a page larger than the picker asks for", () => {
        expect(repoOptionsInput.safeParse({ limit: 500 }).success).toBe(false);
        expect(repoOptionsInput.safeParse({ extra: 1 }).success).toBe(false);
    });
});
