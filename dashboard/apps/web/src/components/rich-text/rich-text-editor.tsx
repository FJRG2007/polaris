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
import { mentionExtension } from "./suggestion";
import { useCallback, useEffect, useMemo, useRef } from "react";
import { EditorContent, useEditor, type Editor } from "@tiptap/react";
import { resolveReferencesAction, searchMentionsAction } from "@/app/(app)/mention-actions";

export interface RichTextEditorProps {
    /** The stored Markdown. */
    value: string;
    /** Told on every keystroke, for a caller that keeps the draft itself. */
    onChange?: (markdown: string) => void;
    /** Told when the caret leaves, for a field that saves on blur. */
    onBlur?: (markdown: string) => void;
    /** When set, Enter sends and shift+enter breaks the line, the way a chat
     *  composer does. Without it Enter is a new paragraph. */
    onSubmit?: (markdown: string) => void;
    placeholder?: string;
    disabled?: boolean;
    autoFocus?: boolean;
    /** Draw the border and background of a form field. Off by default: a
     *  description should read as part of the panel, not as an input. */
    bordered?: boolean;
    className?: string;
}

/** What a chip says while its real name is still being looked up. */
const PENDING_LABEL = "…";

export function RichTextEditor({
    value,
    onChange,
    onBlur,
    onSubmit,
    placeholder = "Write something",
    disabled = false,
    autoFocus = false,
    bordered = false,
    className
}: RichTextEditorProps) {
    // Held in a ref rather than in the dependency list: the editor is built once
    // and these change with every render of the parent.
    const handlers = useRef({ onChange, onBlur, onSubmit });
    handlers.current = { onChange, onBlur, onSubmit };

    const search = useCallback(async (kinds: readonly refs.ReferenceKind[], query: string) => {
        const result = await runAction(() => searchMentionsAction({ kinds: [...kinds], query }), () => undefined);
        return result?.results ?? [];
    }, []);

    const extensions = useMemo(
        () => [...baseExtensions(placeholder), BlockMenu, mentionExtension(search)],
        [placeholder, search]
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
            handleKeyDown: (_view, event) => {
                if (!handlers.current.onSubmit) return false;
                if (event.key !== "Enter" || event.shiftKey) return false;
                handlers.current.onSubmit(md.docToMarkdown(editorRef.current?.getJSON()));
                return true;
            },
            handlePaste: (view, event) => handleMarkdownPaste(editorRef.current, view, event)
        },
        onUpdate: ({ editor: current }) => handlers.current.onChange?.(md.docToMarkdown(current.getJSON())),
        onBlur: ({ editor: current }) => handlers.current.onBlur?.(md.docToMarkdown(current.getJSON()))
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
            ? "rounded-md border border-border bg-background px-3 py-2 focus-within:border-primary"
            // Camouflaged until you point at it, and plain again once the caret
            // is in: the tint says "this is editable", and once you are editing
            // it is only a box around what you are writing. Written as one
            // selector rather than hover plus focus-within, which are the same
            // specificity and would resolve by stylesheet order.
            : "-mx-2 rounded-md px-2 py-1 transition-colors [&:not(:focus-within):hover]:bg-muted/40",
        disabled && "cursor-default opacity-70 [&:not(:focus-within):hover]:bg-transparent"
    );
}

/** Where this Polaris answers, so a pasted link to it is recognized as one. */
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

    editor.chain().focus().insertContent(doc.content ?? []).run();
    if (pending.length > 0) void nameReferences(editor, pending);
    return true;
}

/** Cheap enough to run on every paste, and wrong only in the harmless direction:
 *  a false positive re-inserts the same text it was given. */
function looksLikeMarkdown(text: string): boolean {
    return /(^|\n)\s*(#{1,3} |[-*+] |\d+\. |> |```)/.test(text) || /\*\*|__|~~|\[[^\]]+\]\(/.test(text);
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
            const attrs = (node.attrs ?? {}) as { kind?: refs.ReferenceKind; id?: string; label?: string };
            // Picked from the @ list, the label is already the name. Pasted, it
            // is whatever was between the brackets - usually the URL itself.
            if (attrs.kind && attrs.id && (!attrs.label || attrs.label.includes("://") || attrs.label.startsWith("/"))) {
                found.push({ kind: attrs.kind, id: attrs.id });
            }
        }
        for (const child of (node.content as Record<string, unknown>[] | undefined) ?? []) walk(child);
    };
    walk(doc as Record<string, unknown>);
    return found;
}

/** Fill in the names once the server has them, leaving the address alone. */
async function nameReferences(editor: Editor, pending: readonly PendingReference[]): Promise<void> {
    editor.commands.command(({ tr, state }) => {
        state.doc.descendants((node, pos) => {
            if (node.type.name !== md.REFERENCE) return;
            if (!pending.some((target) => target.kind === node.attrs.kind && target.id === node.attrs.id)) return;
            tr.setNodeMarkup(pos, undefined, { ...node.attrs, label: PENDING_LABEL });
        });
        return true;
    });

    const result = await runAction(() => resolveReferencesAction([...pending]), () => undefined);
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
