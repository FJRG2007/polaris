/*
 * Ported from GenOffice (github.com/genspark-ai/genoffice), Apache-2.0.
 * Copyright 2026 Mainfunc, Inc. See NOTICE at the root of this repository.
 */

declare module 'word-extractor' {
  interface WordExtractOptions {
    filterUnicode?: boolean
  }

  interface WordTextboxOptions extends WordExtractOptions {
    includeHeadersAndFooters?: boolean
    includeBody?: boolean
  }

  export interface ExtractedWordDocument {
    getBody(options?: WordExtractOptions): string
    getTextboxes(options?: WordTextboxOptions): string
  }

  export default class WordExtractor {
    extract(source: string | Buffer): Promise<ExtractedWordDocument>
  }
}

declare module 'ppt-to-text' {
  interface ParsedPresentation {
    readonly slides?: readonly unknown[]
    readonly docs?: readonly unknown[]
  }

  interface PptToText {
    readBuffer(buffer: Buffer, options?: Record<string, unknown>): ParsedPresentation
    utils: {
      to_text(presentation: ParsedPresentation): string[]
    }
  }

  const pptToText: PptToText
  export default pptToText
}
