/**
 * Keeping focus in a field that a menu put on the screen.
 *
 * Choosing "rename" or "new list" replaces a row with an input, and two things
 * take that input's focus away before anybody can type into it: the menu traps
 * focus while it is still on screen, and it hands focus back to whatever opened
 * it once it goes. A blur that commits or cancels then throws the row away, so
 * the affordance looks broken rather than merely fiddly.
 *
 * Both halves are needed: this stops the hand-back, and `useDeferredFocus`
 * claims focus once the menu is gone rather than while it is still trapping it.
 */

/** Pass as a menu's `onCloseAutoFocus` when its items hand focus to something
 *  rendered in their place. */
export function keepFocusOnClose(event: Event): void {
    event.preventDefault();
}
