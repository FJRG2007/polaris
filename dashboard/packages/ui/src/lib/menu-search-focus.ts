"use client";

/**
 * Handing a menu's focus to the field at the top of it.
 *
 * A menu takes focus for itself as it opens - it has to, since a menu is driven
 * by the keyboard. A menu with a search field at the top wants the opposite, and
 * the field used to try to win by taking focus a tick later. That is a race: it
 * is decided by whether the menu's own focus lands before or after that tick,
 * which depends on the animation, the machine and whether the surface was being
 * rebuilt or was already there. When the field loses it, every letter typed goes
 * to the menu's type-ahead instead - the name is never typed anywhere, and enter
 * then means whatever the jumping about had left highlighted.
 *
 * So the field stops racing and answers instead: the moment the surface itself
 * takes focus, it hands it straight on. Whatever order the two happen in, the
 * field has the last word, and there is no tick to be beaten by a slow frame.
 *
 * Only when the surface itself is the thing being focused. Focus landing on one
 * of the options is somebody having pressed an arrow key to get there, and
 * dragging them back to the field would make a menu with a search box the one
 * menu that cannot be walked with the keyboard.
 */

import type { FocusEvent, PointerEvent } from "react";

/** What a search field marks itself with so the menu around it can find it. */
export const MENU_SEARCH_ATTRIBUTE = "data-menu-search";

/**
 * The handler a menu surface puts on its own focus.
 *
 * Does nothing at all for a menu with no search field in it, which is almost all
 * of them: those keep the ordinary behaviour, where the surface holds the focus
 * and the arrow keys walk the options.
 */
export function redirectMenuFocus(event: FocusEvent<HTMLElement>): void {
    if (event.target !== event.currentTarget) return;
    const field = event.currentTarget.querySelector<HTMLElement>(`[${MENU_SEARCH_ATTRIBUTE}]`);
    if (!field) return;
    field.focus();
    // Selected as well as focused, so a surface reopened with an old search in
    // it is typed over rather than typed onto.
    if (field instanceof HTMLInputElement || field instanceof HTMLTextAreaElement) field.select();
}

/**
 * Keeping the keyboard where the typing is.
 *
 * A menu option takes focus when the mouse passes over it - that is how a menu
 * is meant to work, and how enter commits whatever is under the pointer. In a
 * menu with a search field at the top it is the whole thing broken: the menu
 * opens directly under the pointer that just clicked the trigger, the smallest
 * movement over the list hands focus to an option, and from then on the letters
 * go to the menu's type-ahead and enter picks the option that happened to be
 * highlighted. What that looks like from outside is a search box that ignores
 * enter until you press it twice - and, quietly, an option chosen that nobody
 * asked for.
 *
 * So in a menu that has one of these fields, hovering no longer moves the
 * focus. Everything else about hovering is untouched: the option still lights up
 * (that is CSS), still activates on a click, and the arrow keys still walk the
 * list from the field. A submenu's trigger is left alone, since a submenu that
 * only opened on a click would be a worse menu than the one this is fixing.
 */
export function keepSearchFocus(event: PointerEvent<HTMLElement>): void {
    const surface = event.currentTarget;
    if (!surface.querySelector(`[${MENU_SEARCH_ATTRIBUTE}]`)) return;
    const target = event.target as HTMLElement | null;
    const item = target?.closest?.("[role='menuitem']");
    if (!item || item.getAttribute("aria-haspopup") === "menu") return;
    // Read by the option's own handler, which is what focuses it. Prevented in
    // the capture phase, so it is already true by the time that runs.
    event.preventDefault();
}
