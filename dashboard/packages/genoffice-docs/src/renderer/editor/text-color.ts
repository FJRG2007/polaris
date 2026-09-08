/*
 * Ported from GenOffice (github.com/genspark-ai/genoffice), Apache-2.0.
 * Copyright 2026 Mainfunc, Inc. See NOTICE at the root of this repository.
 */

import { dkColor } from './dark-page'

/** Word's automatic text colour resolves to the paper ink (the var already flips on the dark page) */
const AUTO_INK_CSS = 'var(--docs-paper-ink)'

/** CSS color value for a modeled run/style colour (hex without '#', or 'auto') */
export function textColorValue(color: string): string {
  return color === 'auto' ? AUTO_INK_CSS : `#${color}`
}

/** `color` declaration plus the dark-page twin for authored hex (auto needs none) */
export function textColorDecls(color: string): string[] {
  return color === 'auto' ? [`color:${AUTO_INK_CSS}`] : [`color:#${color}`, dkColor(color)]
}
