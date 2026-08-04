/**
 * Whether something other than the screen owns the keyboard right now.
 *
 * A single-letter shortcut has to stand down while somebody is typing, or the
 * "n" in a task name makes another task instead of landing in the field. The
 * same holds while a dialog or a menu is open: both already answer Escape and
 * every letter, and a screen-level handler firing underneath them is how a key
 * ends up doing two things at once.
 *
 * One function because every screen that binds a shortcut needs exactly this
 * check, and the one that reimplements it is the one that forgets a case.
 */

/** What swallows a key press: real fields, and anything made editable. */
const EDITING = "input, textarea, select, [contenteditable='true']";

/** True when the press belongs to a field, a dialog or an open menu. */
export function keyboardIsBusy(event: KeyboardEvent): boolean {
    const target = event.target as HTMLElement | null;
    if (target?.closest(EDITING)) return true;
    return document.querySelector("[role='dialog'], [role='menu']") !== null;
}
