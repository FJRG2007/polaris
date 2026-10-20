/**
 * Things from the apps dragged onto Polar: a mail, a Drive file, a picture
 * from a chat.
 *
 * One drag type for all of them, set by each app's own drag source beside
 * whatever it already carries, and read by Polar's composer. What it carries
 * names the thing and nothing more: the server looks it up again with the
 * reader's own access (`item-attachments.ts`), so a payload anybody can forge
 * in a page names, at most, something its sender could already read.
 *
 * Client-safe.
 */

import { z } from "zod";
import { POLAR_ATTACHMENT_MOST } from "@/lib/polar/shared";

export const POLARIS_ITEM_TYPE = "application/x-polaris-item+json";

const rowId = z.string().uuid();
const title = z.string().trim().min(1).max(255).optional();

export const droppedItemSchema = z.discriminatedUnion("kind", [
    z.object({ kind: z.literal("mail-message"), id: rowId, title }),
    z.object({
        kind: z.literal("drive-file"),
        connectionId: z.string().trim().min(1).max(200),
        path: z.string().trim().min(1).max(4096),
        title
    }),
    z.object({ kind: z.literal("chat-attachment"), id: rowId, title })
]);
export type DroppedItem = z.infer<typeof droppedItemSchema>;

export const droppedItemsSchema = z.array(droppedItemSchema).min(1).max(POLAR_ATTACHMENT_MOST);

/** What a drag says it carries, for the drop highlight before the drop. */
export function carriesItems(types: Iterable<string>): boolean {
    return Array.from(types).includes(POLARIS_ITEM_TYPE);
}

/** Puts the items on a drag beside what the source already set. Copying is
 *  allowed alongside the source's own effect, or a drop on Polar is refused. */
export function writeDraggedItems(
    transfer: Pick<DataTransfer, "setData" | "effectAllowed">,
    items: readonly DroppedItem[]
): void {
    const carried = items.slice(0, POLAR_ATTACHMENT_MOST);
    if (carried.length === 0) return;
    transfer.setData(POLARIS_ITEM_TYPE, JSON.stringify(carried));
    if (transfer.effectAllowed === "move") transfer.effectAllowed = "copyMove";
    else if (transfer.effectAllowed === "link") transfer.effectAllowed = "copyLink";
}

/** The items on a drop, or null when there are none or they are not ours. */
export function readDraggedItems(transfer: Pick<DataTransfer, "getData">): DroppedItem[] | null {
    let raw: unknown;
    try {
        raw = JSON.parse(transfer.getData(POLARIS_ITEM_TYPE));
    } catch {
        return null;
    }
    const parsed = droppedItemsSchema.safeParse(raw);
    return parsed.success ? parsed.data : null;
}

/** The name to show for an item until the server answers with the real one. */
export function itemLabel(item: DroppedItem): string {
    if (item.title) return item.title;
    if (item.kind === "drive-file") return item.path.split("/").pop() || item.path;
    return item.id;
}
