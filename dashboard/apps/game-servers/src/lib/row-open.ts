/**
 * A row that stands for a record opens it when it is clicked anywhere that is
 * not one of its own controls.
 *
 * A list of servers made you aim for the name: the rest of the row - the
 * status, the players, the empty space - highlighted on hover and did nothing
 * when pressed, which reads as broken. The name stays a real link, so the
 * keyboard, a screen reader and "open in a new tab" keep working exactly as a
 * link does; this only makes the rest of the row agree with it.
 *
 * Pure, so which clicks count can be asserted without a browser.
 */

/** What inside a row is a control of its own, and never a way to open the row. */
const OWN_CONTROLS =
    "a, button, input, select, textarea, label, [role='button'], [role='menuitem'], [data-row-ignore]";

/** What a click on a row should do: open it here, open it in a new tab, or
 *  nothing because it belonged to something else. */
export function rowClickIntent(input: {
    readonly target: { closest(selector: string): unknown } | null;
    readonly button: number;
    readonly metaKey: boolean;
    readonly ctrlKey: boolean;
    readonly shiftKey: boolean;
    /** Text somebody has just selected in the row, which a click to finish the
     *  selection must not turn into a navigation. */
    readonly selection: string;
}): "open" | "new-tab" | "none" {
    if (input.target?.closest(OWN_CONTROLS)) return "none";
    if (input.selection.trim().length > 0) return "none";
    if (input.button === 1 || input.metaKey || input.ctrlKey) return "new-tab";
    if (input.button !== 0 || input.shiftKey) return "none";
    return "open";
}
