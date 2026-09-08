/*
 * Ported from GenOffice (github.com/genspark-ai/genoffice), Apache-2.0.
 * Copyright 2026 Mainfunc, Inc. See NOTICE at the root of this repository.
 */

/**
 * Reusable Range: Blink fixes up every live Range on each DOM removal, so
 * per-word probe Ranges make later ProseMirror re-renders crawl. Do not nest.
 */
export function rangeSlot(): () => Range {
  let range: Range | undefined
  return () => (range ??= document.createRange())
}
