/**
 * How CRM values read on screen, and that every field, option and total has
 * its words in every language.
 */

import { describe, expect, it } from "vitest";
import { crmCatalogs } from "@polaris-app/crm/messages";
import { AGGREGATES } from "@polaris-app/crm/src/model/views";
import { CRM_OBJECTS, FIELDS } from "@polaris-app/crm/src/model/objects";
import { formatDay, formatMoney } from "@polaris-app/crm/src/screens/format";
import { createDisplayFormat, DISPLAY_DEFAULTS, LOCALES } from "@polaris/core";

describe("formatDay", () => {
    it("writes a stored day in the reader's order, never moved by a time zone", () => {
        const dmy = createDisplayFormat({
            ...DISPLAY_DEFAULTS,
            dateOrder: "dmy",
            timeZone: "America/Los_Angeles"
        });
        const mdy = createDisplayFormat({
            ...DISPLAY_DEFAULTS,
            dateOrder: "mdy",
            yearFormat: "yy"
        });
        expect(formatDay("2026-03-01", dmy)).toBe("01/03/2026");
        expect(formatDay("2026-03-01", mdy)).toBe("03/01/26");
    });
});

describe("formatMoney", () => {
    it("writes an amount in its own currency and nothing for none", () => {
        expect(formatMoney({ amount: 1200, currency: "USD" }, "en-US")).toBe("$1,200.00");
        expect(formatMoney({ amount: null, currency: "" }, "en-US")).toBe("");
    });
});

describe("the CRM's words", () => {
    it("name every field, stage and total in every language", () => {
        for (const locale of LOCALES) {
            const t = crmCatalogs.translator(locale, "crm");
            const missing: string[] = [];
            const check = (key: string) => {
                const text = t(key as Parameters<typeof t>[0]);
                if (!text || text === key) missing.push(`${locale}:${key}`);
            };
            for (const object of CRM_OBJECTS) {
                check(`objects.${object}.plural`);
                check(`objects.${object}.new`);
                check(`empty.${object}.title`);
                for (const field of FIELDS[object]) {
                    check(`fields.${object}.${field.key}`);
                    for (const option of field.options ?? [])
                        check(`options.${object}.${field.key}.${option}`);
                }
            }
            for (const aggregate of AGGREGATES) {
                check(`aggregates.short.${aggregate}`);
                check(`aggregates.long.${aggregate}`);
            }
            expect(missing).toEqual([]);
        }
    });
});
