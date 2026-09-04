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

/** The list items covered by the selection, and the span they occupy. Null when
 *  the selection is empty or touches no list at all. */
export function selectedListItems(
    editor: Editor
): { items: string[]; from: number; to: number } | null {
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
    return { items, from: start, to: end };
}

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
    // Read when the menu opens rather than on every render: the selection changes
    // with every keystroke, and the menu is only ever asked about the one that
    // was there when it was opened.
    const list = listAction ? selectedListItems(editor) : null;
    const marks = !editor.state.selection.empty;

    /**
     * What the clipboard holds, read when the menu opens and never before: a page
     * that polls the clipboard is a page asking for a permission it has no use
     * for. Null is "not read yet", "" is empty or refused.
     */
    const [pending, setPending] = useState<string | null>(null);
    const keys = modifierKey();

    /** The selection as text, which is what goes on the clipboard. */
    const selectedText = (): string => {
        const { from, to } = editor.state.selection;
        return editor.state.doc.textBetween(from, to, "\n", " ");
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
                    return;
                }
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
                        const text = selectedText();
                        void put(text).then((written) => {
                            // Only once it is somewhere else. Text cut onto a
                            // clipboard that refused it is text that is gone.
                            if (written && !editor.isDestroyed) {
                                editor.chain().focus().deleteSelection().run();
                            }
                        });
                    }}
                />
                <Item
                    label="Copy"
                    keys={`${keys}+C`}
                    disabled={!marks}
                    icon={<Copy className="size-3.5" />}
                    onSelect={() => void put(selectedText())}
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
                            onSelect={() => editor.chain().focus().toggleBold().run()}
                        />
                        <Item
                            label="Italic"
                            icon={<Italic className="size-3.5" />}
                            onSelect={() => editor.chain().focus().toggleItalic().run()}
                        />
                        <Item
                            label="Strikethrough"
                            icon={<Strikethrough className="size-3.5" />}
                            onSelect={() => editor.chain().focus().toggleStrike().run()}
                        />
                        <Item
                            label="Code"
                            icon={<Code className="size-3.5" />}
                            onSelect={() => editor.chain().focus().toggleCode().run()}
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
                                    // Only once they exist somewhere else. A list
                                    // taken out of the text after a refused write
                                    // is work that no longer exists anywhere.
                                    if (!moved || editor.isDestroyed) return;
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
