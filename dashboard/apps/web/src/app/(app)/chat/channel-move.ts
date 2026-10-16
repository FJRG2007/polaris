/**
 * Moving a channel from its menu rather than by dragging it.
 *
 * The same write as a drop: the whole list under one heading, in the order it
 * should end up in, built by the same `reordered` the drag uses. So a channel
 * moved from the menu lands exactly where dropping it there would have put it,
 * and there is one way the stored order is decided, not two.
 */

import { reordered } from "./use-rail-drag";

/** Where the menu was asked to put a channel. */
export type ChannelMove =
    | { readonly to: "first" | "last" }
    | { readonly to: "category"; readonly categoryId: string | null };

/** One heading's channels, in order - what the reorder action takes. */
export interface ChannelOrder {
    readonly categoryId: string | null;
    readonly channelIds: readonly string[];
}

/** What this needs of a channel: which heading it is under. */
export interface Placed {
    readonly id: string;
    readonly categoryId: string | null;
}

/** Where a channel stands in its heading, which is what makes First and Last
 *  something that would do nothing. */
export function channelPlace(
    channels: readonly Placed[],
    id: string
): { readonly first: boolean; readonly last: boolean } {
    const channel = channels.find((entry) => entry.id === id);
    if (!channel) return { first: false, last: false };
    const siblings = channels.filter((entry) => entry.categoryId === channel.categoryId);
    return { first: siblings[0]?.id === id, last: siblings.at(-1)?.id === id };
}

/**
 * The order to send for a move, or null when the move would change nothing.
 *
 * @param channels - The space's channels on screen, in the order they are drawn.
 */
export function channelMoveOrder(
    channels: readonly Placed[],
    id: string,
    move: ChannelMove
): ChannelOrder | null {
    const channel = channels.find((entry) => entry.id === id);
    if (!channel) return null;
    const categoryId = move.to === "category" ? move.categoryId : channel.categoryId;
    if (move.to === "category" && categoryId === channel.categoryId) return null;

    const place = channelPlace(channels, id);
    if ((move.to === "first" && place.first) || (move.to === "last" && place.last)) return null;

    const ids = channels
        .filter((entry) => entry.categoryId === categoryId)
        .map((entry) => entry.id);
    const first = ids.find((entry) => entry !== id);
    const channelIds =
        move.to === "first" && first
            ? reordered(ids, id, { at: "row", id: first, after: false })
            : reordered(ids, id, { at: "end", categoryId });
    return { categoryId, channelIds };
}

/**
 * The channels as they will be once `order` is stored, for drawing before it is.
 *
 * Only the order within a heading means anything to the rail, which draws each
 * heading by filtering this list, so the moved heading's channels go to the end
 * in their new order and everything else keeps its place.
 */
export function withChannelOrder<T extends Placed>(
    channels: readonly T[],
    order: ChannelOrder
): T[] {
    const moved = new Set(order.channelIds);
    const byId = new Map(channels.map((entry) => [entry.id, entry]));
    const placed = order.channelIds.flatMap((id) => {
        const channel = byId.get(id);
        return channel ? [{ ...channel, categoryId: order.categoryId }] : [];
    });
    return [...channels.filter((entry) => !moved.has(entry.id)), ...placed];
}

/** Whether `channels` already draw `order`'s heading in `order`'s order. */
export function reflectsChannelOrder(channels: readonly Placed[], order: ChannelOrder): boolean {
    const ids = channels
        .filter((entry) => entry.categoryId === order.categoryId)
        .map((entry) => entry.id);
    return (
        ids.length === order.channelIds.length &&
        ids.every((id, index) => id === order.channelIds[index])
    );
}
