/** The detailed conversation list: when it is drawn, and how it says when. */

import { describe, expect, it } from "vitest";
import { DETAILED_FROM, drawsDetailed, isChatListView, listTime } from "@/app/(app)/chat/list-view";

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
