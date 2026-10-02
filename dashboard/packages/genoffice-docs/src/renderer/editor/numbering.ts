/*
 * Ported from GenOffice (github.com/genspark-ai/genoffice), Apache-2.0.
 * Copyright 2026 Mainfunc, Inc.
 */

// Implementation lives in the engine (parse-time TOC numbering reuses it);
// this module keeps the historical import path for the editor.
export {
  bulletMarkerScale,
  computeListMarkerInfos,
  computeListMarkers,
  formatNumber,
  markerTabAdvance,
  type ListItemRef,
  type ListMarkerInfo,
} from '@polaris/docx'
