// @vitest-environment jsdom
/**
 * Pasting into a document from Ctrl+V and from the menus: a picture goes in
 * through the editor's picture insert, a web image copy keeps its picture, a
 * refused clipboard says so, and text pastes as it always did.
 */
import { Editor, Node } from '@tiptap/core'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

vi.mock('../../src/renderer/components/ribbon-tabs', () => ({
  insertImageFromDataUrl: vi.fn(async () => true),
}))
vi.mock('../../src/renderer/components/toast-bus', () => ({ showToast: vi.fn() }))

import { setModuleLang } from '../../src/renderer/i18n/locale'
import { showToast } from '../../src/renderer/components/toast-bus'
import { insertImageFromDataUrl } from '../../src/renderer/components/ribbon-tabs'
import {
  handlePastePayload,
  pasteFromMenu,
  payloadOf,
} from '../../src/renderer/editor/clipboard-paste'

const insertImage = vi.mocked(insertImageFromDataUrl)
const toast = vi.mocked(showToast)

const Doc = Node.create({ name: 'doc', topNode: true, content: 'block+' })
const Paragraph = Node.create({
  name: 'docParagraph',
  group: 'block',
  content: 'inline*',
  parseHTML: () => [{ tag: 'p' }],
  renderHTML: () => ['p', 0],
})
const Text = Node.create({ name: 'text', group: 'inline' })

const PNG_BYTES = 'iVBORw0KGgo='
const png = () =>
  new File([Uint8Array.from(atob(PNG_BYTES), (c) => c.charCodeAt(0))], 'image.png', {
    type: 'image/png',
  })

/** A clipboard item as `navigator.clipboard.read()` returns it. */
const clipboardItem = (entries: Record<string, Blob | string>) => ({
  types: Object.keys(entries),
  getType: async (type: string) => {
    const value = entries[type]!
    return typeof value === 'string' ? new Blob([value], { type }) : value
  },
})

const stubClipboard = (clipboard: Partial<Clipboard> | undefined) =>
  Object.defineProperty(navigator, 'clipboard', { value: clipboard, configurable: true })

/** Waits for the pictures a paste reads in the background. */
const settle = () => new Promise((resolve) => setTimeout(resolve, 20))

let editor: Editor

beforeEach(() => {
  setModuleLang('en')
  insertImage.mockClear()
  toast.mockClear()
  if (typeof ClipboardEvent === 'undefined') {
    // jsdom has none; ProseMirror makes one for pasteHTML/pasteText
    ;(globalThis as Record<string, unknown>).ClipboardEvent = class extends Event {
      clipboardData = null
    }
  }
  ;(window as unknown as { desktop: unknown }).desktop = { fetchImage: vi.fn(async () => null) }
  editor = new Editor({
    element: document.createElement('div'),
    extensions: [Doc, Paragraph, Text],
    content: { type: 'doc', content: [{ type: 'docParagraph' }] },
  })
})

afterEach(() => {
  editor.destroy()
  stubClipboard(undefined)
})

describe('Ctrl+V', () => {
  it('inserts a pasted picture through the picture insert', async () => {
    const file = png()
    const data = {
      items: [{ kind: 'file', type: 'image/png', getAsFile: () => file }],
      getData: () => '',
    } as unknown as DataTransfer
    expect(handlePastePayload(editor.view, payloadOf(data), () => editor)).toBe(true)
    await settle()
    expect(insertImage).toHaveBeenCalledTimes(1)
    expect(insertImage.mock.calls[0]![1]).toBe(`data:image/png;base64,${PNG_BYTES}`)
    expect(toast).not.toHaveBeenCalled()
  })

  it('keeps the picture of a web image copy whose text is its address', async () => {
    const src = 'https://example.com/picture.png'
    const handled = handlePastePayload(
      editor.view,
      { html: `<img src="${src}">`, text: src, images: [png()] },
      () => editor,
    )
    expect(handled).toBe(true)
    await settle()
    expect(insertImage).toHaveBeenCalledTimes(1)
  })

  it('fetches the picture of a web image copy that carries no bitmap', async () => {
    const fetchImage = vi.fn(async () => ({ base64: PNG_BYTES, mime: 'image/png' }))
    ;(window as unknown as { desktop: unknown }).desktop = { fetchImage }
    const src = 'https://example.com/picture.png'
    expect(
      handlePastePayload(editor.view, { html: `<img src="${src}">`, text: '', images: [] }, () => editor),
    ).toBe(true)
    await settle()
    expect(fetchImage).toHaveBeenCalledWith(src)
    expect(insertImage.mock.calls[0]![1]).toBe(`data:image/png;base64,${PNG_BYTES}`)
  })

  it('says so when a web image copy cannot be fetched', async () => {
    const src = 'https://example.com/picture.png'
    handlePastePayload(editor.view, { html: `<img src="${src}">`, text: '', images: [] }, () => editor)
    await settle()
    expect(insertImage).not.toHaveBeenCalled()
    expect(toast).toHaveBeenCalledWith('The picture could not be pasted.', 'error')
  })

  it('leaves plain text to the editor', () => {
    expect(
      handlePastePayload(editor.view, { html: '', text: 'Plain words', images: [] }, () => editor),
    ).toBe(false)
    expect(insertImage).not.toHaveBeenCalled()
  })
})

describe('the menu Paste', () => {
  it('pastes a picture from the clipboard', async () => {
    stubClipboard({ read: async () => [clipboardItem({ 'image/png': png() })] } as never)
    await pasteFromMenu(editor)
    await settle()
    expect(insertImage).toHaveBeenCalledTimes(1)
    expect(insertImage.mock.calls[0]![1]).toBe(`data:image/png;base64,${PNG_BYTES}`)
  })

  it('pastes the picture of HTML that is only an image', async () => {
    const src = 'https://example.com/picture.png'
    stubClipboard({
      read: async () => [
        clipboardItem({ 'text/html': `<img src="${src}">`, 'text/plain': src, 'image/png': png() }),
      ],
    } as never)
    await pasteFromMenu(editor)
    await settle()
    expect(insertImage).toHaveBeenCalledTimes(1)
    expect(editor.getText()).not.toContain(src)
  })

  it('pastes HTML with text through the editor', async () => {
    stubClipboard({
      read: async () => [clipboardItem({ 'text/html': '<p>Rich words</p>', 'text/plain': 'Rich words' })],
    } as never)
    await pasteFromMenu(editor)
    expect(editor.getText()).toContain('Rich words')
    expect(insertImage).not.toHaveBeenCalled()
  })

  it('pastes text as before', async () => {
    stubClipboard({ read: async () => [clipboardItem({ 'text/plain': 'Plain words' })] } as never)
    await pasteFromMenu(editor)
    expect(editor.getText()).toBe('Plain words')
    expect(insertImage).not.toHaveBeenCalled()
    expect(toast).not.toHaveBeenCalled()
  })

  it('pastes text as plain text without reading pictures', async () => {
    stubClipboard({
      read: async () => [clipboardItem({ 'text/plain': 'Plain words', 'image/png': png() })],
    } as never)
    const insertPlain = vi.fn()
    await pasteFromMenu(editor, { plain: true, insertPlain })
    expect(insertPlain).toHaveBeenCalledWith('Plain words')
    expect(insertImage).not.toHaveBeenCalled()
  })

  it('names the paste keys when the clipboard is refused, and asks only once', async () => {
    const refusal = Object.assign(new Error('denied'), { name: 'NotAllowedError' })
    const readText = vi.fn(async () => 'never')
    stubClipboard({ read: async () => Promise.reject(refusal), readText } as never)
    await pasteFromMenu(editor)
    expect(readText).not.toHaveBeenCalled()
    expect(toast).toHaveBeenCalledTimes(1)
    const [text, kind] = toast.mock.calls[0]!
    expect(kind).toBe('error')
    expect(text).toMatch(/(Ctrl\+V|⌘V)/)
    expect(editor.getText()).toBe('')
  })

  it('names the paste keys where there is no clipboard to read', async () => {
    stubClipboard(undefined)
    await pasteFromMenu(editor)
    expect(toast.mock.calls[0]![0]).toMatch(/(Ctrl\+V|⌘V)/)
  })

  it('says the clipboard is empty instead of doing nothing', async () => {
    stubClipboard({ read: async () => [] } as never)
    await pasteFromMenu(editor)
    expect(toast).toHaveBeenCalledWith('Nothing to paste: the clipboard is empty.', 'error')
  })
})
