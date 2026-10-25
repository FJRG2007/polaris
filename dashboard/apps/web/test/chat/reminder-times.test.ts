/**
 * What each reminder preset means, on the reader's own clock.
 */

import { describe, expect, it } from "vitest";
import { reminderMoment } from "@/app/(app)/chat/reminder-times";

// A Wednesday, ten past three in the afternoon in Madrid (UTC+2 in September).
const NOW = new Date("2026-09-02T13:10:00Z");
const ZONE = "Europe/Madrid";

describe("reminder presets", () => {
    it("waits the time it names", () => {
        expect(reminderMoment("in15Minutes", NOW, ZONE).toISOString()).toBe(
            "2026-09-02T13:25:00.000Z"
        );
        expect(reminderMoment("in1Hour", NOW, ZONE).toISOString()).toBe(
            "2026-09-02T14:10:00.000Z"
        );
        expect(reminderMoment("in3Hours", NOW, ZONE).toISOString()).toBe(
            "2026-09-02T16:10:00.000Z"
        );
    });

    it("puts tomorrow at nine where the reader lives", () => {
        expect(reminderMoment("tomorrow", NOW, ZONE).toISOString()).toBe(
            "2026-09-03T07:00:00.000Z"
        );
    });

    it("puts next Monday at nine, never today", () => {
        expect(reminderMoment("nextMonday", NOW, ZONE).toISOString()).toBe(
            "2026-09-07T07:00:00.000Z"
        );
        // On a Monday it is the Monday after.
        const monday = new Date("2026-09-07T10:00:00Z");
        expect(reminderMoment("nextMonday", monday, ZONE).toISOString()).toBe(
            "2026-09-14T07:00:00.000Z"
        );
    });
});
