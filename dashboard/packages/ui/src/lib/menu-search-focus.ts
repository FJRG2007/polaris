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

import type { FocusEvent } from "react";

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
