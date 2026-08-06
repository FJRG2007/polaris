"use client";

/**
 * The list that opens under the caret.
 *
 * Two triggers use it and they behave identically: @ names people and teams, #
 * points at work. Both draw the same popup, are driven with the same keys, and
 * insert the same kind of node - which is the reason this is one component with
 * a parameter rather than two that drift.
 *
 * Positioning is handed to the suggestion plugin's own mount, so the list stays
 * with the caret through a scroll or a resize without this file owning a single
 * listener.
 */

import * as refs from "./references";
import { REFERENCE } from "./markdown";
import { Extension } from "@tiptap/core";
import { cn, Skeleton } from "@polaris/ui";
import Suggestion from "@tiptap/suggestion";
import { Avatar } from "@/components/avatar";
import { PluginKey } from "@tiptap/pm/state";
import { ReactRenderer } from "@tiptap/react";
import type { MentionCandidate } from "@/lib/rich-text/mention-service";
import { forwardRef, useEffect, useImperativeHandle, useState } from "react";
import type { SuggestionOptions, SuggestionProps } from "@tiptap/suggestion";

/** What the popup answers to while the caret is still in the editor. */
export interface SuggestionHandle {
    onKeyDown: (props: { event: KeyboardEvent }) => boolean;
}

/** The popup shell, shared with the block menu so the two match. */
export const POPUP_CLASS = "max-h-64 w-72 overflow-y-auto rounded-lg border border-border bg-popover p-1 shadow-lg";

/** One row of either popup. */
export const POPUP_ITEM_CLASS = "flex w-full items-center gap-2 rounded-md px-2 py-1.5 text-left text-sm";

/** How a caller looks candidates up, so this file needs no server import. */
export type MentionSearch = (kinds: readonly refs.ReferenceKind[], query: string) => Promise<MentionCandidate[]>;

/** The popup's own props on top of the ones the plugin supplies. */
type ListProps = SuggestionProps<MentionCandidate> & { searching: boolean };

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
            if (event.key === "ArrowDown") {
                setActive((current) => (current + 1) % Math.max(items.length, 1));
                return true;
            }
            if (event.key === "ArrowUp") {
                setActive((current) => (current + items.length - 1) % Math.max(items.length, 1));
                return true;
            }
            if (event.key === "Enter" || event.key === "Tab") {
                choose(active);
                return true;
            }
            return false;
        }
    }));

    if (props.searching && items.length === 0) {
        return (
            <div className="w-72 rounded-lg border border-border bg-popover p-2 shadow-lg">
                <Skeleton className="h-6 w-full" />
            </div>
        );
    }

    if (items.length === 0) {
        return (
            <div className="w-72 rounded-lg border border-border bg-popover px-3 py-2 text-xs text-muted-foreground shadow-lg">
                Nothing matches that.
            </div>
        );
    }

    return (
        <ul className={POPUP_CLASS}>
            {items.map((item, index) => (
                    <li key={`${item.kind}-${item.id}`}>
                        <button
                            type="button"
                            // Pointer down rather than click: the editor takes the
                            // focus back on mouse up, and a click fired after that
                            // lands with the caret already moved.
                            onMouseDown={(event) => {
                                event.preventDefault();
                                choose(index);
                            }}
                            onMouseEnter={() => setActive(index)}
                            className={cn(POPUP_ITEM_CLASS, index === active ? "bg-muted" : "hover:bg-muted/60")}
                        >
                            {item.kind === "user" ? (
                                <Avatar person={{ id: item.id, name: item.label, image: item.image }} size={20} />
                            ) : (
                                <span className="inline-flex size-5 shrink-0 items-center justify-center rounded bg-muted text-[10px] uppercase text-muted-foreground">
                                    {item.kind.slice(0, 1)}
                                </span>
                            )}
                            <span className="min-w-0 flex-1 truncate" title={item.label}>{item.label}</span>
                            {item.detail && (
                                <span className="max-w-[9rem] shrink-0 truncate text-[11px] text-muted-foreground">
                                    {item.detail}
                                </span>
                            )}
                        </button>
                    </li>
            ))}
        </ul>
    );
});

/**
 * Both triggers, as one extension.
 *
 * @ names somebody, which tells them; # points at work, which does not. Keeping
 * them apart is what lets a description mention a task without notifying half a
 * team, and it means neither list has to be filtered by what the reader meant.
 */
export function mentionExtension(search: MentionSearch) {
    return Extension.create({
        name: "polarisMentions",
        addProseMirrorPlugins() {
            return [
                Suggestion({
                    editor: this.editor,
                    pluginKey: new PluginKey("polarisMentionPeople"),
                    ...mentionSuggestion("@", ["user", "team"], search)
                }),
                Suggestion({
                    editor: this.editor,
                    pluginKey: new PluginKey("polarisMentionWork"),
                    ...mentionSuggestion("#", ["task", "doc", "note"], search)
                })
            ];
        }
    });
}

/**
 * Wire one trigger character to the picker.
 *
 * @param char - What opens it: "@" for people, "#" for work.
 * @param kinds - What that trigger is allowed to find.
 * @param search - How to look candidates up.
 */
function mentionSuggestion(
    char: string,
    kinds: readonly refs.ReferenceKind[],
    search: MentionSearch
): Omit<SuggestionOptions<MentionCandidate>, "editor"> {
    // Whether a lookup is in flight. The plugin opens the popup before the first
    // answer arrives, and an empty list is otherwise indistinguishable from a
    // search that genuinely found nothing.
    let searching = true;

    return {
        char,
        // A mention is a name, and names have spaces in them. Without this,
        // typing "@Ana Ruiz" closes the picker on the space and inserts nothing.
        allowSpaces: true,
        items: async ({ query }) => {
            searching = true;
            try {
                return await search(kinds, query);
            } finally {
                searching = false;
            }
        },

        command: ({ editor, range, props }) => {
            const item = props as unknown as MentionCandidate;
            editor
                .chain()
                .focus()
                .insertContentAt(range, [
                    { type: REFERENCE, attrs: { kind: item.kind, id: item.id, label: item.label } },
                    { type: "text", text: " " }
                ])
                .run();
        },

        render: () => {
            let renderer: ReactRenderer<SuggestionHandle, ListProps> | null = null;
            let unmount: (() => void) | null = null;

            return {
                onStart: (props) => {
                    renderer = new ReactRenderer(List, { props: { ...props, searching }, editor: props.editor });
                    unmount = props.mount(renderer.element as HTMLElement);
                },
                onUpdate: (props) => renderer?.updateProps({ ...props, searching }),
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
