"use client";

/**
 * The right-press menu on a writing surface.
 *
 * Polaris takes the browser's menu away almost everywhere else - a file, a task,
 * a column, a face - so a right press inside a description or a note was the one
 * place left that answered with the browser's, which reads as the editor not
 * being part of the application. It now answers with what you would reach for:
 * the marks the selection toolbar carries, the blocks the "/" menu carries, and
 * whatever the surface itself can do with what is selected.
 *
 * The clipboard is here, which it once was not. Cut and copy are the editor's
 * own selection written out; paste is the half that needs the browser's
 * permission, so it is read when the menu opens and the row says what it found -
 * something to paste, nothing to paste, or a browser that will not say. Every row
 * carries its key as well, because when a page is refused the clipboard the key
 * still works and that is the answer somebody needs at that moment.
 *
 * Every press keeps the selection: `onMouseDown` never moves the focus out of
 * the editor, which is the same rule the selection toolbar follows.
 */

import type { Editor } from "@tiptap/react";
import { useState, type ReactNode } from "react";
import {
    ContextMenu,
    ContextMenuContent,
    ContextMenuItem,
    ContextMenuSeparator,
    ContextMenuTrigger,
    MenuShortcut
} from "@polaris/ui";
import {
    Bold,
    ClipboardPaste,
    Code,
    Copy,
    Heading2,
    Italic,
    List,
    ListOrdered,
    ListTree,
    Quote,
    Scissors,
    Strikethrough
} from "lucide-react";

/**
 * What a surface can do with a list somebody selected.
 *
 * The one that exists: a task description holding "check the logs / restart it /
 * tell the customer" is three pieces of work written as prose, and turning them
 * into three subtasks by hand is retyping them. `run` answers true once they are
 * somewhere else, and only then is the list taken out of the text - a list
 * deleted before the write landed is work that no longer exists anywhere.
 */
export interface ListAction {
    readonly label: string;
    readonly run: (items: readonly string[]) => Promise<boolean>;
}

/**
 * A stretch of the document, and how it read at the moment it was taken.
 *
 * The text is what makes the positions safe to use later: they are absolute, and
 * a document that changed under them points them at something else entirely.
 */
interface Span {
    readonly from: number;
    readonly to: number;
    readonly text: string;
}

/** A stretch of the document as it reads right now. */
function spanAt(editor: Editor, from: number, to: number): Span {
    return { from, to, text: editor.state.doc.textBetween(from, to, "\n", " ") };
}

/**
 * Whether a span still holds what it held when it was taken.
 *
 * Everything the menu does to the document is done to positions captured when it
 * opened, and the wait in between is long enough to lose them: a menu holds the
 * focus, and a blurred surface is exactly the one the editor lets a value from
 * the server replace - see the content effect in `rich-text-editor.tsx`. So by
 * the time a clipboard write or a subtask round trip answers, those numbers can
 * address a different document: a delete takes out an arbitrary stretch of it,
 * or throws for a position past its end. Anything the numbers no longer describe
 * is left alone, which costs somebody a second cut and never costs them text.
 */
function stillReads(editor: Editor, span: Span): boolean {
    if (editor.isDestroyed) return false;
    if (span.to > editor.state.doc.content.size) return false;
    return editor.state.doc.textBetween(span.from, span.to, "\n", " ") === span.text;
}

/** The list items covered by the selection, and the span they occupy. Null when
 *  the selection is empty or touches no list at all. */
export function selectedListItems(editor: Editor): (Span & { items: string[] }) | null {
    const { from, to } = editor.state.selection;
    if (from === to) return null;
    const items: string[] = [];
    let start = Number.POSITIVE_INFINITY;
    let end = -1;
    editor.state.doc.nodesBetween(from, to, (node, pos) => {
        if (node.type.name !== "listItem" && node.type.name !== "taskItem") return;
        const text = node.textContent.trim();
        if (text) items.push(text);
        start = Math.min(start, pos);
        end = Math.max(end, pos + node.nodeSize);
    });
    if (items.length === 0 || end < 0) return null;
    return { items, ...spanAt(editor, start, end) };
}

/**
 * What the menu is about: the span it was opened over, and the list inside it.
 *
 * Captured rather than read back, because an editor's selection is not something
 * React watches - see where this is filled in.
 */
interface Opened {
    readonly selection: Span;
    readonly list: ReturnType<typeof selectedListItems>;
}

/** The marks a row can carry, named the way the editor names them. */
type MarkCommand = "toggleBold" | "toggleItalic" | "toggleStrike" | "toggleCode";

function Item({
    label,
    icon,
    keys,
    disabled,
    onSelect
}: {
    label: string;
    icon: ReactNode;
    /** The keyboard shortcut, for the rows that have one. */
    keys?: string;
    disabled?: boolean;
    onSelect: () => void;
}) {
    return (
        <ContextMenuItem
            className="gap-2"
            disabled={disabled}
            // The selection is lost the moment the editor blurs, so nothing here
            // may move the focus out of it.
            onMouseDown={(event) => event.preventDefault()}
            onSelect={onSelect}
        >
            {icon}
            {label}
            {keys ? <MenuShortcut>{keys}</MenuShortcut> : null}
        </ContextMenuItem>
    );
}

/**
 * What the keys are called here.
 *
 * The menu is worth less than nothing if it teaches the wrong shortcut, and the
 * shortcut is the part that keeps working when the browser will not hand a page
 * the clipboard.
 */
function modifierKey(): string {
    if (typeof navigator === "undefined") return "Ctrl";
    return /Mac|iPhone|iPad/.test(navigator.userAgent) ? "Cmd" : "Ctrl";
}

export function EditorMenu({
    editor,
    listAction,
    onPaste,
    children
}: {
    editor: Editor;
    listAction?: ListAction;
    /**
     * What to do with text off the clipboard.
     *
     * The surface's job rather than this menu's: pasted text is read as Markdown
     * and its references are resolved, and that lives with the editor. Without
     * one, the text is inserted as it is.
     */
    onPaste?: (text: string) => void;
    children: ReactNode;
}) {
    /**
     * The selection as it was when the menu opened.
     *
     * Held in state rather than read while rendering, and that is the whole of
     * why the menu works: `useEditor` re-renders nothing when a selection changes
     * - tiptap does not do that unless it is asked to, since it would cost a
     * render on every keystroke - so a value read during render is the one from
     * whenever React last happened to run. Selecting a word with the mouse runs
     * no render at all, so the menu opened still believing nothing was selected:
     * Copy and Cut drawn disabled, the marks missing altogether, and a press on
     * Copy doing nothing whatsoever, because a disabled item takes no pointer.
     *
     * Null while the menu is closed, which is what keeps it current: it is
     * written on the way open, from the editor as it is at that moment.
     */
    const [opened, setOpened] = useState<Opened | null>(null);
    const list = opened?.list ?? null;
    const marks = opened !== null && opened.selection.from !== opened.selection.to;

    /**
     * What the clipboard holds, read when the menu opens and never before: a page
     * that polls the clipboard is a page asking for a permission it has no use
     * for. Null is "not read yet", "" is empty or refused.
     */
    const [pending, setPending] = useState<string | null>(null);
    const keys = modifierKey();

    /**
     * A mark over the span the menu was opened over, rather than over whatever is
     * selected by the time the row is pressed.
     *
     * The same reason the rest of the menu works from a captured span: the menu
     * holds the focus, and on a surface that lets its selection go with the focus
     * a live toggle arms a mark at the caret instead of formatting the words
     * somebody selected - a press that appears to do nothing at all.
     */
    const mark = (command: MarkCommand) => () => {
        if (!opened || !stillReads(editor, opened.selection)) return;
        const { from, to } = opened.selection;
        editor.chain().focus().setTextSelection({ from, to })[command]().run();
    };

    async function put(text: string): Promise<boolean> {
        try {
            await navigator.clipboard.writeText(text);
            return true;
        } catch {
            // An insecure origin, or a document that is not focused. Nothing
            // useful to say: the key does this too.
            return false;
        }
    }

    return (
        <ContextMenu
            onOpenChange={(open) => {
                if (!open) {
                    setPending(null);
                    setOpened(null);
                    return;
                }
                const { from, to } = editor.state.selection;
                setOpened({
                    selection: spanAt(editor, from, to),
                    list: listAction ? selectedListItems(editor) : null
                });
                void navigator.clipboard
                    ?.readText()
                    .then((text) => setPending(text))
                    .catch(() => setPending(""));
            }}
        >
            <ContextMenuTrigger asChild>{children}</ContextMenuTrigger>
            <ContextMenuContent className="w-60">
                <Item
                    label="Cut"
                    keys={`${keys}+X`}
                    disabled={!marks}
                    icon={<Scissors className="size-3.5" />}
                    onSelect={() => {
                        if (!opened) return;
                        const span = opened.selection;
                        void put(span.text).then((written) => {
                            // Only once it is somewhere else, and only while the
                            // span still reads as it did. Text cut onto a
                            // clipboard that refused it is text that is gone.
                            if (!written || !stillReads(editor, span)) return;
                            editor
                                .chain()
                                .focus()
                                .deleteRange({ from: span.from, to: span.to })
                                .run();
                        });
                    }}
                />
                <Item
                    label="Copy"
                    keys={`${keys}+C`}
                    disabled={!marks}
                    icon={<Copy className="size-3.5" />}
                    onSelect={() => void put(opened?.selection.text ?? "")}
                />
                <Item
                    label={pending === "" ? "Nothing to paste" : "Paste"}
                    keys={`${keys}+V`}
                    disabled={!pending}
                    icon={<ClipboardPaste className="size-3.5" />}
                    onSelect={() => {
                        if (!pending) return;
                        if (onPaste) onPaste(pending);
                        else editor.chain().focus().insertContent(pending).run();
                    }}
                />
                <ContextMenuSeparator />

                {marks ? (
                    <>
                        <Item
                            label="Bold"
                            icon={<Bold className="size-3.5" />}
                            onSelect={mark("toggleBold")}
                        />
                        <Item
                            label="Italic"
                            icon={<Italic className="size-3.5" />}
                            onSelect={mark("toggleItalic")}
                        />
                        <Item
                            label="Strikethrough"
                            icon={<Strikethrough className="size-3.5" />}
                            onSelect={mark("toggleStrike")}
                        />
                        <Item
                            label="Code"
                            icon={<Code className="size-3.5" />}
                            onSelect={mark("toggleCode")}
                        />
                        <ContextMenuSeparator />
                    </>
                ) : null}

                <Item
                    label="Heading"
                    icon={<Heading2 className="size-3.5" />}
                    onSelect={() => editor.chain().focus().toggleHeading({ level: 2 }).run()}
                />
                <Item
                    label="Bulleted list"
                    icon={<List className="size-3.5" />}
                    onSelect={() => editor.chain().focus().toggleBulletList().run()}
                />
                <Item
                    label="Numbered list"
                    icon={<ListOrdered className="size-3.5" />}
                    onSelect={() => editor.chain().focus().toggleOrderedList().run()}
                />
                <Item
                    label="Quote"
                    icon={<Quote className="size-3.5" />}
                    onSelect={() => editor.chain().focus().toggleBlockquote().run()}
                />

                {listAction && list ? (
                    <>
                        <ContextMenuSeparator />
                        <Item
                            label={`${listAction.label} (${list.items.length})`}
                            icon={<ListTree className="size-3.5" />}
                            onSelect={() => {
                                void listAction.run(list.items).then((moved) => {
                                    // Only once they exist somewhere else, and
                                    // only while the span still reads as it did. A
                                    // list taken out of the text after a refused
                                    // write is work that no longer exists anywhere.
                                    if (!moved || !stillReads(editor, list)) return;
                                    editor
                                        .chain()
                                        .focus()
                                        .deleteRange({ from: list.from, to: list.to })
                                        .run();
                                });
                            }}
                        />
                    </>
                ) : null}
            </ContextMenuContent>
        </ContextMenu>
    );
}
