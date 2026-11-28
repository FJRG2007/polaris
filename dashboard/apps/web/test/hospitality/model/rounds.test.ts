/**
 * "Otra ronda": the last send comes back as drafts at today's menu, never a
 * voided line, a product since sold out, or an earlier round.
 */

import { describe, expect, it } from "vitest";
import { lastRound, repeatRound } from "@polaris-app/hospitality/src/model/rounds";

const line = (productId: string, sentAt: string | null, extra: Partial<{ status: string; quantity: number; modifiers: { name: string }[] }> = {}) => ({
    productId,
    quantity: extra.quantity ?? 1,
    course: 0,
    note: "",
    status: extra.status ?? (sentAt ? "sent" : "pending"),
    sentAt,
    modifiers: extra.modifiers ?? []
});

const beer = { id: "beer", available: true, modifiers: [{ id: "g", min: 0, max: 1, options: [{ id: "o-lemon", name: "Lemon", price: 0 }] }] };
const wine = { id: "wine", available: false, modifiers: [] };
const water = { id: "water", available: true, modifiers: [] };

describe("hospitality repeat round", () => {
    const first = "2026-11-28T20:00:00.000Z";
    const second = "2026-11-28T20:30:00.000Z";

    it("takes only the latest send, without voided or pending lines", () => {
        const lines = [line("water", first), line("beer", second), line("beer", second, { status: "void" }), line("water", null)];
        expect(lastRound(lines).map((l) => l.productId)).toEqual(["beer"]);
    });

    it("is empty before anything was sent", () => {
        expect(lastRound([line("water", null)])).toEqual([]);
        expect(repeatRound([], [beer])).toEqual({ lines: [], missing: 0 });
    });

    it("keeps quantities and options, and counts what left the menu", () => {
        const lines = [line("beer", second, { quantity: 3, modifiers: [{ name: "Lemon" }] }), line("wine", second), line("gone", second)];
        const round = repeatRound(lines, [beer, wine, water]);
        expect(round.missing).toBe(2);
        expect(round.lines).toEqual([{ product: beer, quantity: 3, course: 0, note: "", modifierIds: ["o-lemon"] }]);
    });
});

describe("hospitality most sold first", () => {
    it("puts best sellers first and keeps the menu order on ties", async () => {
        const { mostSoldFirst } = await import("@polaris-app/hospitality/src/model/rounds");
        const menu = [
            { id: "a", sold: 0 },
            { id: "b", sold: 5 },
            { id: "c", sold: 0 },
            { id: "d", sold: 9 }
        ];
        expect(mostSoldFirst(menu).map((p) => p.id)).toEqual(["d", "b", "a", "c"]);
        expect(mostSoldFirst(menu.map((p) => ({ ...p, sold: 0 }))).map((p) => p.id)).toEqual(["a", "b", "c", "d"]);
    });
});
