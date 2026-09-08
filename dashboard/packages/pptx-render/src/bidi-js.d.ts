/*
 * Ported from GenOffice (github.com/genspark-ai/genoffice), Apache-2.0.
 * Copyright 2026 Mainfunc, Inc. See NOTICE at the root of this repository.
 */

declare module 'bidi-js' {
  interface BidiApi {
    getEmbeddingLevels(
      text: string,
      explicitDirection?: 'ltr' | 'rtl',
    ): { levels: Uint8Array; paragraphs: Array<{ start: number; end: number; level: number }> }
  }
  export default function bidiFactory(): BidiApi
}
