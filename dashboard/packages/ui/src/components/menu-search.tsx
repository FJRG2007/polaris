"use client";

/**
 * The field at the top of a menu that narrows what the menu is listing.
 *
 * A menu is built to be driven by the keyboard, and both halves of that fight a
 * text field. The surface claims focus as it opens, which undoes the field's
 * `autoFocus` before anybody can type into it; and from then on every character
 * is read as a jump to the option beginning with that letter, so the first
 * keystroke moves focus off the field.
 *
 * The opening is settled by the surface rather than here: a menu that finds one
 * of these inside it gives it the focus instead of taking it, so there is no
 * moment when the two disagree about who is being typed into (see
 * `focusMenuSearch`). This still asks for focus a tick after mounting, which is
 * what brings a kept submenu back to the field when it reappears without
 * opening. What the field then does is keep its own typing - and its own enter -
 * to itself.
 *
 * What still belongs to the menu is handed back: escape closes it, tab is
 * refused there as it is anywhere in a menu, and the arrows step into the
 * options - a step this has to make itself, since a menu only moves focus for a
 * key pressed on the surface rather than in something drawn on it.
 */

import { cn } from "../lib/cn";
import { Search } from "lucide-react";
import type { KeyboardEvent } from "react";
import { useMenuSurface } from "../lib/menu-surface";
import { useDeferredFocus } from "../lib/use-deferred-focus";
import { MENU_SEARCH_ATTRIBUTE } from "../lib/menu-search-focus";

/** Keys the menu around the field still answers for. */
const MENU_KEYS = new Set(["Escape", "Tab", "ArrowLeft", "ArrowRight"]);

/**
 * Whether an option survives what has been typed.
 *
 * Any part of the name counts, not only its start: somebody looking for
 * "Website design" is as likely to type "design" as to type the first word, and
 * a filter that only matches the front reads as a list that has lost things.
 */
export function menuSearchMatches(name: string, query: string): boolean {
    const needle = query.trim().toLowerCase();
    return needle.length === 0 || name.toLowerCase().includes(needle);
}

/** The options of the menu this field sits in, in the order they are drawn. */
function optionsAround(field: HTMLElement): HTMLElement[] {
    const surface = field.closest("[data-radix-menu-content]");
    if (!surface) return [];
    return [...surface.querySelectorAll<HTMLElement>("[role='menuitem']:not([data-disabled])")];
}

export function MenuSearch({
    value,
    onChange,
    placeholder,
    onSubmit,
    className
}: {
    value: string;
    onChange: (value: string) => void;
    placeholder: string;
    /** What enter does where typing a name is itself a way of picking one.
     *  Without it, enter takes the first option the field has left on screen. */
    onSubmit?: () => void;
    className?: string;
}) {
    // Selected as well as focused, so a submenu reopened with an old search in
    // it is typed over rather than typed onto.
    const ref = useDeferredFocus<HTMLInputElement>(useMenuSurface().open);

    const onKeyDown = (event: KeyboardEvent<HTMLInputElement>) => {
        const options = () => optionsAround(event.currentTarget);

        if (event.key === "ArrowDown" || event.key === "ArrowUp") {
            const list = options();
            const next = event.key === "ArrowDown" ? list[0] : list[list.length - 1];
            if (!next) return;
            event.preventDefault();
            next.focus();
            return;
        }

        if (event.key === "Enter") {
            // Stopped as well as prevented. Enter typed into this field means
            // "the thing I have just written", and every layer above has its own
            // idea about enter - the menu commits whatever it thinks is
            // highlighted, a dialog around it may take it as its confirm, and a
            // form anywhere above submits itself and reloads the page.
            event.preventDefault();
            event.stopPropagation();
            if (onSubmit) onSubmit();
            else options()[0]?.click();
            return;
        }

        if (!MENU_KEYS.has(event.key)) event.stopPropagation();
    };

    return (
        <div className={cn("flex items-center gap-2 border-b border-border px-2 pb-2", className)}>
            <Search className="size-3.5 shrink-0 text-muted-foreground" />
            <input
                ref={ref}
                // What the menu around this looks for on the way open, so it can
                // hand over the focus instead of taking it.
                {...{ [MENU_SEARCH_ATTRIBUTE]: "" }}
                value={value}
                onChange={(event) => onChange(event.target.value)}
                onKeyDown={onKeyDown}
                placeholder={placeholder}
                aria-label={placeholder}
                className="w-full bg-transparent text-sm outline-none placeholder:text-muted-foreground"
            />
        </div>
    );
}
