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

import { keepOwnScroll } from "@/lib/keep-own-scroll";
import * as refs from "./references";
import { AtSign } from "lucide-react";
import { PolarFace } from "@/components/polar/polar-bot";
import { REFERENCE, splitChannelMentions, splitPolarMentions } from "./markdown";
import { Extension } from "@tiptap/core";
import { cn } from "@polaris/ui";
import Suggestion from "@tiptap/suggestion";
import { Avatar } from "@/components/avatar";
import { ReactRenderer } from "@tiptap/react";
import { Decoration, DecorationSet } from "@tiptap/pm/view";
import type { Node as ProseNode } from "@tiptap/pm/model";
import { Plugin, PluginKey, type EditorState } from "@tiptap/pm/state";
import { PersonName, PersonRow, PlainNames } from "@/components/person-name";
import type { MentionCandidate } from "@/lib/rich-text/mention-service";
import { forwardRef, useEffect, useImperativeHandle, useState } from "react";
import type { SuggestionOptions, SuggestionProps } from "@tiptap/suggestion";

/** What the popup answers to while the caret is still in the editor. */
export interface SuggestionHandle {
    onKeyDown: (props: { event: KeyboardEvent }) => boolean;
}

/**
 * The lists that can be open under the caret, named once.
 *
 * Kept here rather than beside each plugin because something outside them needs
 * to ask whether any is open: a composer where Enter sends is a direct editor
 * prop, and direct props are consulted before plugins, so without asking it
 * would send the message out from under a list the writer was picking from.
 */
const POPUP_KEYS = {
    people: new PluginKey("polarisMentionPeople"),
    work: new PluginKey("polarisMentionWork"),
    blocks: new PluginKey("polarisBlockMenu"),
    emoji: new PluginKey("polarisEmojiMenu")
} as const;

/** The block menu's own key, so it registers as the one asked about below. */
export const BLOCK_MENU_KEY = POPUP_KEYS.blocks;

/** The `:` list's key, for the same reason. */
export const EMOJI_MENU_KEY = POPUP_KEYS.emoji;

/** Whether a list is open under the caret and owns the keys that drive it. */
export function popupOpen(state: EditorState): boolean {
    return Object.values(POPUP_KEYS).some(
        (key) => (key.getState(state) as { active?: boolean } | undefined)?.active === true
    );
}

/** The popup shell, shared with the block menu so the two match. */
export const POPUP_CLASS =
    "max-h-64 w-72 overflow-y-auto overscroll-contain rounded-lg border border-border-strong bg-elevated p-1 shadow-popover";

/**
 * What a docked list looks like: the shell edge to edge, rows a thumb can hit.
 * On the element rather than on each list, so the @, #, / and : lists - which
 * all mount through `mountPopup` - change together.
 */
export const DOCKED_CLASS =
    "data-[docked=true]:[&_ul]:w-full data-[docked=true]:[&_ul]:max-h-[var(--dock-max)] data-[docked=true]:[&_ul]:rounded-none data-[docked=true]:[&_ul]:rounded-t-xl data-[docked=true]:[&_ul]:border-x-0 data-[docked=true]:[&_ul]:border-b-0 data-[docked=true]:[&_ul]:p-1.5 data-[docked=true]:[&_li>button]:min-h-12 data-[docked=true]:[&_li>button]:gap-3 data-[docked=true]:[&_li>button]:px-3 data-[docked=true]:[&_li>button]:text-base data-[docked=true]:[&_[role=option]]:min-h-12 data-[docked=true]:[&_[role=option]]:text-base";

/**
 * What the plugin's own element is given once it is mounted.
 *
 * That element goes on the body, positioned but with no layer of its own, and
 * the descriptions these popups serve are usually written inside a dialog - a
 * layer at 50 that would otherwise draw straight over them. The pointer events
 * come back for the same reason: a modal dialog switches them off for
 * everything outside itself, and the list is outside it.
 */
export const POPUP_LAYER_CLASS = `z-[60] pointer-events-auto ${DOCKED_CLASS}`;

/**
 * Mount a popup's element where the plugin puts it, with its own scrolling
 * kept over a modal dialog - see `keepOwnScroll`.
 *
 * On a phone it is docked instead (`dockPopup`): given the editor it serves,
 * the list sits across the whole width right above the box being written in.
 */
export function mountPopup(
    mount: (element: HTMLElement) => () => void,
    element: HTMLElement,
    editorElement?: HTMLElement | null
): () => void {
    keepOwnScroll(element);
    if (editorElement && dockedLayout()) return dockPopup(element, editorElement);
    return mount(element);
}

/** A phone: narrow and touched. A narrow desktop window keeps the popover. */
const DOCK_QUERY = "(max-width: 640px) and (pointer: coarse)";

export function dockedLayout(): boolean {
    return typeof window !== "undefined" && typeof window.matchMedia === "function" && window.matchMedia(DOCK_QUERY).matches;
}

/** The box the dock sits on: the composer's frame when the editor is in one. */
export const DOCK_ANCHOR_ATTRIBUTE = "data-popup-dock";

/**
 * Where a docked list goes, worked out from numbers alone so it can be
 * asserted: across the visible width, its bottom edge on the top of the box
 * being written in, and no taller than the room above that box - with the
 * keyboard open, the visual viewport is what is left of the screen, and a list
 * taller than that would be scrolled under the top of it.
 *
 * Both rects are in layout-viewport coordinates, which is what
 * `getBoundingClientRect` answers and what `position: fixed` places by, in
 * Safari as everywhere else.
 */
export function dockFrame(
    box: { readonly top: number },
    viewport: { readonly width: number; readonly height: number; readonly offsetTop: number; readonly offsetLeft: number },
    layoutHeight: number
): { left: number; width: number; bottom: number; maxHeight: number } {
    const room = box.top - viewport.offsetTop - 8;
    return {
        left: Math.round(viewport.offsetLeft),
        width: Math.round(viewport.width),
        bottom: Math.max(0, Math.round(layoutHeight - box.top)),
        maxHeight: Math.max(96, Math.round(Math.min(room, viewport.height * 0.5)))
    };
}

/**
 * The phone picker: Discord's and WhatsApp's, docked on the composer rather
 * than floating at the caret. A popover sized for a mouse, hanging off a caret
 * near the bottom of a phone, was half under the keyboard and a third as wide
 * as the thumb reaching for it.
 *
 * Follows the visual viewport, so it rides up with the keyboard and back down
 * with it, and the box itself, which grows as a message gets longer.
 */
function dockPopup(element: HTMLElement, editorElement: HTMLElement): () => void {
    const box = (editorElement.closest(`[${DOCK_ANCHOR_ATTRIBUTE}]`) as HTMLElement | null) ?? editorElement;
    element.dataset.docked = "true";
    Object.assign(element.style, {
        position: "fixed",
        top: "auto",
        paddingLeft: "env(safe-area-inset-left)",
        paddingRight: "env(safe-area-inset-right)"
    });
    document.body.appendChild(element);
    let frame = 0;
    const place = () => {
        frame = 0;
        const viewport = window.visualViewport;
        const placed = dockFrame(
            box.getBoundingClientRect(),
            viewport
                ? { width: viewport.width, height: viewport.height, offsetTop: viewport.offsetTop, offsetLeft: viewport.offsetLeft }
                : { width: window.innerWidth, height: window.innerHeight, offsetTop: 0, offsetLeft: 0 },
            window.innerHeight
        );
        element.style.left = `${placed.left}px`;
        element.style.width = `${placed.width}px`;
        element.style.bottom = `${placed.bottom}px`;
        element.style.setProperty("--dock-max", `${placed.maxHeight}px`);
    };
    const soon = () => {
        if (!frame) frame = requestAnimationFrame(place);
    };
    place();
    window.visualViewport?.addEventListener("resize", soon);
    window.visualViewport?.addEventListener("scroll", soon);
    window.addEventListener("resize", soon);
    const watch = typeof ResizeObserver === "function" ? new ResizeObserver(soon) : null;
    watch?.observe(box);
    return () => {
        if (frame) cancelAnimationFrame(frame);
        window.visualViewport?.removeEventListener("resize", soon);
        window.visualViewport?.removeEventListener("scroll", soon);
        window.removeEventListener("resize", soon);
        watch?.disconnect();
        element.remove();
    };
}



/** One row of either popup. */
export const POPUP_ITEM_CLASS =
    "flex w-full items-center gap-2 rounded-md px-2 py-1.5 text-start text-sm";

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
    readonly id: "everyone" | "here" | "polar";
    readonly label: string;
    readonly detail: string;
    readonly image: null;
}

/** What either popup can offer: something to point at, or the room itself. */
export type SuggestionItem = MentionCandidate | RoomSuggestion;

/**
 * The room mentions matching what has been typed. `@all` is a spelling of
 * `@everyone` the parser already takes, so it finds it too.
 *
 * A room mention is one word, and nothing once there is a space after it. The
 * picker allows spaces - people's names have them - and a room mention is put in
 * as plain text, `@everyone ` with its space, so the picker was still open over
 * what it had just written and offering it again: Enter picked it a second time,
 * added another space, and the message was never sent.
 */
/** Polar, which answers in the conversation when it is named (`lib/chat/polar-mention`). */
const POLAR_MENTION: RoomSuggestion = {
    kind: "room",
    id: "polar",
    label: "@polar",
    detail: "Ask Polar",
    image: null
};

export function roomMatches(
    query: string,
    offers: { rooms: boolean; polar: boolean } = { rooms: true, polar: false }
): RoomSuggestion[] {
    if (/\s/.test(query)) return [];
    const needle = query.toLowerCase();
    const listed = [
        ...(offers.rooms ? ROOM_MENTIONS : []),
        ...(offers.polar ? [POLAR_MENTION] : [])
    ];
    if (needle.length === 0) return listed;
    return listed.filter(
        (room) => room.id.startsWith(needle) || (room.id === "everyone" && "all".startsWith(needle))
    );
}

/** Somebody the screen already has, as a caller hands them in. */
export interface KnownPerson {
    readonly id: string;
    readonly label: string;
    /** The handle, "@ana", where the screen knows it. */
    readonly detail?: string;
    readonly image?: string | null;
}

/** The people a screen has, as picker rows: once each, nameless ones left out. */
export function seededPeople(known: readonly KnownPerson[] | undefined): MentionCandidate[] {
    const seen = new Set<string>();
    const rows: MentionCandidate[] = [];
    for (const person of known ?? []) {
        if (!person.id || !person.label.trim() || seen.has(person.id)) continue;
        seen.add(person.id);
        rows.push({ kind: "user", id: person.id, label: person.label, detail: person.detail ?? "", image: person.image ?? null });
    }
    return rows;
}

/**
 * The people already known that answer what is typed, then whoever a search
 * found that was not among them.
 *
 * Known people keep their place when the answer lands - only their line is
 * swapped for the server's, which knows the nickname and the handle - so the
 * row under somebody's thumb never moves. A search adds people; it never takes
 * one away from a list that was right before it answered.
 */
export function mergeKnown(
    query: string,
    known: readonly MentionCandidate[],
    found: readonly MentionCandidate[]
): MentionCandidate[] {
    const key = (row: MentionCandidate) => `${row.kind}-${row.id}`;
    const answered = new Map(found.map((row) => [key(row), row] as const));
    const first = known
        .filter((row) => matchesTyped(row.label, query) || (row.detail !== "" && matchesTyped(row.detail, query)))
        .map((row) => answered.get(key(row)) ?? row);
    const placed = new Set(first.map(key));
    return [...first, ...found.filter((row) => !placed.has(key(row)))];
}

/** How a caller looks candidates up, so this file needs no server import. */
export type MentionSearch = (
    kinds: readonly refs.ReferenceKind[],
    query: string
) => Promise<MentionCandidate[]>;

/** The popup's own props: the plugin's, with the rows to draw already chosen. */
type ListProps = SuggestionProps<SuggestionItem>;

const List = forwardRef<SuggestionHandle, ListProps>(function List(props, ref) {
    const [active, setActive] = useState(0);
    const items = props.items;
    // A phone draws the list docked, with rows and faces a thumb can find.
    const [docked] = useState(dockedLayout);

    // Back to the top when the rows are a different list, not when the same
    // rows come back from the server again: a highlight that jumps while
    // somebody is pressing the arrows sends Enter to the wrong person.
    const signature = items.map((item) => `${item.kind}-${item.id}`).join("|");
    useEffect(() => setActive(0), [signature]);

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

    // Nothing found is not a message. Somebody who typed "@" and kept writing an
    // ordinary sentence is not looking at a picker, and telling them their
    // sentence matches nobody is answering a question they never asked.
    if (items.length === 0) return null;

    // Plain, like every other picker: an @ list is read at typing speed to find
    // one name, and plates and coloured names down it are noise between the
    // reader and the person they are looking for.
    return (
        <PlainNames>
            <ul className={POPUP_CLASS}>
                {items.map((item, index) => (
                    <li key={`${item.kind}-${item.id}`}>
                        <PersonRow
                            as="button"
                            // A team or a task is not somebody, and only a person
                            // has a plate to wear.
                            personId={item.kind === "user" ? item.id : null}
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
                                index === active ? "bg-option-hover" : "hover:bg-option-hover/60"
                            )}
                        >
                            {item.kind === "user" ? (
                                <Avatar
                                    person={{ id: item.id, name: item.label, image: item.image }}
                                    size={docked ? 32 : 20}
                                />
                            ) : item.kind === "room" && item.id === "polar" ? (
                                <PolarFace size={20} />
                            ) : item.kind === "room" ? (
                                <span className="inline-flex size-5 shrink-0 items-center justify-center rounded bg-primary/10 text-[0.6875rem] text-primary">
                                    <AtSign className="size-3 shrink-0" />
                                </span>
                            ) : (
                                <span className="inline-flex size-5 shrink-0 items-center justify-center rounded bg-muted text-[0.625rem] uppercase text-muted-foreground">
                                    {item.kind.slice(0, 1)}
                                </span>
                            )}
                            <span className="min-w-0 flex-1 truncate" title={item.label}>
                                <PersonName
                                    id={item.kind === "user" ? item.id : null}
                                    name={item.label}
                                />
                            </span>
                            {item.detail && (
                                <span className="max-w-[9rem] shrink-0 truncate text-[0.6875rem] text-muted-foreground">
                                    {item.detail}
                                </span>
                            )}
                        </PersonRow>
                    </li>
                ))}
            </ul>
        </PlainNames>
    );
});

/**
 * Both triggers, as one extension.
 *
 * @ names somebody, which tells them; # points at work, which does not. Keeping
 * them apart is what lets a description mention a task without notifying half a
 * team, and it means neither list has to be filtered by what the reader meant.
 */
/** The look a room word or `@polar` has once a message is sent, so it has the
 *  same one while it is being written. */
const WORD_MENTION_CLASS = "rounded bg-primary/15 px-0.5 font-medium text-primary";

/**
 * `@everyone`, `@here` and `@polar` drawn as mentions in the editor.
 *
 * They are kept as the words that were typed - that is what the server reads -
 * so without this, picking one from the list put back plain text and the chip
 * the list had just shown was gone. A decoration changes the look and nothing
 * else: the document, and so the message, stay the words. Never inside code,
 * where the reader does not draw them either.
 */
export function wordMentionDecorations(doc: ProseNode, rooms: boolean, polar: boolean): DecorationSet {
    const found: Decoration[] = [];
    doc.descendants((node, position) => {
        if (node.type.name === "codeBlock") return false;
        if (!node.isText || node.marks.some((mark) => mark.type.name === "code")) return true;
        let at = position;
        for (const part of splitChannelMentions(node.text ?? "")) {
            if (part.mention && rooms) found.push(Decoration.inline(at, at + part.text.length, { class: WORD_MENTION_CLASS }));
            if (!part.mention && polar) {
                let inner = at;
                for (const run of splitPolarMentions(part.text)) {
                    if (run.polar) found.push(Decoration.inline(inner, inner + run.text.length, { class: WORD_MENTION_CLASS }));
                    inner += run.text.length;
                }
            }
            at += part.text.length;
        }
        return true;
    });
    return DecorationSet.create(doc, found);
}

/** The quieter words beside `@everyone`, `@here` and `@polar`, in the reader's
 *  language. */
export type RoomWords = (id: RoomSuggestion["id"]) => string;

export function mentionExtension(
    search: MentionSearch,
    rooms = false,
    polar = false,
    words?: RoomWords,
    /** The people the screen already has, read each time the list is drawn. */
    known: () => readonly MentionCandidate[] = () => []
) {
    return Extension.create({
        name: "polarisMentions",
        addProseMirrorPlugins() {
            return [
                new Plugin({
                    key: new PluginKey("polarisWordMentions"),
                    props: {
                        decorations: (state) =>
                            rooms || polar ? wordMentionDecorations(state.doc, rooms, polar) : null
                    }
                }),
                Suggestion({
                    editor: this.editor,
                    pluginKey: POPUP_KEYS.people,
                    ...mentionSuggestion("@", ["user", "team"], search, rooms, polar, words, known)
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
/** A room word, or `@polar`, written out and followed by a space: what picking
 *  one leaves behind. Built from the same lists the picker offers, so a word
 *  added there closes the picker too - `@polar` was missing from a copy of
 *  this and kept the picker open over itself, so Enter broke the line or
 *  picked it again instead of sending. */
const FINISHED_ROOM_WORD = new RegExp(
    `^(${[...ROOM_MENTIONS.map((room) => room.id), "all", POLAR_MENTION.id].join("|")})\\s`,
    "i"
);

export function queryFits(char: string, query: string): boolean {
    if (query === "") return true;
    // A space straight after the trigger is the tell: nobody starts a name with
    // one, and "@ " or "# " is punctuation or a Markdown heading.
    if (/^\s/.test(query)) return false;
    // A room mention written out and followed by a space is finished. Picking
    // one puts it in as text, and the picker has to be gone the moment it is -
    // not after a search comes back - or the next Enter picks it again rather
    // than sending the message.
    if (char === "@" && FINISHED_ROOM_WORD.test(query)) return false;
    if (char === "@") return query.length <= MAX_QUERY.person && PERSON_QUERY.test(query);
    // A title can hold almost anything, so the only limit is length.
    return query.length <= MAX_QUERY.work;
}

/** How many answers a picker keeps, and for how long one is trusted. */
const ANSWERS_KEPT = 30;
const ANSWER_TTL_MS = 30_000;

/** Case and accents aside, so "jose" finds "José". */
function folded(text: string): string {
    return text.normalize("NFD").replace(/\p{M}/gu, "").toLowerCase();
}

/** Whether a name answers what was typed: every typed word starts one of its
 *  words. Only narrows rows already found while the server is asked again. */
export function matchesTyped(label: string, query: string): boolean {
    const typed = folded(query).split(/\s+/).filter(Boolean);
    if (typed.length === 0) return true;
    const parts = folded(label).split(/[\s._@-]+/).filter(Boolean);
    return typed.every((word) => parts.some((part) => part.startsWith(word)));
}

/**
 * People first and the room words after them, except when what is typed is
 * plainly one of those words: "@pol" is somebody reaching for Polar, and
 * leaving it under a column of names that merely contain the letters made Enter
 * pick the wrong one.
 *
 * Naming somebody is what a mention is for nearly every time one is typed, and
 * a fixed pair pinned to the top pushed the first real name down - so on an
 * empty or one-letter query the room words stay at the bottom.
 */
export function ordered(
    query: string,
    people: readonly MentionCandidate[],
    rooms: readonly RoomSuggestion[]
): SuggestionItem[] {
    const typed = query.trim().toLowerCase();
    const reaching =
        typed.length >= 2
            ? rooms.filter(
                  (room) =>
                      room.id.startsWith(typed) || (room.id === "everyone" && "all".startsWith(typed))
              )
            : [];
    if (reaching.length === 0) return [...people, ...rooms];
    return [...reaching, ...people, ...rooms.filter((room) => !reaching.includes(room))];
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
    rooms = false,
    /** Whether Polar can be asked here, which any conversation allows. */
    polar = false,
    words?: RoomWords,
    known: () => readonly MentionCandidate[] = () => []
): Omit<SuggestionOptions<SuggestionItem>, "editor"> {
    /** The room words matching a query, in the reader's language. Worked out
     *  here rather than waited for: they never come from the server. */
    const named = (query: string): RoomSuggestion[] =>
        (rooms || polar) && char === "@"
            ? roomMatches(query, { rooms, polar }).map((room) =>
                  words ? { ...room, detail: words(room.id) } : room
              )
            : [];
    /**
     * Answers already had, by query, for a short while: typing back over a
     * name, or opening the picker again, draws at once instead of waiting on
     * the same search. Bounded, oldest first out.
     */
    const answers = new Map<string, { items: MentionCandidate[]; at: number }>();
    const remember = (query: string, items: MentionCandidate[]) => {
        answers.delete(query);
        answers.set(query, { items, at: Date.now() });
        while (answers.size > ANSWERS_KEPT) {
            const oldest = answers.keys().next().value;
            if (oldest === undefined) break;
            answers.delete(oldest);
        }
    };
    const fresh = (query: string): MentionCandidate[] | null => {
        const kept = answers.get(query);
        return kept && Date.now() - kept.at < ANSWER_TTL_MS ? kept.items : null;
    };
    /** The people last drawn, kept on screen while the next search runs. */
    let lastPeople: MentionCandidate[] = [];
    /**
     * What to draw while a search is on its way: the last answer narrowed to
     * what is typed now, and the room words, which need no answer. Never a
     * skeleton - the list Discord draws under "@" is the one it already has,
     * narrowed as you type, and it never blanks to wait.
     */
    const meanwhile = (query: string): SuggestionItem[] => {
        const people =
            fresh(query) ?? lastPeople.filter((person) => matchesTyped(person.label, query));
        return ordered(query, mergeKnown(query, known(), people), named(query));
    };

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
            const people = fresh(query) ?? (await search(kinds, query));
            remember(query, people);
            lastPeople = people;
            return ordered(query, mergeKnown(query, known(), people), named(query));
        },

        command: ({ editor, range, props }) => {
            const item = props as unknown as SuggestionItem;
            // The room mentions are words rather than references: what makes them
            // work is the text itself, read again when the message lands.
            if (item.kind === "room") {
                editor.chain().focus().insertContentAt(range, `${item.label} `).run();
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

            // While a search is out the plugin hands over an empty list; the
            // rows drawn are the ones there is something to say about now.
            const drawn = (props: SuggestionProps<SuggestionItem>): ListProps =>
                props.loading && props.items.length === 0
                    ? { ...props, items: meanwhile(props.query) }
                    : props;

            return {
                onStart: (props) => {
                    renderer = new ReactRenderer(List, {
                        props: drawn(props),
                        editor: props.editor,
                        className: POPUP_LAYER_CLASS
                    });
                    unmount = mountPopup(props.mount, renderer.element as HTMLElement, props.editor.view.dom);
                },
                onUpdate: (props) => renderer?.updateProps(drawn(props)),
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
