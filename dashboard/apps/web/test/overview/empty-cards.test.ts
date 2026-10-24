/**
 * Which Overview cards count as empty, and the cookie that carries the answer to
 * the next visit's first paint.
 */

import { describe, expect, it } from "vitest";
import * as cards from "@/lib/overview/empty-cards";

describe("empty Overview cards", () => {
    it("counts only cards read successfully and found empty", () => {
        const empty = cards.emptyOverviewCards(
            {
                alarms: { firing: 0, events: [] },
                tasks: null,
                storage: [],
                usage: [
                    {
                        id: "a",
                        name: "a",
                        cpuPercent: 1,
                        memUsedBytes: null,
                        memTotalBytes: null,
                        spark: [],
                        href: "/"
                    }
                ]
            },
            { shortcuts: 0, apps: 2 }
        );
        expect([...empty].sort()).toEqual(["alarms", "shortcuts", "storage"]);
    });

    it("does not count an alarm card with history as empty", () => {
        const empty = cards.emptyOverviewCards(
            {
                alarms: {
                    firing: 0,
                    events: [{ id: "e", name: "n", kind: "k", detail: null, createdAt: "" }]
                }
            },
            { shortcuts: 1, apps: 1 }
        );
        expect(empty.size).toBe(0);
    });

    it("reads back only real card ids from the cookie", () => {
        expect(cards.parseEmptyCardsCookie("alarms%2Ctasks%2Cnope%2Calarms")).toEqual([
            "alarms",
            "tasks"
        ]);
        expect(cards.parseEmptyCardsCookie("%E0%A4%A")).toEqual([]);
        expect(cards.parseEmptyCardsCookie(undefined)).toEqual([]);
    });
});
