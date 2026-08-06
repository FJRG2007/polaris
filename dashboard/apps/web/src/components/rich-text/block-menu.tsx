"use client";

/**
 * The block menu, opened by typing "/".
 *
 * Every entry here also has a Markdown shortcut, and both routes are kept
 * because they suit different people: somebody who writes Markdown types "## ",
 * somebody who does not types "/" and reads the list. Neither is a fallback for
 * the other.
 *
 * The menu is a suggestion like the mention pickers, so it inherits the same
 * positioning and the same keys - arrows to move, enter to take, escape to
 * dismiss - rather than growing its own.
 */

import { cn } from "@polaris/ui";
import { Extension } from "@tiptap/core";
import Suggestion from "@tiptap/suggestion";
import { PluginKey } from "@tiptap/pm/state";
import { ReactRenderer } from "@tiptap/react";
import type { Editor, Range } from "@tiptap/core";
import type { SuggestionProps } from "@tiptap/suggestion";
import { forwardRef, useEffect, useImperativeHandle, useState } from "react";
import {
    POPUP_CLASS,
    POPUP_ITEM_CLASS,
    POPUP_LAYER_CLASS,
    type SuggestionHandle
} from "./suggestion";
import {
    Code2,
    Heading1,
    Heading2,
    Heading3,
    List,
    ListOrdered,
    ListTodo,
    Minus,
    Quote,
    Type
} from "lucide-react";

interface BlockCommand {
    readonly label: string;
    /** What somebody would type looking for it, beyond the label itself. */
    readonly keywords: string;
    readonly icon: React.ComponentType<{ className?: string }>;
    readonly run: (editor: Editor, range: Range) => void;
}

const BLOCKS: readonly BlockCommand[] = [
    {
        label: "Text",
        keywords: "paragraph plain",
        icon: Type,
        run: (editor, range) => editor.chain().focus().deleteRange(range).setParagraph().run()
    },
    {
        label: "Heading",
        keywords: "title h1",
        icon: Heading1,
        run: (editor, range) =>
            editor.chain().focus().deleteRange(range).setNode("heading", { level: 1 }).run()
    },
    {
        label: "Subheading",
        keywords: "h2 section",
        icon: Heading2,
        run: (editor, range) =>
            editor.chain().focus().deleteRange(range).setNode("heading", { level: 2 }).run()
    },
    {
        label: "Small heading",
        keywords: "h3",
        icon: Heading3,
        run: (editor, range) =>
            editor.chain().focus().deleteRange(range).setNode("heading", { level: 3 }).run()
    },
    {
        label: "Bullet list",
        keywords: "unordered ul points",
        icon: List,
        run: (editor, range) => editor.chain().focus().deleteRange(range).toggleBulletList().run()
    },
    {
        label: "Numbered list",
        keywords: "ordered ol steps",
        icon: ListOrdered,
        run: (editor, range) => editor.chain().focus().deleteRange(range).toggleOrderedList().run()
    },
    {
        label: "Checklist",
        keywords: "todo task checkbox",
        icon: ListTodo,
        run: (editor, range) => editor.chain().focus().deleteRange(range).toggleTaskList().run()
    },
    {
        label: "Quote",
        keywords: "blockquote citation",
        icon: Quote,
        run: (editor, range) => editor.chain().focus().deleteRange(range).toggleBlockquote().run()
    },
    {
        label: "Code",
        keywords: "snippet fence pre",
        icon: Code2,
        run: (editor, range) => editor.chain().focus().deleteRange(range).toggleCodeBlock().run()
    },
    {
        label: "Divider",
        keywords: "rule separator hr line",
        icon: Minus,
        run: (editor, range) => editor.chain().focus().deleteRange(range).setHorizontalRule().run()
    }
];

const Menu = forwardRef<SuggestionHandle, SuggestionProps<BlockCommand>>(function Menu(props, ref) {
    const [active, setActive] = useState(0);
    const items = props.items;

    useEffect(() => setActive(0), [items]);

    useImperativeHandle(ref, () => ({
        onKeyDown: ({ event }) => {
            if (event.key === "ArrowDown") {
                setActive((current) => (current + 1) % Math.max(items.length, 1));
                return true;
            }
            if (event.key === "ArrowUp") {
                setActive((current) => (current + items.length - 1) % Math.max(items.length, 1));
                return true;
            }
            if (event.key === "Enter" || event.key === "Tab") {
                const item = items[active];
                if (item) props.command(item);
                return true;
            }
            return false;
        }
    }));

    if (items.length === 0) return null;

    return (
        <ul className={POPUP_CLASS}>
            {items.map((item, index) => (
                <li key={item.label}>
                    <button
                        type="button"
                        onMouseDown={(event) => {
                            event.preventDefault();
                            props.command(item);
                        }}
                        onMouseEnter={() => setActive(index)}
                        className={cn(
                            POPUP_ITEM_CLASS,
                            index === active ? "bg-muted" : "hover:bg-muted/60"
                        )}
                    >
                        <item.icon className="size-4 shrink-0 text-muted-foreground" />
                        <span className="truncate" title={item.label}>
                            {item.label}
                        </span>
                    </button>
                </li>
            ))}
        </ul>
    );
});

const blockMenuKey = new PluginKey("polarisBlockMenu");

/** Typing "/" opens the list; typing on filters it. */
export const BlockMenu = Extension.create({
    name: "polarisBlockMenu",

    addProseMirrorPlugins() {
        return [
            Suggestion<BlockCommand>({
                editor: this.editor,
                char: "/",
                pluginKey: blockMenuKey,
                // Only at the start of an empty-ish block: a slash inside a
                // sentence is a slash, and inside code it is a path.
                allow: ({ editor }) =>
                    !editor.isActive("codeBlock") && !editor.isActive("markdownBlock"),
                items: ({ query }) => {
                    const term = query.trim().toLowerCase();
                    if (!term) return [...BLOCKS];
                    return BLOCKS.filter(
                        (block) =>
                            block.label.toLowerCase().includes(term) ||
                            block.keywords.includes(term)
                    );
                },
                command: ({ editor, range, props }) => props.run(editor, range),
                render: () => {
                    let renderer: ReactRenderer<
                        SuggestionHandle,
                        SuggestionProps<BlockCommand>
                    > | null = null;
                    let unmount: (() => void) | null = null;

                    return {
                        onStart: (props) => {
                            renderer = new ReactRenderer(Menu, {
                                props,
                                editor: props.editor,
                                className: POPUP_LAYER_CLASS
                            });
                            unmount = props.mount(renderer.element as HTMLElement);
                        },
                        onUpdate: (props) => renderer?.updateProps(props),
                        onKeyDown: (props) => {
                            if (props.event.key === "Escape") return false;
                            return renderer?.ref?.onKeyDown(props) ?? false;
                        },
                        onExit: () => {
                            unmount?.();
                            renderer?.destroy();
                            renderer = null;
                            unmount = null;
                        }
                    };
                }
            })
        ];
    }
});
