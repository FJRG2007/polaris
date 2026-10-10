import { describe, expect, it } from "vitest";
import { relativeTime } from "@/lib/relative-time";
import { createDisplayFormat, resolveDisplayPreferences } from "@polaris/core";

const NOW = Date.UTC(2026, 2, 18, 10, 24, 0);
const DAY = 24 * 60 * 60_000;

function format(locale: "en-US" | "es-ES") {
    return createDisplayFormat(resolveDisplayPreferences(null, null, locale));
}

function ago(ms: number): string {
    return new Date(NOW - ms).toISOString();
}

describe("relativeTime", () => {
    it("writes the phrase in the reader's language", () => {
        expect(relativeTime(ago(DAY), format("en-US"), "-", NOW)).toBe("1d ago");
        expect(relativeTime(ago(DAY), format("es-ES"), "-", NOW)).toBe("hace 1 d");
        expect(relativeTime(ago(3 * DAY), format("es-ES"), "-", NOW)).toBe("hace 3 d");
    });

    it("never leaves an English word in a Spanish phrase, at any step", () => {
        for (const elapsed of [10_000, 5 * 60_000, 6 * 60 * 60_000, 2 * DAY, 30 * DAY]) {
            expect(relativeTime(ago(elapsed), format("es-ES"), "-", NOW)).not.toMatch(/ago|now/);
        }
    });
});
