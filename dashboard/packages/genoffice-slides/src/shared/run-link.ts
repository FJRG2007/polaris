/*
 * Ported from GenOffice (github.com/genspark-ai/genoffice), Apache-2.0.
 * Copyright 2026 Mainfunc, Inc. See NOTICE at the root of this repository.
 */

/**
 * Run-hyperlink string encoding shared by renderer and main: external url, or
 * "slide:N" (0-based) for in-doc jumps — same encoding as the engine's TextRun.hyperlink.
 */
import type { LinkTargetOp } from './ipc'

export function encodeLinkTarget(target: LinkTargetOp): string {
  return target.kind === 'slide' ? `slide:${target.slideIndex}` : target.url
}

export function decodeLinkTarget(s: string | null | undefined): LinkTargetOp | null {
  if (!s) return null
  const m = /^slide:(\d+)$/.exec(s)
  if (m) return { kind: 'slide', slideIndex: Number(m[1]) }
  return { kind: 'url', url: s }
}
