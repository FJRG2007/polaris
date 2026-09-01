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
 * The clipboard is deliberately not here. Cut, copy and paste are the browser's
 * to run - a page cannot read a clipboard it was not handed - and a menu item
 * that says Paste and does nothing is worse than no item at all. The keys still
 * work, and they are what people use.
 *
 * Every press keeps the selection: `onMouseDown` never moves the focus out of
 * the editor, which is the same rule the selection toolbar follows.
 */

import type { ReactNode } from "react";
import type { Editor } from "@tiptap/react";
import {
    ContextMenu,
    ContextMenuContent,
    ContextMenuItem,
    ContextMenuSeparator,
    ContextMenuTrigger
} from "@polaris/ui";
import {
    Bold,
    Code,
    Heading2,
    Italic,
    List,
    ListOrdered,
    ListTree,
    Quote,
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
    onSelect
}: {
    label: string;
    icon: ReactNode;
    onSelect: () => void;
}) {
    return (
        <ContextMenuItem
            className="gap-2"
            // The selection is lost the moment the editor blurs, so nothing here
            // may move the focus out of it.
            onMouseDown={(event) => event.preventDefault()}
            onSelect={onSelect}
        >
            {icon}
            {label}
        </ContextMenuItem>
    );
}

export function EditorMenu({
    editor,
    listAction,
    children
}: {
    editor: Editor;
    listAction?: ListAction;
    children: ReactNode;
}) {
    // Read when the menu opens rather than on every render: the selection changes
    // with every keystroke, and the menu is only ever asked about the one that
    // was there when it was opened.
    const list = listAction ? selectedListItems(editor) : null;
    const marks = !editor.state.selection.empty;

    return (
        <ContextMenu>
            <ContextMenuTrigger asChild>{children}</ContextMenuTrigger>
            <ContextMenuContent className="w-56">
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
