/**
 * Which conversations the sidebar draws for the shelf it is on.
 *
 * The usual list leaves out what the reader hid, and - when they asked for it -
 * what they locked. "Locked chats" and "Hidden chats" are each the one kind.
 */

export type LockShelf = "all" | "locked" | "hidden";

export function onShelf(
    channel: { readonly locked: boolean; readonly hidden: boolean },
    shelf: LockShelf,
    hideLocked: boolean
): boolean {
    if (shelf === "locked") return channel.locked;
    if (shelf === "hidden") return channel.hidden;
    return !channel.hidden && !(channel.locked && hideLocked);
}
