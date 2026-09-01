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
import { AtSign } from "lucide-react";
import { Avatar } from "@/components/avatar";
import { ReactRenderer } from "@tiptap/react";
import { PluginKey, type EditorState } from "@tiptap/pm/state";
import type { MentionCandidate } from "@/lib/rich-text/mention-service";
import { forwardRef, useEffect, useImperativeHandle, useState } from "react";
import type { SuggestionOptions, SuggestionProps } from "@tiptap/suggestion";

/** What the popup answers to while the caret is still in the editor. */
export interface SuggestionHandle {
    onKeyDown: (props: { event: KeyboardEvent }) => boolean;
}

/**
 * The three lists that can be open under the caret, named once.
 *
 * Kept here rather than beside each plugin because something outside them needs
 * to ask whether any is open: a composer where Enter sends is a direct editor
 * prop, and direct props are consulted before plugins, so without asking it
 * would send the message out from under a list the writer was picking from.
 */
const POPUP_KEYS = {
    people: new PluginKey("polarisMentionPeople"),
    work: new PluginKey("polarisMentionWork"),
    blocks: new PluginKey("polarisBlockMenu")
} as const;

/** The block menu's own key, so it registers as the one asked about below. */
export const BLOCK_MENU_KEY = POPUP_KEYS.blocks;

/** Whether a list is open under the caret and owns the keys that drive it. */
export function popupOpen(state: EditorState): boolean {
    return Object.values(POPUP_KEYS).some(
        (key) => (key.getState(state) as { active?: boolean } | undefined)?.active === true
    );
}

/** The popup shell, shared with the block menu so the two match. */
export const POPUP_CLASS =
    "max-h-64 w-72 overflow-y-auto rounded-lg border border-border-strong bg-elevated p-1 shadow-popover";

/**
 * What the plugin's own element is given once it is mounted.
 *
 * That element goes on the body, positioned but with no layer of its own, and
 * the descriptions these popups serve are usually written inside a dialog - a
 * layer at 50 that would otherwise draw straight over them. The pointer events
 * come back for the same reason: a modal dialog switches them off for
 * everything outside itself, and the list is outside it.
 */
export const POPUP_LAYER_CLASS = "z-[60] pointer-events-auto";

/** One row of either popup. */
export const POPUP_ITEM_CLASS =
    "flex w-full items-center gap-2 rounded-md px-2 py-1.5 text-left text-sm";

/**
 * The two mentions that name the room rather than a person.
 *
 * They are stored as the words somebody typed - there is nothing to point at,
 * because they mean "this conversation" - so they are not references and cannot
 * be found by a search. They are offered here because a mention nobody can
 * discover may as well not exist: everybody knows @everyone from somewhere else
 * and expects the list to confirm it, and this is also where the difference
 * between the two gets said out loud.
 */
const ROOM_MENTIONS: readonly RoomSuggestion[] = [
    {
        kind: "room",
        id: "everyone",
        label: "@everyone",
        detail: "Everybody in this conversation",
        image: null
    },
    { kind: "room", id: "here", label: "@here", detail: "Whoever is online now", image: null }
];

export interface RoomSuggestion {
    readonly kind: "room";
    readonly id: "everyone" | "here";
    readonly label: string;
    readonly detail: string;
    readonly image: null;
}

/** What either popup can offer: something to point at, or the room itself. */
export type SuggestionItem = MentionCandidate | RoomSuggestion;

/** The room mentions matching what has been typed. `@all` is a spelling of
 *  `@everyone` the parser already takes, so it finds it too. */
function roomMatches(query: string): RoomSuggestion[] {
    const needle = query.trim().toLowerCase();
    if (needle.length === 0) return [...ROOM_MENTIONS];
    return ROOM_MENTIONS.filter(
        (room) =>
            room.id.startsWith(needle) || (room.id === "everyone" && "all".startsWith(needle))
    );
}

/** How a caller looks candidates up, so this file needs no server import. */
export type MentionSearch = (
    kinds: readonly refs.ReferenceKind[],
    query: string
) => Promise<MentionCandidate[]>;

/** The popup's own props on top of the ones the plugin supplies. */
type ListProps = SuggestionProps<SuggestionItem> & { searching: boolean };

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
            // With nothing to pick, the popup is not on screen and must not eat
            // the keys: Enter belongs to the paragraph or to the composer's send.
            if (items.length === 0) return false;
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
            <div className="w-72 rounded-lg border border-border-strong bg-elevated p-2 shadow-popover">
                <Skeleton className="h-6 w-full" />
            </div>
        );
    }

    // Nothing found is not a message. Somebody who typed "@" and kept writing an
    // ordinary sentence is not looking at a picker, and telling them their
    // sentence matches nobody is answering a question they never asked.
    if (items.length === 0) return null;

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
                        className={cn(
                            POPUP_ITEM_CLASS,
                            index === active ? "bg-muted" : "hover:bg-muted/60"
                        )}
                    >
                        {item.kind === "user" ? (
                            <Avatar
                                person={{ id: item.id, name: item.label, image: item.image }}
                                size={20}
                            />
                        ) : item.kind === "room" ? (
                            <span className="inline-flex size-5 shrink-0 items-center justify-center rounded bg-primary/10 text-[0.6875rem] text-primary">
                                <AtSign className="size-3" />
                            </span>
                        ) : (
                            <span className="inline-flex size-5 shrink-0 items-center justify-center rounded bg-muted text-[0.625rem] uppercase text-muted-foreground">
                                {item.kind.slice(0, 1)}
                            </span>
                        )}
                        <span className="min-w-0 flex-1 truncate" title={item.label}>
                            {item.label}
                        </span>
                        {item.detail && (
                            <span className="max-w-[9rem] shrink-0 truncate text-[0.6875rem] text-muted-foreground">
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
export function mentionExtension(search: MentionSearch, rooms = false) {
    return Extension.create({
        name: "polarisMentions",
        addProseMirrorPlugins() {
            return [
                Suggestion({
                    editor: this.editor,
                    pluginKey: POPUP_KEYS.people,
                    ...mentionSuggestion("@", ["user", "team"], search, rooms)
                }),
                Suggestion({
                    editor: this.editor,
                    pluginKey: POPUP_KEYS.work,
                    ...mentionSuggestion("#", ["task", "doc", "note"], search)
                })
            ];
        }
    });
}

/** What a name, a username or an address is spelled with, plus single spaces
 *  between words so "@Ana Ruiz" survives the space in the middle of it. */
const PERSON_QUERY = /^[\p{L}\p{M}\p{N}._+'@-]+(?: [\p{L}\p{M}\p{N}._+'@-]+)*(?: )?$/u;

/** Long enough for a full name or a task title, short enough to still be a
 *  search rather than the paragraph somebody is writing. */
const MAX_QUERY = { person: 60, work: 120 } as const;

/**
 * Whether what has been typed after the trigger is still somebody looking
 * something up.
 *
 * The trigger characters are also ordinary punctuation: "@" opens a sentence
 * about an address, "# " opens a heading. Both would otherwise leave a picker
 * hanging under the caret for the rest of the line, because the query is allowed
 * to contain spaces and a space is not an exit. So the query has to keep looking
 * like the thing the trigger finds - a name for "@", a title for "#" - and the
 * moment it stops, the popup is gone rather than sitting there saying it found
 * nothing.
 *
 * An empty query is the trigger on its own, which is the picker being opened
 * deliberately: that one always shows.
 */
export function queryFits(char: string, query: string): boolean {
    if (query === "") return true;
    // A space straight after the trigger is the tell: nobody starts a name with
    // one, and "@ " or "# " is punctuation or a Markdown heading.
    if (/^\s/.test(query)) return false;
    if (char === "@") return query.length <= MAX_QUERY.person && PERSON_QUERY.test(query);
    // A title can hold almost anything, so the only limit is length.
    return query.length <= MAX_QUERY.work;
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
    search: MentionSearch,
    /** Whether this surface is a conversation, and so has a room to name. */
    rooms = false
): Omit<SuggestionOptions<SuggestionItem>, "editor"> {
    // Whether a lookup is in flight. The plugin opens the popup before the first
    // answer arrives, and an empty list is otherwise indistinguishable from a
    // search that genuinely found nothing.
    let searching = true;

    return {
        char,
        // A mention is a name, and names have spaces in them. Without this,
        // typing "@Ana Ruiz" closes the picker on the space and inserts nothing.
        // `queryFits` is what stops that from also keeping the picker open over
        // a sentence that merely happens to start with the trigger.
        allowSpaces: true,
        shouldShow: ({ query }) => queryFits(char, query),
        items: async ({ query }) => {
            if (!queryFits(char, query)) return [];
            // First, and without waiting for anything: they are a fixed pair, and
            // somebody typing "@ev" is not going to want a person called Evan
            // ahead of the mention they were reaching for.
            const named = rooms && char === "@" ? roomMatches(query) : [];
            searching = true;
            try {
                return [...named, ...(await search(kinds, query))];
            } finally {
                searching = false;
            }
        },

        command: ({ editor, range, props }) => {
            const item = props as unknown as SuggestionItem;
            // The room mentions are words rather than references: what makes them
            // work is the text itself, read again when the message lands.
            if (item.kind === "room") {
                editor
                    .chain()
                    .focus()
                    .insertContentAt(range, `${item.label} `)
                    .run();
                return;
            }
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
                    renderer = new ReactRenderer(List, {
                        props: { ...props, searching },
                        editor: props.editor,
                        className: POPUP_LAYER_CLASS
                    });
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
