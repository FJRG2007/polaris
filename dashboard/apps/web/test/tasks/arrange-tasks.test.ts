/**
 * Keeping the order a screen was showing.
 *
 * A view opens in the order the engine chose and writes nothing down until
 * somebody drags a task into place. That drag hands the whole arrangement over,
 * so the write re-spaces the sequence it was given - and only the rows whose
 * place in it actually changed, because a drop moves one card past a few others
 * and the rest of the list is already where it is being told to sit.
 */

import { beforeEach, describe, expect, it, vi } from "vitest";

const findMany = vi.fn(async () => [] as { id: string; order: number }[]);
const update = vi.fn((args: { where: { id: string }; data: { order: number } }) => args);
const transaction = vi.fn(async (operations: unknown[]) => operations);

vi.mock("@polaris/db", () => ({
    prisma: {
        task: { findMany, update },
        $transaction: transaction
    }
}));

const { arrangeTasks } = await import("../../src/lib/tasks/task-service");

describe("arranging tasks", () => {
    beforeEach(() => {
        vi.clearAllMocks();
    });

    it("re-spaces the sequence in the order it was given", async () => {
        findMany.mockResolvedValueOnce([
            { id: "c", order: 1 },
            { id: "a", order: 2 },
            { id: "b", order: 3 }
        ]);
        const written = await arrangeTasks(["b", "c", "a"]);

        expect(written).toBe(3);
        expect(update.mock.calls.map(([args]) => [args.where.id, args.data.order])).toEqual([
            ["b", 1024],
            ["c", 2048],
            ["a", 3072]
        ]);
    });

    it("leaves alone the rows already sitting where the sequence puts them", async () => {
        findMany.mockResolvedValueOnce([
            { id: "a", order: 1024 },
            { id: "b", order: 5 },
            { id: "c", order: 3072 }
        ]);
        const written = await arrangeTasks(["a", "b", "c"]);

        expect(written).toBe(1);
        expect(update.mock.calls.map(([args]) => [args.where.id, args.data.order])).toEqual([["b", 2048]]);
    });

    it("skips an id that no longer exists rather than writing to nothing", async () => {
        // The sequence is whatever a screen was showing, so a row deleted since
        // it loaded can still arrive in the middle of it.
        findMany.mockResolvedValueOnce([
            { id: "a", order: 1 },
            { id: "b", order: 2 }
        ]);
        const written = await arrangeTasks(["a", "gone", "b"]);

        expect(written).toBe(2);
        expect(update.mock.calls.map(([args]) => [args.where.id, args.data.order])).toEqual([
            ["a", 1024],
            ["b", 3072]
        ]);
    });

    it("writes nothing when the order it was given is the order already held", async () => {
        findMany.mockResolvedValueOnce([
            { id: "a", order: 1024 },
            { id: "b", order: 2048 }
        ]);
        expect(await arrangeTasks(["a", "b"])).toBe(0);
        expect(transaction).not.toHaveBeenCalled();
    });
});
