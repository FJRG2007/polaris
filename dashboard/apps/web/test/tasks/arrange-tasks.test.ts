/**
 * Keeping the order a screen was showing.
 *
 * A view opens in the order the engine chose and writes nothing down until
 * somebody drags a task into place. That drag hands the whole arrangement over,
 * so the write has to re-space every row it was given - and only the rows the
 * person could actually reach, because the sequence arrives from the browser.
 */

import { beforeEach, describe, expect, it, vi } from "vitest";

const SPACE = "018f2b7a-0000-7000-8000-0000000000c1";
const LIST = "018f2b7a-0000-7000-8000-0000000000d1";

const findMany = vi.fn(async () => [] as { id: string }[]);
const update = vi.fn((args: { where: { id: string }; data: { order: number } }) => args);
const transaction = vi.fn(async (operations: unknown[]) => operations);

vi.mock("@polaris/db", () => ({
    prisma: {
        task: { findMany, update },
        $transaction: transaction
    }
}));

const { arrangeTasks } = await import("../../src/lib/tasks/task-service");

const REACH = { spaceIds: [SPACE], listIds: [LIST] };

describe("arranging tasks", () => {
    beforeEach(() => {
        vi.clearAllMocks();
    });

    it("re-spaces the sequence in the order it was given", async () => {
        findMany.mockResolvedValueOnce([{ id: "c" }, { id: "a" }, { id: "b" }]);
        const written = await arrangeTasks(REACH, ["b", "c", "a"]);

        expect(written).toBe(3);
        expect(update.mock.calls.map(([args]) => [args.where.id, args.data.order])).toEqual([
            ["b", 1024],
            ["c", 2048],
            ["a", 3072]
        ]);
    });

    it("drops the ids the caller cannot reach and keeps the rest in order", async () => {
        // The sequence arrives from the browser, so somebody else's task in the
        // middle of it must not be renumbered on the way past.
        findMany.mockResolvedValueOnce([{ id: "a" }, { id: "b" }]);
        const written = await arrangeTasks(REACH, ["a", "elsewhere", "b"]);

        expect(written).toBe(2);
        expect(update.mock.calls.map(([args]) => args.where.id)).toEqual(["a", "b"]);
    });

    it("writes nothing when none of them are in reach", async () => {
        findMany.mockResolvedValueOnce([]);
        expect(await arrangeTasks(REACH, ["a", "b"])).toBe(0);
        expect(transaction).not.toHaveBeenCalled();
    });
});
