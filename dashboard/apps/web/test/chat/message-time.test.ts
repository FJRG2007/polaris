/**
 * The time on a message: a clock time, never "an hour ago", in the reader's own
 * format, with the day decided in the reader's own zone.
 */

import { describe, expect, it } from "vitest";
import { createDisplayFormat, DISPLAY_DEFAULTS } from "@polaris/core";
import { messageStamp } from "@/lib/chat/message-time";

const zone = "Europe/Madrid";
const h24 = createDisplayFormat({
    ...DISPLAY_DEFAULTS,
    clock: "24h",
    dateOrder: "dmy",
    timeZone: zone
});
const h12 = createDisplayFormat({
    ...DISPLAY_DEFAULTS,
    clock: "12h",
    dateOrder: "dmy",
    timeZone: zone
});

/** 17 September 2026, 18:00 in Madrid. */
const now = new Date("2026-09-17T16:00:00Z");

describe("messageStamp", () => {
    it("is the time alone for a message sent today", () => {
        expect(messageStamp(h24, "2026-09-17T12:05:00Z", now)).toBe("14:05");
        expect(messageStamp(h12, "2026-09-17T12:05:00Z", now)).toBe("2:05 PM");
    });

    it("says yesterday for yesterday", () => {
        expect(messageStamp(h24, "2026-09-16T12:05:00Z", now)).toBe("Yesterday at 14:05");
    });

    it("carries the date for anything older", () => {
        expect(messageStamp(h24, "2026-09-10T12:05:00Z", now)).toBe("10/09/2026 14:05");
    });

    it("decides the day in the reader's zone, not the server's", () => {
        // 23:30 UTC on the 16th is already half past one on the 17th in Madrid.
        expect(messageStamp(h24, "2026-09-16T23:30:00Z", now)).toBe("01:30");
        // And ten past midnight in Madrid on the 17th is still the 16th in UTC.
        const utc = createDisplayFormat({ ...DISPLAY_DEFAULTS, clock: "24h", timeZone: "UTC" });
        expect(messageStamp(utc, "2026-09-16T23:30:00Z", now)).toBe("Yesterday at 23:30");
    });

    it("never answers with a relative phrase or an invalid date", () => {
        expect(messageStamp(h24, "not a date", now)).toBe("-");
        expect(messageStamp(h24, "2026-09-17T15:59:00Z", now)).not.toMatch(/ago/);
    });
});
