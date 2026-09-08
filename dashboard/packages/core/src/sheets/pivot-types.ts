/*
 * Ported from GenOffice (github.com/genspark-ai/genoffice), Apache-2.0.
 * Copyright 2026 Mainfunc, Inc. See NOTICE at the root of this repository.
 *
 * Behaviour unchanged; formatting follows this repository's conventions.
 */

/**
 * The shape of a pivot table, as a workbook stores one.
 *
 * Ported from GenSpark's GenOffice (Apache-2.0) - see NOTICE. Only the shape,
 * not the reader that fills it in: `PivotDefinition` is what the recompute
 * engine consumes, and the OOXML parser that produces one from a `.xlsx` is a
 * separate concern that arrives with the import work.
 *
 * Everything here is a type. The engine beside it is where the behaviour is.
 */

import type { PivotFieldGrouping } from "./pivot-grouping.js";
import type { PivotFilterDef } from "./pivot-filters.js";

export type { PivotFieldGrouping } from "./pivot-grouping.js";
export type { PivotFilterDef, PivotLabelFilter, PivotValueFilter } from "./pivot-filters.js";

/** Raised when a pivot part cannot be read at all. */
export class PivotParseError extends Error {}

export type PivotSharedItem = string | number | boolean | null

export interface PivotFieldItem {
  /// sharedItems index; null for subtotal/function items.
  readonly x: number | null
  readonly hidden: boolean
}

export interface PivotCacheField {
  readonly name: string
  readonly sharedItems: readonly PivotSharedItem[]
  /// Grouped field (date/numeric ranges): when present, sharedItems are group
  /// labels, and refresh groups raw source values before matching. Stored in our
  /// private pivotTable extLst extension (real <fieldGroup> OOXML persistence: see
  /// the TODO in pivot-grouping).
  readonly grouping?: PivotFieldGrouping | undefined
  /// Calculated field (cacheField@formula): not a source data column, takes no
  /// cache records; value is computed by the formula over the grouped aggregates
  /// of other fields (see pivot-formula).
  readonly formula?: string | undefined
}

export interface PivotLayoutLine {
  /// 'data' rows/cols carry members; 'default' = subtotal, 'grand' = total.
  readonly t: string
  /// members fixed by this line: pivotField item index per axis level,
  /// already propagated across the r-attribute repeats.
  readonly members: readonly (number | null)[]
  /// how many leading axis levels the line fixes (subtotal depth).
  readonly depth: number
  /// data-field index this line renders (multi-value pivots).
  readonly dataField: number
}

/// "Show values as" modes that support refresh (subset of the ECMA-376
/// dataField@showDataAs enum): percent of grand total / row total / column total.
export type PivotShowDataAs = 'percentOfTotal' | 'percentOfRow' | 'percentOfCol'

export interface PivotDataField {
  readonly name: string
  readonly field: number
  readonly subtotal: string
  /// "Show values as" mode; undefined = normal (show the aggregate directly).
  readonly showDataAs?: PivotShowDataAs | undefined
  /// Formula of a calculated field (present when field points at a cacheField
  /// with a formula): each group first SUMs the referenced source fields, then
  /// evaluates the formula.
  readonly formula?: string | undefined
}

export interface PivotDefinition {
  readonly outputRef: string
  readonly firstDataRow: number
  readonly firstDataCol: number
  readonly fields: readonly PivotCacheField[]
  /// per cache field: axis items (empty for pure data fields).
  readonly fieldItems: readonly (readonly PivotFieldItem[])[]
  /// cache-field indexes; -2 marks the data-field position.
  readonly rowFields: readonly number[]
  readonly colFields: readonly number[]
  readonly rowLines: readonly PivotLayoutLine[]
  readonly colLines: readonly PivotLayoutLine[]
  readonly dataFields: readonly PivotDataField[]
  /// page (report-filter) selections: sharedItems index or null for "all".
  readonly pageFields: readonly { readonly field: number; readonly item: number | null }[]
  /// Value/label filters (pivotFilters): members that fail the filter are hidden
  /// entries in fieldItems; refresh re-applies them against the source data
  /// (value filters aggregate first, then filter).
  readonly filters: readonly PivotFilterDef[]
  readonly sourceSheet: string
  readonly sourceRef: string
  /// reasons this pivot cannot be recomputed; empty = refresh supported.
  readonly unsupported: readonly string[]
}
