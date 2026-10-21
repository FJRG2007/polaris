"use client";

/**
 * The people somebody has corresponded with, offered under an address field.
 *
 * One source for every field that takes an address - the composer's To, Cc and
 * Bcc and the search panel's From, To and Cc - so a contact the composer offers
 * is a contact the search offers too, ranked the same way, after the same two
 * characters.
 *
 * Asked for once typing settles, and an answer that arrives after the next
 * letter was typed is dropped: it describes a query nobody is asking any more.
 * The list is drawn in a portal at the foot of the page and follows the field,
 * so the panel or dialog it opens from never clips it, and it opens upwards
 * when there is no room below.
 */

import { cn } from "@polaris/ui";
import * as core from "@polaris/core";
import { useMail } from "./mail-shell";
import { createPortal } from "react-dom";
import { suggestContactsAction } from "./actions";
import { useEffect, useLayoutEffect, useRef, useState, type RefObject } from "react";

/** How long typing settles before contacts are asked for. */
export const SUGGEST_SETTLE_MS = 200;

/** Nothing is offered before this many characters: a list that appears on the
 *  first keystroke is a list of everybody. */
export const SUGGEST_MIN_CHARS = 2;

/** What the list is marked with, so a panel that closes on a press elsewhere
 *  can tell a press on its own suggestions from one outside it. */
export const SUGGESTIONS_SELECTOR = "[data-contact-suggestions]";

export interface ContactSuggestion {
    readonly address: string;
    readonly name: string;
}

export interface ContactSuggestions {
    readonly suggestions: readonly ContactSuggestion[];
    readonly highlight: number;
    /** Arrow keys: one down or up, wrapping. */
    readonly move: (by: number) => void;
    readonly setHighlight: (index: number) => void;
    /** Shut the list until something new is typed. */
    readonly clear: () => void;
}

/** Contacts matching `typed`, minus the addresses in `exclude`. */
export function useContactSuggestions(
    typed: string,
    exclude: readonly string[] = []
): ContactSuggestions {
    const { shelf } = useMail();
    const [suggestions, setSuggestions] = useState<readonly ContactSuggestion[]>([]);
    const [highlight, setHighlight] = useState(0);
    const asked = useRef(0);
    const excludeKey = exclude.join("\n");

    useEffect(() => {
        const needle = typed.trim();
        const ticket = ++asked.current;
        if (needle.length < SUGGEST_MIN_CHARS) {
            setSuggestions([]);
            return;
        }
        const timer = setTimeout(() => {
            void suggestContactsAction(needle, shelf).then(
                (outcome) => {
                    if (ticket !== asked.current) return;
                    const held = excludeKey ? excludeKey.split("\n") : [];
                    setSuggestions(
                        outcome.suggestions.filter(
                            (one) => !held.some((address) => core.sameAddress(address, one.address))
                        )
                    );
                    setHighlight(0);
                },
                // A convenience: a failed lookup leaves a plain field that still
                // works, rather than a sentence about something nobody asked for.
                () => {
                    if (ticket === asked.current) setSuggestions([]);
                }
            );
        }, SUGGEST_SETTLE_MS);
        return () => clearTimeout(timer);
    }, [typed, excludeKey, shelf]);

    return {
        suggestions,
        highlight,
        setHighlight,
        move: (by) =>
            setHighlight((held) =>
                suggestions.length === 0 ? 0 : (held + by + suggestions.length) % suggestions.length
            ),
        clear: () => {
            // Any answer still in the air is for what was just finished.
            asked.current += 1;
            setSuggestions([]);
        }
    };
}

/** Where the list goes: under the field, or over it when the window has no
 *  room below. */
export interface Placement {
    readonly left: number;
    readonly width: number;
    readonly top?: number;
    readonly bottom?: number;
    readonly maxHeight: number;
}

const GAP = 4;
const PREFERRED_HEIGHT = 224;
const MIN_WIDTH = 240;

export function placeUnder(
    box: { top: number; bottom: number; left: number; width: number },
    viewport: { width: number; height: number }
): Placement {
    const below = viewport.height - box.bottom - GAP * 2;
    const above = box.top - GAP * 2;
    const width = Math.min(Math.max(box.width, MIN_WIDTH), viewport.width - GAP * 2);
    // Shifted back inside the window rather than hanging off its right edge.
    const left = Math.max(GAP, Math.min(box.left, viewport.width - width - GAP));
    if (below >= PREFERRED_HEIGHT || below >= above) {
        return { left, width, top: box.bottom + GAP, maxHeight: Math.min(below, PREFERRED_HEIGHT) };
    }
    return {
        left,
        width,
        bottom: viewport.height - box.top + GAP,
        maxHeight: Math.min(above, PREFERRED_HEIGHT)
    };
}

export function ContactSuggestionList({
    anchor,
    suggestions,
    highlight,
    onHighlight,
    onChoose
}: {
    /** What the list hangs from - the field, or the box around its chips. */
    anchor: RefObject<HTMLElement | null>;
    suggestions: readonly ContactSuggestion[];
    highlight: number;
    onHighlight: (index: number) => void;
    onChoose: (entry: ContactSuggestion) => void;
}) {
    const [place, setPlace] = useState<Placement | null>(null);
    const showing = suggestions.length > 0;

    // Measured before paint and again on any scroll - captured, because what
    // scrolls is usually an ancestor rather than the window.
    useLayoutEffect(() => {
        if (!showing) {
            setPlace(null);
            return;
        }
        const measure = (): void => {
            const node = anchor.current;
            if (!node) return;
            setPlace(
                placeUnder(node.getBoundingClientRect(), {
                    width: window.innerWidth,
                    height: window.innerHeight
                })
            );
        };
        measure();
        window.addEventListener("scroll", measure, true);
        window.addEventListener("resize", measure);
        return () => {
            window.removeEventListener("scroll", measure, true);
            window.removeEventListener("resize", measure);
        };
    }, [anchor, showing]);

    if (!showing || !place || typeof document === "undefined") return null;
    return createPortal(
        <ul
            role="listbox"
            data-contact-suggestions=""
            style={{
                left: place.left,
                width: place.width,
                top: place.top,
                bottom: place.bottom,
                maxHeight: place.maxHeight
            }}
            // Above a dialog, which sits at z-50, and back on for the pointer: a
            // modal turns pointer events off on the body this is drawn in.
            className="pointer-events-auto fixed z-[60] overflow-y-auto overscroll-contain rounded-md border border-border bg-elevated py-1 shadow-popover"
        >
            {suggestions.map((entry, index) => (
                <li key={entry.address} role="option" aria-selected={index === highlight}>
                    <button
                        type="button"
                        tabIndex={-1}
                        className={cn(
                            "flex w-full min-w-0 items-baseline gap-2 px-2 py-1.5 text-left text-[13px]",
                            index === highlight
                                ? "bg-option-hover text-foreground"
                                : "text-muted-foreground"
                        )}
                        // Pressing a suggestion must not blur the field first, or
                        // what was half typed is taken as the answer instead.
                        onMouseDown={(event) => event.preventDefault()}
                        onMouseEnter={() => onHighlight(index)}
                        onClick={() => onChoose(entry)}
                    >
                        <span className="min-w-0 truncate text-foreground">
                            {core.addressName(entry)}
                        </span>
                        {entry.name.trim() ? (
                            <span className="min-w-0 truncate text-[12px] text-foreground-subtle">
                                {entry.address}
                            </span>
                        ) : null}
                    </button>
                </li>
            ))}
        </ul>,
        document.body
    );
}
