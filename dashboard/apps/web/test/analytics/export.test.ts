/**
 * The rows an analytics export writes: one line per event in a fixed column
 * order, a spreadsheet formula never let through, JSON with real nulls and
 * properties as an object, and no spreadsheet cell past what one can hold.
 */

import { describe, expect, it, vi } from "vitest";

vi.mock("@polaris/db", () => ({ prisma: {}, Prisma: {} }));

const exporting = await import("@/lib/analytics-export");

function event(overrides: Partial<exporting.ExportEvent> = {}): exporting.ExportEvent {
    return {
        at: new Date("2026-11-01T10:00:00.000Z"),
        sessionId: "visit-1",
        kind: "event",
        name: "signup",
        path: "/pricing",
        rawPath: "/pricing?plan=pro",
        props: JSON.stringify({ plan: "pro", seats: 3 }),
        session: {
            distinctId: null,
            browser: "Firefox",
            os: "Linux",
            device: "desktop",
            country: "ES",
            language: null,
            screen: null,
            referrerKind: "search",
            referrerSource: "example.test",
            campaign: null,
            medium: null
        },
        ...overrides
    };
}

describe("the analytics export", () => {
    it("writes one cell per column, in the header's order", () => {
        const cells = exporting.exportCells(event());
        expect(cells).toHaveLength(exporting.EXPORT_COLUMNS.length);
        expect(cells[exporting.EXPORT_COLUMNS.indexOf("url")]).toBe("/pricing?plan=pro");
        expect(cells[exporting.EXPORT_COLUMNS.indexOf("country")]).toBe("ES");
    });

    it("quotes CSV cells and never lets a formula through", () => {
        const line = exporting.csvLine(exporting.exportCells(event({ name: "=HYPERLINK(\"x\")" })));
        expect(line.endsWith("\n")).toBe(true);
        expect(line).toContain("\"'=HYPERLINK(\"\"x\"\")\"");
    });

    it("gives JSON nulls for absent values and properties as an object", () => {
        const record = exporting.exportRecord(event());
        expect(record.visitor).toBeNull();
        expect(record.campaign).toBeNull();
        expect(record.properties).toEqual({ plan: "pro", seats: 3 });
        expect(exporting.exportRecord(event({ props: null })).properties).toBeNull();
    });

    it("cuts a spreadsheet cell to what one can hold", () => {
        const cells = exporting.xlsxCells(event({ rawPath: `/${"a".repeat(40_000)}` }));
        expect(cells[exporting.EXPORT_COLUMNS.indexOf("url")]).toHaveLength(exporting.XLSX_CELL_MAX);
    });
});
