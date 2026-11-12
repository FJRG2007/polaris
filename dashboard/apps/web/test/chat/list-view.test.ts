/** The detailed conversation list: when it is drawn, and how it says when. */

import { describe, expect, it } from "vitest";
import {
    autoDetailed,
    COMPACT_PANE,
    DETAILED_HYSTERESIS,
    DETAILED_FROM,
    DETAILED_PANE,
    drawsDetailed,
    isChatListView,
    listTime,
    paneWidthFor
} from "@/app/(app)/chat/list-view";

const now = new Date(2026, 10, 5, 15, 30);
const at = (days: number, hour = 9, minute = 5) =>
    new Date(2026, 10, 5 - days, hour, minute).toISOString();

describe("the list view setting", () => {
    it("draws detailed rows under auto only from the threshold", () => {
        expect(drawsDetailed("auto", DETAILED_FROM - 1)).toBe(false);
        expect(drawsDetailed("auto", DETAILED_FROM)).toBe(true);
    });

    it("holds compact and detailed whatever the width", () => {
        expect(drawsDetailed("compact", 2000)).toBe(false);
        expect(drawsDetailed("detailed", 0)).toBe(true);
    });

    it("accepts only the three values", () => {
        expect(["auto", "compact", "detailed"].every(isChatListView)).toBe(true);
        expect(isChatListView("wide")).toBe(false);
        expect(isChatListView(null)).toBe(false);
    });
});

describe("auto at the edge", () => {
    it("goes detailed at the threshold and stays so through a scrollbar's width", () => {
        expect(autoDetailed(false, DETAILED_FROM - 1)).toBe(false);
        expect(autoDetailed(false, DETAILED_FROM)).toBe(true);
        // The detailed rows bring a scrollbar in, 17 px at most on a desktop.
        expect(autoDetailed(true, DETAILED_FROM - 17)).toBe(true);
        expect(autoDetailed(true, DETAILED_FROM - DETAILED_HYSTERESIS - 1)).toBe(false);
    });

    it("settles instead of flipping when its own scrollbar narrows it", () => {
        // Detailed rows overflow and take 10 px; compact ones fit and give it back.
        const pane = DETAILED_FROM + 4;
        let detailed = false;
        const seen: boolean[] = [];
        for (let frame = 0; frame < 10; frame += 1) {
            detailed = autoDetailed(detailed, detailed ? pane - 10 : pane);
            seen.push(detailed);
        }
        expect(new Set(seen.slice(1)).size).toBe(1);
    });
});

describe("listTime", () => {
    it("is the time of day today", () => {
        expect(listTime(at(0), now, "en-US", "Yesterday")).toBe("09:05");
    });

    it("is Yesterday the day before, even after midnight", () => {
        expect(listTime(at(1, 23, 59), now, "en-US", "Yesterday")).toBe("Yesterday");
    });

    it("is the weekday within the week", () => {
        expect(listTime(at(3), now, "en-US", "Yesterday")).toBe("Monday");
        expect(listTime(at(6), now, "es-ES", "Ayer")).toBe("viernes");
    });

    it("is the date from a week back", () => {
        expect(listTime(at(7), now, "en-US", "Yesterday")).toBe("10/29/26");
    });
});

describe("paneWidthFor", () => {
    it("widens a narrow pane for the detailed rows, held to the window", () => {
        expect(paneWidthFor("detailed", 256, 560)).toBe(DETAILED_PANE);
        expect(paneWidthFor("detailed", 256, 300)).toBe(300);
        expect(paneWidthFor("detailed", 400, 560)).toBeNull();
    });

    it("gives the room back for compact rows and leaves auto alone", () => {
        expect(paneWidthFor("compact", 400, 560)).toBe(COMPACT_PANE);
        expect(paneWidthFor("compact", 220, 560)).toBeNull();
        expect(paneWidthFor("auto", 220, 560)).toBeNull();
    });
});
