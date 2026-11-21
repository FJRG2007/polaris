/**
 * Account restriction for spam (ledger row 24): many different people blocking
 * or reporting one account in the window restricts it until `hours` after the
 * latest, one person counts once, and a switched-off policy restricts nobody.
 */

import { describe, expect, it, vi } from "vitest";

vi.mock("@polaris/db", () => ({ prisma: {} }));
vi.mock("@/lib/setting-store", () => ({ getSetting: vi.fn(async () => null), setSetting: vi.fn() }));

const { restrictionFrom } = await import("@/lib/chat/spam-restriction");

const NOW = new Date("2026-11-21T12:00:00Z");
const HOUR = 60 * 60 * 1000;
const policy = { enabled: true, threshold: 3, windowDays: 7, hours: 24 };
const at = (hoursAgo: number) => new Date(NOW.getTime() - hoursAgo * HOUR);

describe("spam restriction", () => {
    it("restricts once enough different people acted, until hours after the latest", () => {
        const result = restrictionFrom(
            [
                { by: "a", at: at(5) },
                { by: "b", at: at(3) },
                { by: "c", at: at(1) }
            ],
            policy,
            NOW
        );
        expect(result).toEqual({ until: new Date(at(1).getTime() + 24 * HOUR), people: 3 });
    });

    it("counts one person once, however often they acted", () => {
        const signals = [1, 2, 3, 4].map((hours) => ({ by: "a", at: at(hours) }));
        expect(restrictionFrom([...signals, { by: "b", at: at(1) }], policy, NOW)).toBeNull();
    });

    it("ignores what is older than the window, and lifts by itself", () => {
        const old = [
            { by: "a", at: at(24 * 8) },
            { by: "b", at: at(2) },
            { by: "c", at: at(1) }
        ];
        expect(restrictionFrom(old, policy, NOW)).toBeNull();
        const lifted = [
            { by: "a", at: at(30) },
            { by: "b", at: at(28) },
            { by: "c", at: at(25) }
        ];
        expect(restrictionFrom(lifted, policy, NOW)).toBeNull();
    });

    it("lets the action through when the lookup itself fails", async () => {
        const { requireUnrestricted } = await import("@/lib/chat/spam-restriction");
        const quiet = vi.spyOn(console, "error").mockImplementation(() => undefined);
        await expect(requireUnrestricted("u1")).resolves.toBeUndefined();
        quiet.mockRestore();
    });

    it("restricts nobody when the instance turned it off", () => {
        const many = ["a", "b", "c", "d"].map((by) => ({ by, at: at(1) }));
        expect(restrictionFrom(many, { ...policy, enabled: false }, NOW)).toBeNull();
    });
});
