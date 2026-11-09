import { describe, expect, it, vi } from "vitest";

vi.mock("@polaris/db", () => ({ prisma: {} }));
vi.mock("@/lib/setting-store", () => ({ getSetting: vi.fn(), setSetting: vi.fn() }));

const { choosePlacement, poolSchema } = await import("@/lib/agents/session-placement");

const A = "00000000-0000-4000-8000-00000000000a";
const B = "00000000-0000-4000-8000-00000000000b";
const C = "00000000-0000-4000-8000-00000000000c";
const D = "00000000-0000-4000-8000-00000000000d";

describe("placing a session on the pool", () => {
    it("answers undefined when every machine is full", () => {
        expect(
            choosePlacement(
                [
                    { hostId: null, ceiling: 2, live: 2 },
                    { hostId: A, ceiling: 1, live: 1 }
                ],
                undefined
            )
        ).toBeUndefined();
    });

    it("takes the least full machine, by share rather than by count", () => {
        const chosen = choosePlacement(
            [
                { hostId: null, ceiling: 4, live: 3 },
                { hostId: A, ceiling: 20, live: 5 },
                { hostId: B, ceiling: 2, live: 1 }
            ],
            undefined
        );
        expect(chosen).toBe(A);
    });

    it("keeps an account on the machine its home is on while that one has room", () => {
        const pool = [
            { hostId: null, ceiling: 10, live: 9 },
            { hostId: A, ceiling: 10, live: 0 }
        ];
        expect(choosePlacement(pool, null)).toBeNull();
        expect(choosePlacement([{ hostId: null, ceiling: 10, live: 10 }, pool[1]!], null)).toBe(A);
    });

    it("scores a sample of three, so a large pool is never scanned", () => {
        const pool = [A, B, C, D].map((hostId, i) => ({ hostId, ceiling: 10, live: i }));
        // These draws sample B, C and D - never A, the emptiest - and the best
        // of the three is taken.
        const draws = [0.3, 0.5, 0.6];
        const chosen = choosePlacement(pool, undefined, () => draws.shift() ?? 0);
        expect(chosen).toBe(B);
    });

    it("refuses a pool with nowhere to run", () => {
        expect(poolSchema.safeParse({ box: false, servers: [] }).success).toBe(false);
        expect(poolSchema.safeParse({ box: false, servers: [{ hostId: A, sessions: 5 }] }).success).toBe(true);
        expect(poolSchema.safeParse({ box: true, servers: [{ hostId: A, sessions: 0 }] }).success).toBe(false);
    });
});
