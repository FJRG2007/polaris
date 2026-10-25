/**
 * Choosing several chats in Polar's list the way a file explorer does. Pure,
 * so every press and key can be asserted without a browser.
 *
 * A plain press opens the chat and lets the selection go. Ctrl (Cmd) with a
 * press toggles one chat; Shift takes the stretch from the anchor (the last chat
 * pressed) to this one, replacing what was chosen; Ctrl+Shift adds the stretch
 * instead. Ctrl+A takes every chat on screen, Escape lets them all go. The
 * arrows (and Home, End) move the focus, and with Shift they stretch the
 * selection from the anchor to wherever the focus lands; Ctrl+Space toggles the
 * focused chat, and Delete asks to delete the selection (or the focused chat).
 *
 * `order` is the chats as the list draws them, top to bottom: a folded section
 * or a closed project is not in it, so a stretch never takes a chat nobody saw.
 *
 * A selection holds at most `POLAR_BULK_MAX` chats, what one action on it can
 * take: past that, a stretch keeps the end nearest its anchor and anything else
 * keeps what was chosen first.
 */

import { allChosen, pressedSelection } from "@polaris/ui";
import { POLAR_BULK_MAX } from "@/lib/polar/shared";

export interface ThreadSelection {
    readonly chosen: readonly string[];
    /** Where a Shift press or Shift+arrow stretches from. */
    readonly anchor: string | null;
}

export const NO_SELECTION: ThreadSelection = { chosen: [], anchor: null };

export interface SelectKeys {
    readonly ctrlKey?: boolean;
    readonly metaKey?: boolean;
    readonly shiftKey?: boolean;
}

/** The chosen ids cut to what one action can take. */
function capped(chosen: readonly string[]): string[] {
    return chosen.slice(0, POLAR_BULK_MAX);
}

/** The stretch of `order` between two ids, both included, at most
 *  `POLAR_BULK_MAX` of them counted from `from`. */
function stretch(order: readonly string[], from: string, to: string): string[] {
    const a = order.indexOf(from);
    const b = order.indexOf(to);
    if (a < 0 || b < 0) return [to];
    const taken = order.slice(Math.min(a, b), Math.max(a, b) + 1);
    return a <= b ? taken.slice(0, POLAR_BULK_MAX) : taken.slice(-POLAR_BULK_MAX);
}

/**
 * What a press on `id` does: "open" for a plain one (the selection is let go),
 * or the new selection for a press with Ctrl, Cmd or Shift - or any press on
 * the row's checkbox (`toggle`), which chooses instead of opening.
 */
export function pressThread(
    order: readonly string[],
    current: ThreadSelection,
    id: string,
    keys: SelectKeys,
    toggle = false
): ThreadSelection | "open" {
    const ctrl = Boolean(keys.ctrlKey || keys.metaKey);
    const shift = Boolean(keys.shiftKey);
    const anchor =
        current.anchor !== null && order.includes(current.anchor) ? current.anchor : null;
    if (shift && anchor !== null) {
        if (ctrl || toggle) {
            return {
                chosen: capped(
                    pressedSelection(order, current.chosen, id, anchor, { shiftKey: true })
                ),
                anchor
            };
        }
        return { chosen: stretch(order, anchor, id), anchor };
    }
    if (ctrl || shift || toggle) {
        return { chosen: capped(pressedSelection(order, current.chosen, id, null)), anchor: id };
    }
    return "open";
}

/** Every chat on screen, the ones already chosen first. */
export function selectAllThreads(
    order: readonly string[],
    current: ThreadSelection
): ThreadSelection {
    return {
        chosen: capped(allChosen(order, current.chosen)),
        anchor: current.anchor ?? order[0] ?? null
    };
}

/** What a key heard by the list does; null when the list leaves it alone. */
export type ListKeyResult =
    | { kind: "select"; selection: ThreadSelection; focus?: string }
    | { kind: "focus"; focus: string }
    | { kind: "delete" }
    | null;

export function threadListKey(
    order: readonly string[],
    current: ThreadSelection,
    focused: string | null,
    key: string,
    keys: SelectKeys
): ListKeyResult {
    const ctrl = Boolean(keys.ctrlKey || keys.metaKey);
    if (ctrl && key.toLowerCase() === "a") {
        return order.length > 0
            ? { kind: "select", selection: selectAllThreads(order, current) }
            : null;
    }
    if (ctrl && key === " " && focused !== null && order.includes(focused)) {
        const toggled = pressThread(order, current, focused, { ctrlKey: true });
        return toggled === "open" ? null : { kind: "select", selection: toggled };
    }
    if (key === "Escape") {
        return current.chosen.length > 0 ? { kind: "select", selection: NO_SELECTION } : null;
    }
    if (key === "Delete") {
        return current.chosen.length > 0 || (focused !== null && order.includes(focused))
            ? { kind: "delete" }
            : null;
    }
    if (key !== "ArrowDown" && key !== "ArrowUp" && key !== "Home" && key !== "End") return null;
    if (order.length === 0) return null;
    const at = focused === null ? -1 : order.indexOf(focused);
    const next =
        key === "Home"
            ? 0
            : key === "End"
              ? order.length - 1
              : at < 0
                ? 0
                : Math.min(order.length - 1, Math.max(0, at + (key === "ArrowDown" ? 1 : -1)));
    const focus = order[next]!;
    if (!keys.shiftKey) return { kind: "focus", focus };
    const anchor =
        current.anchor !== null && order.includes(current.anchor)
            ? current.anchor
            : focused !== null && order.includes(focused)
              ? focused
              : focus;
    return { kind: "select", selection: { chosen: stretch(order, anchor, focus), anchor }, focus };
}

/** The chats an action from `id`'s menu or a drag of `id` acts on: the whole
 *  selection when `id` is part of it, otherwise only `id`. */
export function actedOn(current: ThreadSelection, id: string): string[] {
    return current.chosen.includes(id) ? [...current.chosen] : [id];
}

/** Drops chosen ids no longer on screen (deleted, archived, folded away). */
export function keepVisible(order: readonly string[], current: ThreadSelection): ThreadSelection {
    const chosen = current.chosen.filter((id) => order.includes(id));
    const anchor =
        current.anchor !== null && order.includes(current.anchor) ? current.anchor : null;
    return chosen.length === current.chosen.length && anchor === current.anchor
        ? current
        : { chosen, anchor };
}
