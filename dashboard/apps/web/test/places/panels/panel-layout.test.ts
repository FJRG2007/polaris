/**
 * A wall panel's cards: what the schema lets through, how a drag moves and
 * resizes a card a cell at a time, and which devices a panel reaches.
 */

import { describe, expect, it } from "vitest";
import {
    PANEL_CARDS,
    addCard,
    moveCard,
    panelCardsSchema,
    panelDeviceIds,
    panelNameSchema,
    normalizePanelName,
    resizeCard,
    stackOrder,
    storedCards,
    type PanelCard
} from "@polaris-app/places/src/lib/panel-layout";

const LAMP = "00000000-0000-4000-8000-0000000000b1";
const PLUG = "00000000-0000-4000-8000-0000000000b2";
const ROOM = "00000000-0000-4000-8000-0000000000c1";

const lamp: PanelCard = { id: "a", type: "device", deviceId: LAMP, x: 0, y: 0, w: 3, h: 2 };
const room: PanelCard = { id: "b", type: "room", roomId: ROOM, x: 3, y: 0, w: 4, h: 3 };
const clock: PanelCard = { id: "c", type: "clock", x: 0, y: 2, w: 3, h: 2 };

describe("panel cards schema", () => {
    it("accepts cards that sit inside the grid without overlapping", () => {
        expect(panelCardsSchema.safeParse([lamp, room, clock]).success).toBe(true);
    });

    it("refuses overlapping cards, a card past the edge, a duplicate and a too-small card", () => {
        expect(panelCardsSchema.safeParse([lamp, { ...clock, y: 1 }]).success).toBe(false);
        expect(panelCardsSchema.safeParse([{ ...lamp, x: 10 }]).success).toBe(false);
        expect(panelCardsSchema.safeParse([lamp, { ...clock, id: "a" }]).success).toBe(false);
        expect(panelCardsSchema.safeParse([{ ...lamp, w: 1 }]).success).toBe(false);
    });

    it("refuses an unknown card type and a device id that is not one", () => {
        expect(panelCardsSchema.safeParse([{ ...clock, type: "weather" }]).success).toBe(false);
        expect(panelCardsSchema.safeParse([{ ...lamp, deviceId: "x" }]).success).toBe(false);
    });

    it("caps a panel's cards", () => {
        const many = Array.from({ length: PANEL_CARDS + 1 }, (_, i) => ({
            id: `c${i}`,
            type: "clock" as const,
            x: (i % 4) * 3,
            y: Math.floor(i / 4) * 1,
            w: 3,
            h: 1
        }));
        expect(panelCardsSchema.safeParse(many).success).toBe(false);
    });

    it("reads a stored row it does not understand as an empty panel", () => {
        expect(storedCards([{ id: "z", type: "weather" }])).toEqual([]);
        expect(storedCards(null)).toEqual([]);
        expect(storedCards([lamp])).toEqual([lamp]);
    });

    it("trims a name before checking it", () => {
        expect(normalizePanelName("  Hall   tablet ")).toBe("Hall tablet");
        expect(panelNameSchema.safeParse(normalizePanelName("   ")).success).toBe(false);
        expect(panelNameSchema.safeParse("x".repeat(61)).success).toBe(false);
    });
});

describe("arranging", () => {
    it("moves a card to a free cell and keeps it inside the grid", () => {
        const moved = moveCard([lamp, room], "a", 20, 5);
        expect(moved[0]).toMatchObject({ x: 9, y: 5 });
    });

    it("does not move a card on top of another", () => {
        const cards = [lamp, room];
        expect(moveCard(cards, "a", 3, 0)).toEqual(cards);
    });

    it("resizes within the card's minimum and the grid, and never over another card", () => {
        expect(resizeCard([lamp], "a", 1, 1)[0]).toMatchObject({ w: 2, h: 2 });
        expect(resizeCard([lamp], "a", 30, 3)[0]).toMatchObject({ w: 12, h: 3 });
        expect(resizeCard([lamp, room], "a", 5, 2)).toEqual([lamp, room]);
    });

    it("adds a card in the first free box, and nothing when the panel is full", () => {
        const added = addCard([lamp], { type: "device", deviceId: PLUG }, "n");
        expect(added[1]).toMatchObject({ id: "n", x: 3, y: 0, w: 3, h: 2 });
        const full = Array.from({ length: 4 * 24 }, (_, i) => ({
            id: `f${i}`,
            type: "clock" as const,
            x: (i % 4) * 3,
            y: Math.floor(i / 4) * 2,
            w: 3,
            h: 2
        })).slice(0, PANEL_CARDS);
        expect(addCard(full, { type: "clock" }, "n")).toHaveLength(PANEL_CARDS);
    });

    it("stacks cards on a phone in the order the wide grid reads", () => {
        expect(stackOrder([clock, room, lamp]).map((card) => card.id)).toEqual(["a", "b", "c"]);
    });
});

describe("what a panel reaches", () => {
    it("is its device cards and the devices in its rooms, nothing else", () => {
        const ids = panelDeviceIds([lamp, room, clock], new Map([[ROOM, [PLUG]]]));
        expect([...ids].sort()).toEqual([LAMP, PLUG]);
    });
});
