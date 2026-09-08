/*
 * Ported from GenOffice (github.com/genspark-ai/genoffice), Apache-2.0.
 * Copyright 2026 Mainfunc, Inc. See NOTICE at the root of this repository.
 */

import type { Node as PmNode } from '@tiptap/pm/model'

/** Memoize an O(doc) derivation by PM doc reference (docs are immutable, so same ref ⇒ same content). */
export function cachedByDoc<T>(compute: (doc: PmNode) => T): (doc: PmNode) => T {
  const cache = new WeakMap<PmNode, { value: T }>()
  return (doc) => {
    const hit = cache.get(doc)
    if (hit) return hit.value
    const value = compute(doc)
    cache.set(doc, { value })
    return value
  }
}
