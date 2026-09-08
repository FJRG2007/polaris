/**
 * The spreadsheet engine's other half: everything a workbook can do that the
 * grid itself does not.
 *
 * **Ported from GenOffice** (github.com/genspark-ai/genoffice, Apache-2.0 - see
 * `NOTICE` at the root of this repository). Polaris' spreadsheet is built on
 * Univer, whose open edition ships the grid, the formulas and the formatting and
 * deliberately does not ship pivot tables, charts, flash fill or range sorting -
 * those are what its makers sell. GenOffice had written exactly those, as pure
 * TypeScript with no framework in it, under a licence that lets them be used.
 *
 * So they are here rather than reimplemented, and rather than bought:
 *
 * - **cell-address** - A1 notation both ways, ranges, spans. Everything below
 *   speaks it, and Polaris had none of it.
 * - **workbook-dsl** and **in-memory-workbook** - a workbook as a value, with
 *   the structural operations (insert, delete, move) applied to it. What lets
 *   any of this be tested without a grid on a screen.
 * - **formula-shift** - what happens to `=B2+C2` when a row is inserted above
 *   it. The part everybody gets wrong.
 * - **pivot-engine** and its five companions - grouping, filters, calculated
 *   fields, timelines, and the chart a pivot draws.
 * - **chart-recommend** and **chart-visual** - which chart suits a selection,
 *   and what it looks like.
 * - **flash-fill** - the Excel trick of inferring what somebody is doing from
 *   two examples of them doing it.
 * - **sort-range** - sorting part of a sheet without moving what is outside it.
 *
 * All of it is pure. Nothing here reaches a database, a network or a canvas,
 * which is what makes it testable and what made it portable in the first place.
 */

export * from "./cell-address.js";
export * from "./chart-recommend.js";
export * from "./chart-visual.js";
export * from "./flash-fill.js";
export * from "./formula-shift.js";
export * from "./in-memory-workbook.js";
export * from "./pivot-chart.js";
export * from "./pivot-engine.js";
export * from "./pivot-filters.js";
export * from "./pivot-formula.js";
export * from "./pivot-grouping.js";
export * from "./pivot-timeline.js";
export * from "./pivot-types.js";
export * from "./shape-types.js";
export * from "./sort-range.js";
export * from "./workbook-dsl.js";
export * from "./workbook.types.js";
