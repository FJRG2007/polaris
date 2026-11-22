/**
 * Pasting into the document: the one path Ctrl+V, the right-click Paste and the
 * ribbon's Paste all take.
 *
 * Ctrl+V arrives as a paste event; the menus read the clipboard themselves when
 * pressed (`@polaris/ui/clipboard`, shared with the dashboard's menus) and hand
 * the same text, HTML and pictures to `handlePastePayload`, so a screenshot, a
 * copied image or a web copy lands the same way from all three. Pictures go in
 * through `insertImageFromDataUrl`, embedded in the document like a picture
 * inserted from the ribbon. A paste that cannot happen says so in a toast
 * naming the paste keys instead of doing nothing.
 */
import { t } from '../i18n/locale'
import type { Editor } from '@tiptap/core'
import type { EditorView } from '@tiptap/pm/view'
import { showToast } from '../components/toast-bus'
import { markdownPasteHtml } from './markdown-paste'
import { useEffect, useState } from 'react'
import { readClipboard, watchClipboardBlocked } from '@polaris/ui/clipboard'
import { DOMParser as PmDOMParser } from '@tiptap/pm/model'
import { insertImageFromDataUrl } from '../components/ribbon-tabs'

/** What a paste carries, whether it came from a paste event or a menu's read. */
export interface PastePayload {
  readonly html: string
  readonly text: string
  /** Pictures: a screenshot, a copied image, image files copied in a file manager. */
  readonly images: readonly Blob[]
}

/** At most this many pictures go in from one paste. */
const MAX_PASTED_IMAGES = 10

/** The formats a document picture is stored as; anything else is redrawn as PNG. */
const STORED_IMAGE_TYPES = /^image\/(png|jpeg|gif)$/

/** The payload of a paste event's clipboard data. */
export function payloadOf(data: DataTransfer): PastePayload {
  const images = [...data.items]
    .filter((item) => item.kind === 'file' && item.type.startsWith('image/'))
    .map((item) => item.getAsFile())
    .filter((file): file is File => file !== null)
  return { html: data.getData('text/html'), text: data.getData('text/plain'), images }
}

/** Clean pasted Word/web HTML: mso conditional comments, <o:p>, and unwrapping <li><p>x</p></li> */
export function cleanPastedHtml(html: string): string {
  return unwrapSingleCellTable(
    html
      .replace(/<!--\[if[\s\S]*?<!\[endif\]-->/g, '')
      .replace(/<o:p>[\s\S]*?<\/o:p>/g, '')
      .replace(/<li([^>]*)>\s*<p[^>]*>([\s\S]*?)<\/p>\s*<\/li>/g, '<li$1>$2</li>'),
  )
}

/**
 * Word parity: pasting a copy of a SINGLE spreadsheet cell inserts its
 * content as text, not a 1x1 table (alpha ledger r146 — a lone cell copied
 * from Sheets/Excel pasted into Docs as a table and flipped the ribbon into
 * table tools). Only a payload whose entire content is one table with one
 * cell unwraps; anything else — multi-cell tables, tables mixed with prose —
 * stays intact.
 */
function unwrapSingleCellTable(html: string): string {
  if (!/<table/i.test(html)) return html
  try {
    const doc = new window.DOMParser().parseFromString(html, 'text/html')
    const body = doc.body
    const tables = body.querySelectorAll('table')
    if (tables.length !== 1) return html
    const table = tables[0]!
    // The table must be the only real content of the paste. Text equality
    // covers prose ANYWHERE outside the table — including inside wrappers
    // that also contain it — and Element.textContent excludes HTML comments,
    // so Excel's StartFragment markers don't block the unwrap (bugbot).
    if ((body.textContent ?? '').trim() !== (table.textContent ?? '').trim()) return html
    // text-less content outside the table (images, separators) also keeps it
    if (
      [...body.querySelectorAll('img,svg,video,hr')].some((element) => !table.contains(element))
    ) {
      return html
    }
    const cells = table.querySelectorAll('td,th')
    if (cells.length !== 1) return html
    if (cells[0]!.querySelector('table')) return html
    return cells[0]!.innerHTML
  } catch {
    return html
  }
}

function readAsDataUrl(blob: Blob): Promise<string | null> {
  return new Promise((resolve) => {
    const reader = new FileReader()
    reader.onload = () => resolve(typeof reader.result === 'string' ? reader.result : null)
    reader.onerror = () => resolve(null)
    reader.readAsDataURL(blob)
  })
}

/** A data URL in a format the document stores; WebP, BMP and the like are redrawn as PNG. */
async function storableDataUrl(blob: Blob): Promise<string | null> {
  if (STORED_IMAGE_TYPES.test(blob.type)) return readAsDataUrl(blob)
  try {
    const bitmap = await createImageBitmap(blob)
    const canvas = document.createElement('canvas')
    canvas.width = bitmap.width
    canvas.height = bitmap.height
    canvas.getContext('2d')?.drawImage(bitmap, 0, 0)
    bitmap.close()
    const png = canvas.toDataURL('image/png')
    return png.startsWith('data:image/png') ? png : null
  } catch {
    return null
  }
}

/** Inserts pasted pictures at the caret, one after another; a toast for any that cannot go in. */
async function insertPictures(
  getEditor: () => Editor | null,
  sources: readonly (() => Promise<string | null>)[],
): Promise<void> {
  let failed = false
  for (const source of sources.slice(0, MAX_PASTED_IMAGES)) {
    const editor = getEditor()
    if (!editor) return
    const dataUrl = await source()
    if (!dataUrl || !(await insertImageFromDataUrl(editor, dataUrl, 'Image (pasted)'))) failed = true
  }
  if (failed) showToast(t('appPastePictureFailed'), 'error')
}

/**
 * Handles a paste the editor's own parsing would get wrong: pictures, block
 * HTML onto an empty paragraph, web image copies and Markdown text. False hands
 * the paste to ProseMirror's default parsing (`transformPastedHTML` and
 * `clipboardTextParser` still apply there).
 */
export function handlePastePayload(
  view: EditorView,
  payload: PastePayload,
  getEditor: () => Editor | null,
): boolean {
  const { html, text, images } = payload
  // web-copied images (r139): "Copy image" in a browser puts a bitmap +
  // an <img src="http..."> HTML fragment + often the URL as text/plain
  // on the clipboard. Detect image-only HTML so the bitmap wins over
  // text parsing, and so a bitmap-less copy can fetch the referenced
  // image instead of pasting nothing (our parse rules are data:-only).
  let htmlImgSrcs: string[] = []
  let htmlHasText = false
  if (html) {
    try {
      const imgDom = new window.DOMParser().parseFromString(html, 'text/html')
      htmlImgSrcs = [...imgDom.querySelectorAll('img')]
        .map((img) => img.getAttribute('src') ?? '')
        .filter(Boolean)
      htmlHasText = (imgDom.body.textContent ?? '').trim().length > 0
    } catch {
      /* unparseable html: treat as not-an-image copy */
    }
  }
  // remote-only: in-app data: copies carry data-image-meta and must keep
  // going through the DocProtected parse rules (size/align/wrap round-trip
  // — bugbot); only web copies divert to bitmap/fetch handling
  const imageOnlyHtml =
    htmlImgSrcs.length > 0 &&
    !htmlHasText &&
    htmlImgSrcs.every((src) => /^https?:\/\//i.test(src))
  // pasting block HTML onto an empty paragraph: replace wholesale (ProseMirror's default
  // first-block merge would demote headings to body text; Word keeps the source block format on empty paragraphs)
  const { $from, empty: selEmpty } = view.state.selection
  if (
    !imageOnlyHtml &&
    html &&
    selEmpty &&
    $from.parent.isTextblock &&
    $from.parent.content.size === 0 &&
    $from.depth === 1
  ) {
    try {
      const dom = new window.DOMParser().parseFromString(cleanPastedHtml(html), 'text/html')
      const parsed = PmDOMParser.fromSchema(view.state.schema).parse(dom.body)
      if (parsed.content.childCount > 0) {
        view.dispatch(view.state.tr.replaceWith($from.before(1), $from.after(1), parsed.content))
        return true
      }
    } catch {
      /* fall back to default paste on parse failure */
    }
  }
  // image-only copies keep the bitmap even when text/plain carries the
  // source URL (browser "Copy image" does that) — Word pastes the picture
  if (images.length > 0 && (!text.trim() || imageOnlyHtml)) {
    void insertPictures(
      getEditor,
      images.map((image) => () => storableDataUrl(image)),
    )
    return true
  }
  // bitmap-less web image copy: fetch the referenced image(s) through the
  // host's guarded fetcher (SSRF-guarded, CDN headers) and insert
  if (images.length === 0 && imageOnlyHtml) {
    void insertPictures(
      getEditor,
      htmlImgSrcs.map((src) => async () => {
        const fetched = await window.desktop.fetchImage(src).catch(() => null)
        return fetched ? `data:${fetched.mime};base64,${fetched.base64}` : null
      }),
    )
    return true
  }
  // text/plain-only Markdown (code blocks, terminals, .md files, LLM
  // output): convert and insert as formatted content instead of literal
  // "## Heading" / "**bold**" characters
  if (!html && text) {
    const markdownHtml = markdownPasteHtml(text)
    if (markdownHtml !== null) {
      try {
        // cleanPastedHtml unwraps <li><p>…</p></li> from loose lists —
        // docListItem only allows inline content and would shatter them.
        const dom = new window.DOMParser().parseFromString(
          cleanPastedHtml(markdownHtml),
          'text/html',
        )
        const parser = PmDOMParser.fromSchema(view.state.schema)
        if (
          selEmpty &&
          $from.parent.isTextblock &&
          $from.parent.content.size === 0 &&
          $from.depth === 1
        ) {
          // same wholesale replace as block HTML onto an empty paragraph
          const parsed = parser.parse(dom.body)
          if (parsed.content.childCount > 0) {
            view.dispatch(
              view.state.tr.replaceWith($from.before(1), $from.after(1), parsed.content),
            )
            return true
          }
        } else {
          view.dispatch(view.state.tr.replaceSelection(parser.parseSlice(dom.body)).scrollIntoView())
          return true
        }
      } catch {
        /* fall back to default literal paste on parse failure */
      }
    }
  }
  return false
}

export interface MenuPasteOptions {
  /** Text only, as Paste as Plain Text: no HTML and no pictures. */
  readonly plain?: boolean
  /** How plain text goes in for a plain paste. */
  readonly insertPlain?: (text: string) => void
}

/**
 * A menu's Paste: reads the clipboard inside the press (what lets the browser
 * allow it) and pastes it the way Ctrl+V would. Refused or empty, a toast says
 * so and names the paste keys, which always work.
 */
export async function pasteFromMenu(editor: Editor, options: MenuPasteOptions = {}): Promise<void> {
  const read = await readClipboard()
  if (!read.ok) {
    showToast(t('appPasteRefused'), 'error')
    return
  }
  const { text, html, files } = read.contents
  if (options.plain) {
    if (!text) showToast(t('appPasteEmpty'), 'error')
    else if (options.insertPlain) options.insertPlain(text)
    else editor.view.pasteText(text)
    return
  }
  const images = files.filter((file) => file.type.startsWith('image/'))
  if (!text && !html && images.length === 0) {
    showToast(t('appPasteEmpty'), 'error')
    return
  }
  editor.commands.focus()
  if (handlePastePayload(editor.view, { html: html ?? '', text, images }, () => editor)) return
  // The editor's own parsing, as for Ctrl+V. The event ProseMirror makes here
  // carries no clipboard data, so the editor's paste handler steps aside
  // instead of running a second time.
  if (html) editor.view.pasteHTML(html)
  else editor.view.pasteText(text)
}

/** Whether a menu can never read the clipboard here (no clipboard API, or refused for good). */
export function usePasteBlocked(): boolean {
  const [blocked, setBlocked] = useState(false)
  useEffect(() => watchClipboardBlocked(setBlocked), [])
  return blocked
}
