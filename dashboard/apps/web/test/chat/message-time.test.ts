/**
 * The time on a message: a clock time, never "an hour ago", in the reader's own
 * format, with the day decided in the reader's own zone.
 */

import { describe, expect, it } from "vitest";
import { createDisplayFormat, DISPLAY_DEFAULTS } from "@polaris/core";
import { messageStamp } from "@/lib/chat/message-time";
import { relativeTime } from "@/lib/relative-time";
import { translate } from "@/lib/i18n/translate";

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

/** What the catalog says for yesterday, as the component hands it in. */
const yesterday = (time: string) => `Yesterday at ${time}`;

/** 17 September 2026, 18:00 in Madrid. */
const now = new Date("2026-09-17T16:00:00Z");

describe("messageStamp", () => {
    it("is the time alone for a message sent today", () => {
        expect(messageStamp(h24, "2026-09-17T12:05:00Z", yesterday, now)).toBe("14:05");
        expect(messageStamp(h12, "2026-09-17T12:05:00Z", yesterday, now)).toBe("2:05 PM");
    });

    it("says yesterday for yesterday", () => {
        expect(messageStamp(h24, "2026-09-16T12:05:00Z", yesterday, now)).toBe("Yesterday at 14:05");
    });

    it("carries the date for anything older", () => {
        expect(messageStamp(h24, "2026-09-10T12:05:00Z", yesterday, now)).toBe("10/09/2026 14:05");
    });

    it("decides the day in the reader's zone, not the server's", () => {
        // 23:30 UTC on the 16th is already half past one on the 17th in Madrid.
        expect(messageStamp(h24, "2026-09-16T23:30:00Z", yesterday, now)).toBe("01:30");
        // And ten past midnight in Madrid on the 17th is still the 16th in UTC.
        const utc = createDisplayFormat({ ...DISPLAY_DEFAULTS, clock: "24h", timeZone: "UTC" });
        expect(messageStamp(utc, "2026-09-16T23:30:00Z", yesterday, now)).toBe("Yesterday at 23:30");
    });

    it("never answers with a relative phrase or an invalid date", () => {
        expect(messageStamp(h24, "not a date", yesterday, now)).toBe("-");
        expect(messageStamp(h24, "2026-09-17T15:59:00Z", yesterday, now)).not.toMatch(/ago/);
    });
});

describe("the phrases in the reader's language", () => {
    const es = createDisplayFormat({ ...DISPLAY_DEFAULTS, language: "es-ES", clock: "24h", timeZone: zone });
    const en = createDisplayFormat({ ...DISPLAY_DEFAULTS, language: "en-US", clock: "24h", timeZone: zone });
    const at = now.getTime();

    it("says how long ago in Spanish for a Spanish reader", () => {
        expect(relativeTime("2026-09-17T15:57:00Z", es, "-", at)).toBe("hace 3 min");
        expect(relativeTime("2026-09-17T11:00:00Z", es, "-", at)).toBe("hace 5 h");
        expect(relativeTime("2026-09-17T15:59:30Z", es, "-", at)).toBe("ahora");
    });

    it("keeps the English shape for an English reader", () => {
        expect(relativeTime("2026-09-17T15:57:00Z", en, "-", at)).toBe("3m ago");
        expect(relativeTime("2026-09-16T15:00:00Z", en, "-", at)).toBe("1d ago");
    });

    it("says yesterday in the reader's words", () => {
        expect(
            messageStamp(es, "2026-09-16T12:05:00Z", (time) => translate("es-ES", "components.messageTime.yesterdayAt", { time }), now)
        ).toBe("Ayer a las 14:05");
    });
});
