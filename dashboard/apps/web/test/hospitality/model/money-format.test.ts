/**
 * Hospitality writes money and rates through the reader's Polaris display
 * preferences, while an amount keeps its venue's currency and that currency's
 * own decimals.
 */

import { describe, expect, it } from "vitest";
import { createDisplayFormat, DISPLAY_DEFAULTS } from "@polaris/core";
import { formatMoney, formatRate, typedAmount } from "@polaris-app/hospitality/src/model/money-format";

const spanish = createDisplayFormat({ ...DISPLAY_DEFAULTS, language: "es-ES", currency: "USD" });
const english = createDisplayFormat({ ...DISPLAY_DEFAULTS, language: "en-US", currency: "EUR" });
const plain = (text: string) => text.replace(/\s/g, " ");

describe("hospitality money and rates follow display preferences", () => {
    it("writes the venue's currency in the reader's language, not the reader's preferred currency", () => {
        expect(plain(formatMoney(spanish, 123450, "EUR"))).toBe("1234,50 €");
        expect(formatMoney(english, 123450, "EUR")).toBe("€1,234.50");
    });

    it("keeps the currency's own minor units", () => {
        expect(formatMoney(english, 120000, "JPY")).toBe("¥1,200");
        expect(formatMoney(english, 199, "USD")).toBe("$1.99");
    });

    it("writes basis points as a percent with the reader's separators", () => {
        expect(plain(formatRate(spanish, 1000))).toBe("10 %");
        expect(formatRate(english, 550)).toBe("5.5%");
        expect(plain(formatRate(spanish, 550))).toBe("5,5 %");
    });

    it("gives an amount back for a field in the reader's decimal mark, without grouping", () => {
        expect(typedAmount(spanish, 123450)).toBe("1234,50");
        expect(typedAmount(english, 123450)).toBe("1234.50");
    });
});
