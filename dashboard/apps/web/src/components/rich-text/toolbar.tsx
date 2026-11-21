"use client";

/**
 * The bar that appears over a selection.
 *
 * It exists so formatting never costs a trip to a toolbar at the top of a panel
 * that may not even be on screen: select the words, the controls come to them.
 * Only the marks worth a click are here - everything else has a Markdown
 * shortcut, and a row of twenty icons is how a writing surface stops looking
 * like one.
 *
 * The link control turns into a field in place rather than opening a dialog,
 * because a dialog over a selection hides the thing being linked.
 */

import { cn } from "@polaris/ui";
import { useTranslations } from "@/components/i18n/i18n-provider";
import type { Editor } from "@tiptap/react";
import { BubbleMenu } from "@tiptap/react/menus";
import { useEffect, useRef, useState } from "react";
import { Bold, Code, Italic, Link2, Link2Off, Strikethrough } from "lucide-react";

/** One icon button on a formatting bar. Shared by the bar over a selection and
 *  the one along the top of a document, so a pressed Bold looks the same in
 *  both. */
export function ToolbarButton({
    label,
    active,
    disabled,
    onClick,
    children
}: {
    label: string;
    active?: boolean;
    disabled?: boolean;
    onClick: () => void;
    children: React.ReactNode;
}) {
    return (
        <button
            type="button"
            aria-label={label}
            title={label}
            aria-pressed={active}
            disabled={disabled}
            // The selection is lost the moment the editor blurs, so the press
            // must never move the focus out of it.
            onMouseDown={(event) => event.preventDefault()}
            onClick={onClick}
            className={cn(
                "shrink-0 rounded p-1.5 text-muted-foreground transition-colors hover:bg-muted hover:text-foreground disabled:pointer-events-none disabled:opacity-40",
                active && "bg-muted text-foreground"
            )}
        >
            {children}
        </button>
    );
}

/** Where the bar over a selection is laid: the dialog the editor is in, or the page. */
export function floatingRoot(editor: Editor): HTMLElement {
    const dom = editor.isDestroyed ? null : editor.view.dom;
    return dom?.closest<HTMLElement>("[role='dialog'], [role='alertdialog']") ?? document.body;
}

export function SelectionToolbar({ editor }: { editor: Editor }) {
    const t = useTranslations("components");
    const [linking, setLinking] = useState(false);
    const [href, setHref] = useState("");
    const field = useRef<HTMLInputElement>(null);

    useEffect(() => {
        if (linking) field.current?.focus();
    }, [linking]);

    const commit = () => {
        const value = href.trim();
        if (value) editor.chain().focus().extendMarkRange("link").setLink({ href: value }).run();
        else editor.chain().focus().extendMarkRange("link").unsetLink().run();
        setLinking(false);
        setHref("");
    };

    return (
        <BubbleMenu
            editor={editor}
            // A selection inside a code block is code: offering to make it bold
            // would put asterisks in somebody's shell command.
            shouldShow={({ editor: current, from, to }) =>
                from !== to && !current.isActive("codeBlock") && !current.isActive("markdownBlock")
            }
            // Out of the editor's own box, which is where it went by default:
            // the chat composer clips what overflows it, so the bar sat half
            // under the line being formatted. Laid on the page instead - or on
            // the dialog the editor is in, which keeps it inside that dialog's
            // focus and pointer handling - and kept on screen by flipping below
            // the selection or sliding along it.
            appendTo={() => floatingRoot(editor)}
            options={{ strategy: "fixed", placement: "top", offset: 8, flip: { padding: 8 }, shift: { padding: 8 } }}
            className="pointer-events-auto z-[60] flex items-center gap-0.5 rounded-lg border border-border-strong bg-elevated p-1 shadow-popover"
        >
            {linking ? (
                <form
                    onSubmit={(event) => {
                        event.preventDefault();
                        commit();
                    }}
                    className="flex items-center gap-1"
                >
                    <input
                        ref={field}
                        value={href}
                        aria-label={t("editor.linkAddress")}
                        placeholder={t("editor.pasteLink")}
                        onChange={(event) => setHref(event.target.value)}
                        onKeyDown={(event) => {
                            if (event.key !== "Escape") return;
                            event.preventDefault();
                            setLinking(false);
                        }}
                        className="h-7 w-56 rounded border border-border bg-field px-2 text-xs hover:border-border-strong focus:border-border-strong"
                    />
                    <ToolbarButton label={t("editor.applyLink")} onClick={commit}>
                        <Link2 className="size-4" />
                    </ToolbarButton>
                </form>
            ) : (
                <>
                    <ToolbarButton
                        label={t("editor.bold")}
                        active={editor.isActive("bold")}
                        onClick={() => editor.chain().focus().toggleBold().run()}
                    >
                        <Bold className="size-4" />
                    </ToolbarButton>
                    <ToolbarButton
                        label={t("editor.italic")}
                        active={editor.isActive("italic")}
                        onClick={() => editor.chain().focus().toggleItalic().run()}
                    >
                        <Italic className="size-4" />
                    </ToolbarButton>
                    <ToolbarButton
                        label={t("editor.strike")}
                        active={editor.isActive("strike")}
                        onClick={() => editor.chain().focus().toggleStrike().run()}
                    >
                        <Strikethrough className="size-4" />
                    </ToolbarButton>
                    <ToolbarButton
                        label={t("editor.blocks.code")}
                        active={editor.isActive("code")}
                        onClick={() => editor.chain().focus().toggleCode().run()}
                    >
                        <Code className="size-4" />
                    </ToolbarButton>
                    <span className="mx-0.5 h-5 w-px bg-border" />
                    {editor.isActive("link") ? (
                        <ToolbarButton
                            label={t("editor.removeLink")}
                            onClick={() =>
                                editor.chain().focus().extendMarkRange("link").unsetLink().run()
                            }
                        >
                            <Link2Off className="size-4" />
                        </ToolbarButton>
                    ) : (
                        <ToolbarButton
                            label={t("editor.addLink")}
                            onClick={() => {
                                setHref(editor.getAttributes("link").href ?? "");
                                setLinking(true);
                            }}
                        >
                            <Link2 className="size-4" />
                        </ToolbarButton>
                    )}
                </>
            )}
        </BubbleMenu>
    );
}
