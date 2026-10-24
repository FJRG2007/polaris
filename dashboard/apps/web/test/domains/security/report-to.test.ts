/**
 * The report address typed into the fix dialog, checked the same way on both
 * sides: trimmed and lowercased first, then it has to be an email address.
 */

import { describe, expect, it } from "vitest";
import { normalizeReportTo, reportToSchema } from "@/lib/domain-security/report-to";

describe("report address for DMARC", () => {
    it("is normalized before it is checked", () => {
        expect(normalizeReportTo("  Reports@Example.TEST ")).toBe("reports@example.test");
        expect(reportToSchema.parse("  Reports@Example.TEST ")).toBe("reports@example.test");
    });

    it("refuses what is not an email address", () => {
        expect(reportToSchema.safeParse("reports").success).toBe(false);
        expect(reportToSchema.safeParse("mailto:reports@example.test").success).toBe(false);
        expect(reportToSchema.safeParse(`${"a".repeat(250)}@example.test`).success).toBe(false);
    });

    it("is optional", () => {
        expect(reportToSchema.parse(null)).toBeNull();
        expect(reportToSchema.parse(undefined)).toBeUndefined();
    });
});
