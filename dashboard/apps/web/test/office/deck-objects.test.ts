/**
 * Tables and charts on a slide.
 *
 * Pinned around what goes wrong quietly: a cell somebody else typed lost when
 * another is written, a table that grows off the slide when it gains a column,
 * a stored table or chart half-made by an older or hostile writer that stops
 * the slide drawing, a number typed the Spanish way read as nothing, and an
 * axis that does not hold the values it labels.
 */

import * as Y from "yjs";
import JSZip from "jszip";
import * as deck from "@/lib/office/deck";
import { describe, expect, it } from "vitest";
import * as tables from "@/lib/office/slide-table";
import * as charts from "@/lib/office/slide-chart";
import * as edits from "@/app/(app)/office/p/[id]/deck-edits";
import { exportDocument } from "@/lib/office/export";

const sum = (values: readonly number[]): number => values.reduce((all, one) => all + one, 0);

describe("a table", () => {
    it("starts empty with a header row and even columns", () => {
        const table = tables.newTable(3, 4);
        expect(table.rows).toHaveLength(3);
        expect(
            table.rows.every((row) => row.length === 4 && row.every((cell) => cell === ""))
        ).toBe(true);
        expect(table.header).toBe(true);
        expect(sum(table.cols)).toBeCloseTo(1);
    });

    it("is never larger than the limit, nor smaller than one cell", () => {
        expect(tables.newTable(99, 0).rows).toHaveLength(tables.TABLE_MAX);
        expect(tables.newTable(99, 0).cols).toHaveLength(1);
    });

    it("keeps its width when it gains or loses a column", () => {
        let table = tables.newTable(2, 2);
        table = tables.insertCol(table, 1);
        expect(table.cols).toHaveLength(3);
        expect(sum(table.cols)).toBeCloseTo(1);
        expect(table.rows.every((row) => row.length === 3)).toBe(true);
        table = tables.removeCol(table, 0);
        expect(sum(table.cols)).toBeCloseTo(1);
    });

    it("keeps the words of the rows around one put in or taken out", () => {
        let table = tables.setCell(tables.newTable(2, 2), { row: 1, col: 0 }, "kept");
        table = tables.insertRow(table, 1);
        expect(table.rows[2]?.[0]).toBe("kept");
        expect(table.rows[1]).toEqual(["", ""]);
        table = tables.removeRow(table, 1);
        expect(table.rows[1]?.[0]).toBe("kept");
    });

    it("never loses its last row or column", () => {
        const one = tables.newTable(1, 1);
        expect(tables.removeRow(one, 0)).toBe(one);
        expect(tables.removeCol(one, 0)).toBe(one);
    });

    it("trades width between the two columns of a dragged border, no narrower than the least", () => {
        const table = tables.newTable(1, 3);
        const wider = tables.resizeCol(table, 0, 0.1);
        expect(wider.cols[0]).toBeCloseTo(1 / 3 + 0.1);
        expect(wider.cols[1]).toBeCloseTo(1 / 3 - 0.1);
        expect(wider.cols[2]).toBeCloseTo(1 / 3);
        const squeezed = tables.resizeCol(table, 0, 5);
        expect(squeezed.cols[1]).toBeCloseTo(tables.COLUMN_MIN);
        expect(sum(squeezed.cols)).toBeCloseTo(1);
    });

    it("moves Tab along the row, then down, and grows past the last cell", () => {
        const table = tables.newTable(2, 2);
        expect(tables.nextCell(table, { row: 0, col: 0 }, false)).toEqual({ row: 0, col: 1 });
        expect(tables.nextCell(table, { row: 0, col: 1 }, false)).toEqual({ row: 1, col: 0 });
        expect(tables.nextCell(table, { row: 1, col: 1 }, false)).toBe("grow");
        expect(tables.nextCell(table, { row: 0, col: 0 }, true)).toBeNull();
    });

    it("is read whole from anything stored", () => {
        const read = tables.readTable({ rows: [["a", 3], ["b"]], cols: [2, -1], header: false });
        expect(read.rows).toEqual([
            ["a", ""],
            ["b", ""]
        ]);
        expect(sum(read.cols)).toBeCloseTo(1);
        expect(read.cols.every((one) => one > 0)).toBe(true);
        expect(read.header).toBe(false);
        expect(tables.readTable("nonsense").rows).toEqual([[""]]);
    });

    it("reads as its cells, a row to a line", () => {
        let table = tables.newTable(2, 2);
        table = tables.setCell(table, { row: 0, col: 0 }, "Name");
        table = tables.setCell(table, { row: 0, col: 1 }, "Age");
        table = tables.setCell(table, { row: 1, col: 0 }, "Ada");
        expect(tables.tableText(table)).toBe("Name\tAge\nAda\t");
    });
});

describe("a table in the deck", () => {
    it("writes one cell over the table as it is now, keeping a cell somebody else typed", () => {
        const doc = new Y.Doc();
        edits.addSlide(doc, 0);
        const slideId = edits.slidesOf(doc).get(0).id;
        const id = edits.addTable(doc, slideId, 2, 2);
        // Somebody else's cell, arriving from elsewhere.
        const key = deck.boxKey(slideId, id);
        const stored = deck.readBox(edits.boxesOf(doc).get(key));
        edits.boxesOf(doc).set(key, {
            ...stored,
            table: tables.setCell(stored.table!, { row: 1, col: 1 }, "theirs"),
            version: stored.version + 1
        });
        edits.setCell(doc, slideId, id, { row: 0, col: 0 }, "mine");
        const table = deck.readBox(edits.boxesOf(doc).get(key)).table!;
        expect(table.rows[0]?.[0]).toBe("mine");
        expect(table.rows[1]?.[1]).toBe("theirs");
    });

    it("leaves in a PowerPoint export with its cells' words", async () => {
        const doc = new Y.Doc();
        edits.addSlide(doc, 0);
        const slideId = edits.slidesOf(doc).get(0).id;
        const id = edits.addTable(doc, slideId, 1, 2);
        edits.setCell(doc, slideId, id, { row: 0, col: 0 }, "Revenue");
        edits.setCell(doc, slideId, id, { row: 0, col: 1 }, "Margin");
        const out = await exportDocument("slides", "Deck", Y.encodeStateAsUpdate(doc), "pptx");
        const zip = await JSZip.loadAsync(out?.bytes ?? new Uint8Array());
        const slide = (await zip.file("ppt/slides/slide1.xml")?.async("string")) ?? "";
        expect(slide).toContain("Revenue");
        expect(slide).toContain("Margin");
    });

    it("writes nothing when a cell already says that", () => {
        const doc = new Y.Doc();
        edits.addSlide(doc, 0);
        const slideId = edits.slidesOf(doc).get(0).id;
        const id = edits.addTable(doc, slideId, 1, 1);
        const before = deck.readBox(edits.boxesOf(doc).get(deck.boxKey(slideId, id))).version;
        edits.setCell(doc, slideId, id, { row: 0, col: 0 }, "");
        expect(deck.readBox(edits.boxesOf(doc).get(deck.boxKey(slideId, id))).version).toBe(before);
    });

    it("is filled in the theme's accent", () => {
        const doc = new Y.Doc();
        edits.setTheme(doc, deck.THEMES.ocean);
        edits.addSlide(doc, 0);
        const slideId = edits.slidesOf(doc).get(0).id;
        const id = edits.addTable(doc, slideId, 2, 2);
        expect(deck.readBox(edits.boxesOf(doc).get(deck.boxKey(slideId, id))).fill).toBe(
            deck.THEMES.ocean.accent
        );
    });

    it("travels on the clipboard with its cells, and a chart with its numbers", () => {
        let table = tables.newTable(2, 2);
        table = tables.setCell(table, { row: 0, col: 1 }, "B");
        const tableBox = { ...deck.newTableBox("t", 2, 2, "#123456"), table };
        const chartBox = deck.newChartBox(
            "c",
            charts.sampleChart("line", { category: (n) => `C${n}`, series: (n) => `S${n}` })
        );
        let next = 0;
        const pasted = deck.readClipboard(
            deck.writeClipboard([tableBox, chartBox]),
            () => `n${next++}`
        );
        expect(pasted[0]?.table?.rows[0]?.[1]).toBe("B");
        expect(pasted[1]?.chart?.kind).toBe("line");
        expect(pasted[1]?.chart?.series[0]?.values).toEqual([4.3, 2.5, 3.5, 4.5]);
    });

    it("is read in the excerpt as its words", () => {
        const doc = new Y.Doc();
        edits.addSlide(doc, 0, "blank");
        const slideId = edits.slidesOf(doc).get(0).id;
        const id = edits.addTable(doc, slideId, 1, 2);
        edits.setCell(doc, slideId, id, { row: 0, col: 1 }, "words");
        const text = deck.deckText(
            edits.slidesOf(doc).toArray(),
            new Map(edits.boxesOf(doc).entries())
        );
        expect(text[0]).toBe("\twords");
    });
});

describe("a chart", () => {
    it("is read whole from anything stored", () => {
        const read = charts.readChart({
            kind: "radar",
            categories: ["a", "b"],
            series: [{ name: "s", values: [1, "x"] }]
        });
        expect(read.kind).toBe("column");
        expect(read.series[0]?.values).toEqual([1, 0]);
        expect(charts.readChart(null).categories).toEqual([""]);
    });

    it("never holds more series than it has colours", () => {
        const many = Array.from({ length: 20 }, (_, at) => ({ name: `${at}`, values: [at] }));
        expect(charts.readChart({ categories: ["a"], series: many }).series).toHaveLength(
            charts.SERIES_MAX
        );
        expect(charts.SERIES_COLORS.light).toHaveLength(charts.SERIES_MAX);
    });

    it("takes its series colours by place, stepped for a dark slide", () => {
        expect(charts.seriesColor(0, "#ffffff")).toBe(charts.SERIES_COLORS.light[0]);
        expect(charts.seriesColor(1, "#0b3954")).toBe(charts.SERIES_COLORS.dark[1]);
    });

    it("reads a number typed either way", () => {
        expect(charts.parseValue("1,5")).toBe(1.5);
        expect(charts.parseValue("1.5")).toBe(1.5);
        expect(charts.parseValue("1,234.5")).toBe(1234.5);
        expect(charts.parseValue("1,234,567")).toBe(1234567);
        expect(charts.parseValue("-3")).toBe(-3);
        expect(charts.parseValue("")).toBe(0);
        expect(charts.parseValue("twelve")).toBeNull();
        expect(charts.parseValue("1e400")).toBeNull();
    });

    it("has an axis of round numbers that holds every value and zero", () => {
        expect(charts.axisTicks([4.3, 2.5, 3.5])).toEqual([0, 1, 2, 3, 4, 5]);
        const negative = charts.axisTicks([-7, 12]);
        expect(negative[0]).toBeLessThanOrEqual(-7);
        expect(negative[negative.length - 1]).toBeGreaterThanOrEqual(12);
        expect(negative).toContain(0);
        expect(charts.axisTicks([0.1, 0.3])).toEqual([0, 0.1, 0.2, 0.3]);
    });

    it("lays its columns out inside the plot, standing on zero", () => {
        const chart = charts.sampleChart("column", {
            category: (n) => `C${n}`,
            series: (n) => `S${n}`
        });
        const layout = charts.chartLayout(chart, 900, 500, 20);
        expect(layout.bars).toHaveLength(12);
        for (const bar of layout.bars) {
            expect(bar.x).toBeGreaterThanOrEqual(layout.plot.x - 1e-6);
            expect(bar.x + bar.w).toBeLessThanOrEqual(layout.plot.x + layout.plot.w + 1e-6);
            expect(bar.y + bar.h).toBeCloseTo(layout.plot.y + layout.plot.h);
        }
        expect(layout.legend.map((item) => item.label)).toEqual(["S1", "S2", "S3"]);
    });

    it("draws a pie's slices to the whole and labels each with its share", () => {
        const chart = {
            ...charts.sampleChart("pie", { category: (n) => `C${n}`, series: (n) => `S${n}` })
        };
        const layout = charts.chartLayout(chart, 600, 400, 20);
        expect(layout.slices).toHaveLength(4);
        expect(sum(layout.slices.map((slice) => slice.share))).toBeCloseTo(1);
        expect(layout.valueLabels.map((label) => label.text)).toEqual(["29%", "17%", "24%", "30%"]);
        // A pie's key names its categories.
        expect(layout.legend.map((item) => item.label)).toEqual(["C1", "C2", "C3", "C4"]);
    });

    it("folds a pie's categories past its colours into one last slice", () => {
        const categories = Array.from({ length: 12 }, (_, at) => `C${at + 1}`);
        const chart = charts.readChart({
            kind: "pie",
            categories,
            series: [{ name: "s", values: categories.map(() => 1) }]
        });
        const layout = charts.chartLayout(chart, 600, 400, 20, undefined, "Other");
        expect(layout.slices).toHaveLength(charts.SERIES_MAX);
        expect(new Set(layout.slices.map((slice) => slice.category)).size).toBe(charts.SERIES_MAX);
        expect(layout.slices.at(-1)?.value).toBe(5);
        expect(layout.legend.map((item) => item.label)).toEqual([
            ...categories.slice(0, charts.SERIES_MAX - 1),
            "Other"
        ]);
    });

    it("shows no key for a single series", () => {
        const one = charts.readChart({
            kind: "line",
            categories: ["a"],
            series: [{ name: "s", values: [1] }]
        });
        expect(charts.showsLegend(one)).toBe(false);
        expect(charts.chartLayout(one, 500, 300, 20).legend).toEqual([]);
    });

    it("is not rewritten when it is saved unchanged", () => {
        const doc = new Y.Doc();
        edits.addSlide(doc, 0);
        const slideId = edits.slidesOf(doc).get(0).id;
        const chart = charts.sampleChart("bar", {
            category: (n) => `C${n}`,
            series: (n) => `S${n}`
        });
        const id = edits.addChart(doc, slideId, chart);
        const key = deck.boxKey(slideId, id);
        const before = deck.readBox(edits.boxesOf(doc).get(key)).version;
        edits.setChart(doc, slideId, id, charts.readChart(chart));
        expect(deck.readBox(edits.boxesOf(doc).get(key)).version).toBe(before);
        edits.setChart(doc, slideId, id, { ...chart, legend: false });
        expect(deck.readBox(edits.boxesOf(doc).get(key)).version).toBe(before + 1);
    });
});
