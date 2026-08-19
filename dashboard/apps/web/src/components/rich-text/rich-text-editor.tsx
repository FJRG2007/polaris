"use client";

/**
 * The writing surface, wherever Polaris asks somebody to write something.
 *
 * It is deliberately not a box with a toolbar on top. The field looks like the
 * text it holds until you put the caret in it, formatting comes to the selection
 * instead of living in a bar, and everything has a Markdown shortcut - so
 * somebody who types "## " gets a heading and somebody who does not types "/"
 * and picks one. What it stores either way is Markdown.
 *
 * One component behind the task description, the comment box, a page and a note.
 * The differences between those are two props: whether it looks like a field,
 * and whether Enter sends.
 */

import { cn } from "@polaris/ui";
import * as md from "./markdown";
import * as refs from "./references";
import { BlockMenu } from "./block-menu";
import { baseExtensions } from "./schema";
import { RICH_TEXT_PROSE } from "./prose";
import { runAction } from "@/lib/run-action";
import { SelectionToolbar } from "./toolbar";
import { mentionExtension, popupOpen } from "./suggestion";
import { useCallback, useEffect, useMemo, useRef } from "react";
import { EditorContent, useEditor, type Editor } from "@tiptap/react";
import type { JSONContent } from "@tiptap/core";
import { resolveReferencesAction, searchMentionsAction } from "@/app/(app)/mention-actions";

export interface RichTextEditorProps {
    /** The stored Markdown. */
    value: string;
    /** Told on every keystroke, for a caller that keeps the draft itself. */
    onChange?: (markdown: string) => void;
    /**
     * Told when a key that writes something is pressed here.
     *
     * Not the same question as `onChange`, which is why it exists. A document
     * changes for all sorts of reasons that are not a person typing - a chip
     * resolving its name, an extension settling on mount, a value arriving from
     * elsewhere - and a chat that announced "typing" on any of those told the
     * other side somebody was writing when they had only opened the room.
     */
    onTyping?: () => void;
    /** Told when the caret leaves, for a field that saves on blur. */
    onBlur?: (markdown: string) => void;
    /** When set, Enter sends and shift+enter breaks the line, the way a chat
     *  composer does. Without it Enter is a new paragraph. */
    onSubmit?: (markdown: string) => void;
    placeholder?: string;
    disabled?: boolean;
    autoFocus?: boolean;
    /**
     * Bumped by the caller to put the caret in here.
     *
     * `autoFocus` only fires when the editor is built, and the surfaces that
     * need this - answering a message, starting an edit - happen to an editor
     * that is already on screen. Any changed value focuses; the number itself
     * means nothing.
     */
    focusAt?: number;
    /**
     * Something to drop in where the caret is.
     *
     * Written as Markdown, the way everything else that reaches this surface is,
     * and read into real nodes before it lands - a mention has to arrive as the
     * chip it is rather than as the source of one.
     *
     * At the caret rather than at the end, which is the whole reason it is the
     * editor's job and not the caller's: the caller has a string, and the only
     * thing that knows where somebody left off is the document. Bumped by the
     * caller; the number itself means nothing.
     */
    insert?: { readonly token: number; readonly text: string } | null;
    /**
     * Where the caret lands when `focusAt` fires.
     *
     * "end" for a surface whose text has just been replaced - starting an edit -
     * where the end of the sentence is the only place to carry on from. "keep"
     * for one that already has something half-written in it: answering a message
     * must put the caret back where the writer left it, not at the end of a line
     * they were in the middle of.
     */
    focusWhere?: "end" | "keep";
    /**
     * Files arrived on the clipboard, usually a screenshot.
     *
     * Answered by the caller because the files are not the document's business:
     * a composer stages them as attachments, and a surface with nowhere to put
     * one says so by not passing this. True means it took them, and the paste
     * goes no further.
     */
    onPasteFiles?: (files: readonly File[]) => boolean;
    /**
     * The conversation this editor is writing into, when it is writing into one.
     *
     * What @ offers then is the people in that room rather than the ones this
     * account shares work with - which is what everybody expects, and what makes
     * the picker useful in a direct message between two people who have no
     * shared space anywhere else in Polaris.
     */
    mentionsIn?: string | null;
    /** Draw the border and background of a form field. Off by default: a
     *  description should read as part of the panel, not as an input. */
    bordered?: boolean;
    className?: string;
}

/**
 * Whether a key press is somebody writing.
 *
 * A single printable character, or one of the two that take one away. Arrows,
 * tab, escape and every shortcut are movement or commands - announcing typing
 * for those is how an indicator stays up for somebody who is reading.
 */
function writes(event: KeyboardEvent): boolean {
    if (event.metaKey || event.ctrlKey || event.altKey) return false;
    if (event.key === "Backspace" || event.key === "Delete") return true;
    return [...event.key].length === 1;
}

/** What a chip says while its real name is still being looked up. */
const PENDING_LABEL = "…";

export function RichTextEditor({
    value,
    onChange,
    onBlur,
    onSubmit,
    onTyping,
    placeholder = "Write something",
    disabled = false,
    autoFocus = false,
    focusAt = 0,
    insert = null,
    focusWhere = "end",
    onPasteFiles,
    mentionsIn = null,
    bordered = false,
    className
}: RichTextEditorProps) {
    // Held in a ref rather than in the dependency list: the editor is built once
    // and these change with every render of the parent.
    const handlers = useRef({ onChange, onBlur, onSubmit, onTyping, onPasteFiles });
    handlers.current = { onChange, onBlur, onSubmit, onTyping, onPasteFiles };
    // The same, for where the caret goes: it changes with the reason the caller
    // is asking, and it must not be a reason to focus on its own.
    const caret = useRef(focusWhere);
    caret.current = focusWhere;

    const search = useCallback(
        async (kinds: readonly refs.ReferenceKind[], query: string) => {
            const result = await runAction(
                () =>
                    searchMentionsAction({
                        kinds: [...kinds],
                        query,
                        ...(mentionsIn ? { channelId: mentionsIn } : {})
                    }),
                () => undefined
            );
            return result?.results ?? [];
        },
        [mentionsIn]
    );

    const extensions = useMemo(
        // The room mentions only where there is a room: `mentionsIn` is a
        // conversation, and offering "@everyone" in a task description would name
        // a set of people nobody can point at.
        () => [
            ...baseExtensions(placeholder),
            BlockMenu,
            mentionExtension(search, mentionsIn !== null)
        ],
        [placeholder, search, mentionsIn]
    );

    const editor = useEditor({
        extensions,
        editable: !disabled,
        autofocus: autoFocus,
        // Rendered on the client only: the server has no DOM to build the view
        // against, and a description is inside a panel that is client-side anyway.
        immediatelyRender: false,
        content: md.markdownToDoc(value, origin()),
        editorProps: {
            attributes: {
                class: cn(
                    RICH_TEXT_PROSE,
                    "min-h-[3rem] outline-none",
                    // The placeholder is drawn by the Placeholder extension as a
                    // pseudo-element on the first empty block.
                    "[&_p.is-editor-empty:first-child::before]:pointer-events-none",
                    "[&_p.is-editor-empty:first-child::before]:float-left",
                    "[&_p.is-editor-empty:first-child::before]:h-0",
                    "[&_p.is-editor-empty:first-child::before]:text-muted-foreground",
                    "[&_p.is-editor-empty:first-child::before]:content-[attr(data-placeholder)]"
                )
            },
            handleKeyDown: (view, event) => {
                // Somebody is writing. Anything that puts a character in - a
                // letter, a space, a backspace - and nothing that only moves
                // around, holds a modifier or leaves the field.
                if (writes(event)) handlers.current.onTyping?.();

                if (!handlers.current.onSubmit) return false;
                if (event.key !== "Enter" || event.shiftKey) return false;
                // A list open under the caret owns Enter: it is being pressed to
                // take the name that is highlighted, not to send. This is a
                // direct editor prop and those are asked before any plugin, so
                // the popup cannot decline it on its own.
                if (popupOpen(view.state)) return false;

                const send = (): boolean => {
                    handlers.current.onSubmit?.(md.docToMarkdown(editorRef.current?.getJSON()));
                    return true;
                };
                // The one key that always sends, which is how you get out of a
                // code block without reaching for the mouse.
                if (event.metaKey || event.ctrlKey) return send();

                const { $from } = view.state.selection;
                // Inside a code block Enter is a newline. A composer where the
                // only way to write two lines of code is to not press Enter is a
                // composer nobody writes code in.
                if ($from.parent.type.name === "codeBlock") return false;

                // A line that is only a fence opens the block rather than
                // sending it as text. Without this the fence is escaped on the
                // way out and arrives in the conversation as three backticks.
                const language = md.fenceLanguage($from.parent.textContent);
                if (language !== null && editorRef.current) {
                    editorRef.current
                        .chain()
                        .focus()
                        .deleteRange({ from: $from.start(), to: $from.end() })
                        .setNode("codeBlock", { language: language || null })
                        .run();
                    return true;
                }

                return send();
            },
            handlePaste: (view, event) => {
                // A screenshot, or anything else on the clipboard that is a file
                // rather than text. It belongs to whatever is around the editor -
                // a composer stages it as an attachment - and nothing about it
                // goes into the document.
                const files = [...(event.clipboardData?.files ?? [])];
                if (files.length > 0 && handlers.current.onPasteFiles?.(files)) return true;
                return handleMarkdownPaste(editorRef.current, view, event);
            }
        },
        onUpdate: ({ editor: current }) =>
            handlers.current.onChange?.(md.docToMarkdown(current.getJSON())),
        onBlur: ({ editor: current }) =>
            handlers.current.onBlur?.(md.docToMarkdown(current.getJSON()))
    });

    const editorRef = useRef<Editor | null>(null);
    editorRef.current = editor;

    // A value that changed elsewhere - another tab, a reload after a save, the
    // panel being pointed at a different task - has to reach the surface. While
    // somebody is typing it must not: replacing the document under the caret
    // loses the position and the undo history.
    useEffect(() => {
        if (!editor || editor.isFocused) return;
        if (md.docToMarkdown(editor.getJSON()) === value) return;
        editor.commands.setContent(md.markdownToDoc(value, origin()), { emitUpdate: false });
    }, [editor, value]);

    useEffect(() => {
        editor?.setEditable(!disabled);
    }, [editor, disabled]);

    /**
     * Somebody asked for the caret.
     *
     * On a timer of zero rather than straight away. Most of the things that ask
     * for it are menu items - Reply, Edit - and a Radix menu hands focus back to
     * whatever opened it a tick after it unmounts, which is a tick after this. So
     * focusing now was focusing and then being blurred, which is exactly what
     * "pressing reply does not put me back in the box" looked like.
     */
    useEffect(() => {
        if (!focusAt || !editor || disabled) return;
        const timer = window.setTimeout(() => {
            if (editor.isDestroyed) return;
            // "keep" restores the selection the editor still holds from before it
            // was blurred, which is where the writer left off.
            if (caret.current === "keep") editor.commands.focus();
            else editor.commands.focus("end");
        }, 0);
        return () => window.clearTimeout(timer);
    }, [focusAt, editor, disabled]);

    /**
     * Somebody handed something in.
     *
     * On the same zero timer as the caret, and for the same reason: what asks
     * for this is a menu item, and the menu is still on screen holding focus
     * when the effect runs.
     *
     * The caret ends up after what was inserted, which is what somebody who
     * pressed "mention" is about to type into. A space goes with it, because the
     * alternative is a name welded to the next word.
     */
    const insertToken = insert?.token ?? 0;
    useEffect(() => {
        const text = insert?.text ?? "";
        if (!insertToken || !editor || disabled || !text) return;
        const timer = window.setTimeout(() => {
            if (editor.isDestroyed) return;
            const doc = md.markdownToDoc(text, origin());
            const pending = collectReferences(doc);
            editor.chain().focus().insertContent(inlineIfOneLine(doc)).insertContent(" ").run();
            if (pending.length > 0) void nameReferences(editor, pending);
        }, 0);
        return () => window.clearTimeout(timer);
        // eslint-disable-next-line react-hooks/exhaustive-deps -- deliberately the token
    }, [insertToken, editor, disabled]);

    if (!editor) {
        // The same box, before the view exists, so nothing jumps when it does.
        return <div className={cn(surfaceClass(bordered, disabled), "min-h-[3rem]", className)} />;
    }

    return (
        <div className={cn(surfaceClass(bordered, disabled), className)}>
            {!disabled && <SelectionToolbar editor={editor} />}
            <EditorContent editor={editor} />
        </div>
    );
}

/** Camouflaged by default, and only a field when a caller says so. */
function surfaceClass(bordered: boolean, disabled: boolean): string {
    return cn(
        "w-full",
        bordered
            ? "rounded-md border border-border bg-field px-3 py-2 focus-within:border-border-strong"
            : // Camouflaged until you point at it, and plain again once the caret
              // is in: the tint says "this is editable", and once you are editing
              // it is only a box around what you are writing. Written as one
              // selector rather than hover plus focus-within, which are the same
              // specificity and would resolve by stylesheet order.
              "-mx-2 rounded-md px-2 py-1 transition-colors [&:not(:focus-within):hover]:bg-muted/40",
        disabled && "cursor-default opacity-70 [&:not(:focus-within):hover]:bg-transparent"
    );
}

/** Where this Polaris answers, so a pasted link to it is recognized as one. */
/**
 * What to hand `insertContent`, given a document that is usually one line.
 *
 * A mention is a link in a paragraph, and inserting that paragraph in the middle
 * of a sentence splits the sentence in two. So a single paragraph is unwrapped
 * to the inline nodes inside it and lands in the line somebody is writing;
 * anything with real structure - which nothing does today, but a pasted table
 * would - goes in whole.
 */
function inlineIfOneLine(doc: JSONContent): JSONContent[] {
    const blocks = doc.content ?? [];
    const only = blocks.length === 1 ? blocks[0] : null;
    if (only?.type === "paragraph") return only.content ?? [];
    return blocks;
}

function origin(): string | null {
    return typeof window === "undefined" ? null : window.location.origin;
}

/**
 * Paste, read as Markdown.
 *
 * Anything copied out of another editor arrives as HTML and is left to
 * ProseMirror, which already knows how to read it. Plain text is where this
 * matters: pasting a block of Markdown should become the document it describes
 * rather than a paragraph full of asterisks, and pasting a Polaris link should
 * become the thing it points at.
 */
function handleMarkdownPaste(editor: Editor | null, view: unknown, event: ClipboardEvent): boolean {
    void view;
    const text = event.clipboardData?.getData("text/plain") ?? "";
    const html = event.clipboardData?.getData("text/html") ?? "";
    if (!editor || !text || html) return false;
    // Inside a fence, pasted text is the code. Reading it as Markdown there
    // would turn somebody's shell script into headings.
    if (editor.isActive("codeBlock") || editor.isActive(md.MARKDOWN_BLOCK)) return false;

    const doc = md.markdownToDoc(text, origin());
    const pending = collectReferences(doc);
    // A single paragraph of ordinary prose is what the editor would have
    // inserted anyway, and letting it through keeps the link-on-paste behavior.
    if (pending.length === 0 && !looksLikeMarkdown(text)) return false;

    editor
        .chain()
        .focus()
        .insertContent(doc.content ?? [])
        .run();
    if (pending.length > 0) void nameReferences(editor, pending);
    return true;
}

/** Cheap enough to run on every paste, and wrong only in the harmless direction:
 *  a false positive re-inserts the same text it was given. */
function looksLikeMarkdown(text: string): boolean {
    return (
        /(^|\n)\s*(#{1,3} |[-*+] |\d+\. |> |```)/.test(text) || /\*\*|__|~~|\[[^\]]+\]\(/.test(text)
    );
}

interface PendingReference {
    readonly kind: refs.ReferenceKind;
    readonly id: string;
}

/** The chips a paste produced that are still labelled with their own address. */
function collectReferences(doc: { content?: unknown }): PendingReference[] {
    const found: PendingReference[] = [];
    const walk = (node: Record<string, unknown>) => {
        if (node.type === md.REFERENCE) {
            const attrs = (node.attrs ?? {}) as {
                kind?: refs.ReferenceKind;
                id?: string;
                label?: string;
            };
            // Picked from the @ list, the label is already the name. Pasted, it
            // is whatever was between the brackets - usually the URL itself.
            if (
                attrs.kind &&
                attrs.id &&
                (!attrs.label || attrs.label.includes("://") || attrs.label.startsWith("/"))
            ) {
                found.push({ kind: attrs.kind, id: attrs.id });
            }
        }
        for (const child of (node.content as Record<string, unknown>[] | undefined) ?? [])
            walk(child);
    };
    walk(doc as Record<string, unknown>);
    return found;
}

/** Fill in the names once the server has them, leaving the address alone. */
async function nameReferences(editor: Editor, pending: readonly PendingReference[]): Promise<void> {
    editor.commands.command(({ tr, state }) => {
        state.doc.descendants((node, pos) => {
            if (node.type.name !== md.REFERENCE) return;
            if (
                !pending.some(
                    (target) => target.kind === node.attrs.kind && target.id === node.attrs.id
                )
            )
                return;
            tr.setNodeMarkup(pos, undefined, { ...node.attrs, label: PENDING_LABEL });
        });
        return true;
    });

    const result = await runAction(
        () => resolveReferencesAction([...pending]),
        () => undefined
    );
    const labels = result?.labels ?? {};
    if (editor.isDestroyed) return;

    editor.commands.command(({ tr, state }) => {
        state.doc.descendants((node, pos) => {
            if (node.type.name !== md.REFERENCE || node.attrs.label !== PENDING_LABEL) return;
            const name = labels[`${node.attrs.kind}/${node.attrs.id}`];
            tr.setNodeMarkup(pos, undefined, {
                ...node.attrs,
                // Nothing came back for something the reader cannot reach. The
                // chip keeps pointing at it and says so rather than vanishing.
                label: name ?? `${node.attrs.kind}`
            });
        });
        return true;
    });
}
