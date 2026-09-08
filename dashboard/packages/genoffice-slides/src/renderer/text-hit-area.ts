/*
 * Ported from GenOffice (github.com/genspark-ai/genoffice), Apache-2.0.
 * Copyright 2026 Mainfunc, Inc. See NOTICE at the root of this repository.
 */

import type { ShapeRenderNode } from '@polaris/pptx-render'

/** Text frames need a full-box hit target because their glyph runs do not cover spacing/insets. */
export function needsTextFrameHitArea(shape: ShapeRenderNode): boolean {
  return !!shape.text
}
