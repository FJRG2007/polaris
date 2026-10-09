"use client";

/**
 * `:` in a chat box: the emoji list under the caret, and a space's own emoji as
 * pictures in what is being written.
 *
 * Only a surface that is writing into a conversation turns this on. `:` is
 * ordinary punctuation everywhere else - "Note: ..." in a task description is
 * not somebody looking for an emoji - and a space's emoji mean nothing outside
 * their space.
 *
 * Three pieces, one per way an emoji gets in:
 *
 * - the list, opened by `:` and two characters, which offers the space's emoji
 *   first and then the ordinary ones, the way Discord's does;
 * - `:name:` typed out in full, which becomes the space's emoji of that name the
 *   moment the closing colon lands;
 * - the node itself, which draws the picture and is written out as the token.
 *
 * The node is drawn as a span with the picture as its background and its name as
 * hidden text, never as an <img>: copied into a box that does not know about
 * emoji, an <img> would be read as a picture and posted as one; a span is read
 * as the `:name:` it says.
 */

import { cn } from "@polaris/ui";
import * as core from "@polaris/core";
import Suggestion from "@tiptap/suggestion";
import { ReactRenderer } from "@tiptap/react";
import { searchEmoji } from "@/lib/chat/emoji";
import { EmojiPicture, type CustomEmojiEntry } from "./custom-emoji";
import { CUSTOM_EMOJI_NODE, customEmojiNode } from "./custom-emoji-doc";
import { Extension, InputRule, mergeAttributes, Node } from "@tiptap/core";
import { forwardRef, useEffect, useImperativeHandle, useState } from "react";
import type { SuggestionOptions, SuggestionProps } from "@tiptap/suggestion";
import {
    EMOJI_MENU_KEY,
    POPUP_CLASS,
    POPUP_ITEM_CLASS,
    POPUP_LAYER_CLASS,
    type SuggestionHandle
} from "./suggestion";

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/** Where a node's picture comes from. Nothing but an id ever reaches the URL. */
function pictureOf(id: string): string {
    return UUID.test(id) ? `/api/chat/emoji/${id.toLowerCase()}` : "";
}

/** One of a space's emoji, in the document being written. */
export const CustomEmojiNode = Node.create({
    name: CUSTOM_EMOJI_NODE,
    group: "inline",
    inline: true,
    atom: true,
    selectable: true,

    addAttributes() {
        // Drawn through `renderHTML` below as data attributes, never as their
        // own: a bare `id` attribute would put the same element id on every
        // copy of one emoji in the box.
        return {
            id: { default: null, renderHTML: () => ({}) },
            name: { default: "", renderHTML: () => ({}) },
            animated: { default: false, renderHTML: () => ({}) }
        };
    },

    parseHTML() {
        return [
            {
                tag: "span[data-custom-emoji]",
                getAttrs: (element) => {
                    const id = element.getAttribute("data-id") ?? "";
                    const name = element.getAttribute("data-name") ?? "";
                    if (!UUID.test(id) || core.emojiNameProblem(name)) return false;
                    return { id, name, animated: element.getAttribute("data-animated") === "true" };
                }
            }
        ];
    },

    renderHTML({ node, HTMLAttributes }) {
        const label = core.customEmojiFallback({ name: String(node.attrs.name ?? "") });
        const src = pictureOf(String(node.attrs.id ?? ""));
        return [
            "span",
            mergeAttributes(HTMLAttributes, {
                "data-custom-emoji": "",
                "data-id": node.attrs.id,
                "data-name": node.attrs.name,
                "data-animated": String(node.attrs.animated === true),
                role: "img",
                "aria-label": label,
                title: label,
                class: "mx-px inline-block size-[1.375em] bg-contain bg-center bg-no-repeat align-[-0.3em]",
                style: src ? `background-image: url("${src}")` : ""
            }),
            ["span", { class: "sr-only" }, label]
        ];
    },

    /** What lands on the clipboard as plain text: the name, as it was typed. */
    renderText({ node }) {
        return core.customEmojiFallback({ name: String(node.attrs.name ?? "") });
    }
});

/** What the list offers: one of the space's, or an ordinary emoji. */
export type EmojiSuggestionItem =
    | { readonly kind: "custom"; readonly entry: CustomEmojiEntry }
    | { readonly kind: "unicode"; readonly char: string; readonly words: string };

/** How many rows the list holds - a shortcut, not a second picker. */
const MOST = 10;

/**
 * What the list offers for what has been typed after the colon.
 *
 * The space's own first, names starting with the query before names merely
 * containing it, then the ordinary emoji whose words match. Two characters at
 * least, like Discord: one is every emoji there is.
 */
export function emojiSuggestions(
    query: string,
    custom: readonly CustomEmojiEntry[]
): EmojiSuggestionItem[] {
    const needle = query.toLowerCase();
    if (needle.length < 2 || !/^[a-z0-9_+-]+$/.test(needle)) return [];
    const starts = custom.filter((entry) => entry.name.toLowerCase().startsWith(needle));
    const contains = custom.filter(
        (entry) =>
            !entry.name.toLowerCase().startsWith(needle) &&
            entry.name.toLowerCase().includes(needle)
    );
    const own: EmojiSuggestionItem[] = [...starts, ...contains].map((entry) => ({
        kind: "custom",
        entry
    }));
    const ordinary: EmojiSuggestionItem[] = searchEmoji(needle.replace(/_/g, " ")).map((emoji) => ({
        kind: "unicode",
        char: emoji.char,
        words: emoji.words
    }));
    return [...own, ...ordinary].slice(0, MOST);
}

type ListProps = SuggestionProps<EmojiSuggestionItem>;

const List = forwardRef<SuggestionHandle, ListProps>(function List(props, ref) {
    const [active, setActive] = useState(0);
    const items = props.items;
    useEffect(() => setActive(0), [items]);

    const choose = (index: number) => {
        const item = items[index];
        if (item) props.command(item);
    };

    useImperativeHandle(ref, () => ({
        onKeyDown: ({ event }) => {
            if (items.length === 0) return false;
            if (event.key === "ArrowDown") {
                setActive((current) => (current + 1) % items.length);
                return true;
            }
            if (event.key === "ArrowUp") {
                setActive((current) => (current + items.length - 1) % items.length);
                return true;
            }
            if (event.key === "Enter" || event.key === "Tab") {
                choose(active);
                return true;
            }
            return false;
        }
    }));

    if (items.length === 0) return null;
    return (
        <ul className={POPUP_CLASS} role="listbox">
            {items.map((item, index) => {
                const label =
                    item.kind === "custom" ? core.customEmojiFallback(item.entry) : item.words;
                return (
                    <li key={item.kind === "custom" ? item.entry.id : item.char}>
                        <button
                            type="button"
                            role="option"
                            aria-selected={index === active}
                            // Pointer down, so the press lands before the editor
                            // takes the focus back and moves the caret.
                            onMouseDown={(event) => {
                                event.preventDefault();
                                choose(index);
                            }}
                            onMouseEnter={() => setActive(index)}
                            className={cn(
                                POPUP_ITEM_CLASS,
                                index === active ? "bg-option-hover" : "hover:bg-option-hover/60"
                            )}
                        >
                            {item.kind === "custom" ? (
                                <EmojiPicture entry={item.entry} className="size-5 shrink-0" />
                            ) : (
                                <span className="inline-flex size-5 shrink-0 items-center justify-center text-base">
                                    {item.char}
                                </span>
                            )}
                            <span className="min-w-0 flex-1 truncate" title={label}>
                                {label}
                            </span>
                        </button>
                    </li>
                );
            })}
        </ul>
    );
});

/**
 * The list and the typed-out rule, reading the space's emoji through `custom`
 * so a list that changes while somebody is typing is the one they are offered.
 */
export function emojiExtension(custom: () => readonly CustomEmojiEntry[]) {
    return Extension.create({
        name: "polarisEmoji",

        addInputRules() {
            return [
                new InputRule({
                    find: /(?:^|\s):([A-Za-z0-9_]{2,32}):$/,
                    handler: ({ range, match, commands }) => {
                        const typed = (match[1] ?? "").toLowerCase();
                        const entry = custom().find((one) => one.name.toLowerCase() === typed);
                        if (!entry) return null;
                        // The range starts at the whitespace the pattern needed
                        // to see; that space stays where it was.
                        const lead = match[0].length - (typed.length + 2);
                        commands.insertContentAt(
                            { from: range.from + lead, to: range.to },
                            customEmojiNode(entry)
                        );
                    }
                })
            ];
        },

        addProseMirrorPlugins() {
            return [
                Suggestion({
                    editor: this.editor,
                    pluginKey: EMOJI_MENU_KEY,
                    ...emojiSuggestion(custom)
                })
            ];
        }
    });
}

function emojiSuggestion(
    custom: () => readonly CustomEmojiEntry[]
): Omit<SuggestionOptions<EmojiSuggestionItem>, "editor"> {
    return {
        char: ":",
        allowSpaces: false,
        shouldShow: ({ query }) => emojiSuggestions(query, custom()).length > 0,
        items: ({ query }) => emojiSuggestions(query, custom()),
        command: ({ editor, range, props }) => {
            const item = props as unknown as EmojiSuggestionItem;
            editor
                .chain()
                .focus()
                .insertContentAt(range, [
                    item.kind === "custom"
                        ? customEmojiNode(item.entry)
                        : { type: "text", text: item.char },
                    { type: "text", text: " " }
                ])
                .run();
        },
        render: () => {
            let renderer: ReactRenderer<SuggestionHandle, ListProps> | null = null;
            let unmount: (() => void) | null = null;
            return {
                onStart: (props) => {
                    renderer = new ReactRenderer(List, {
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
    };
}
