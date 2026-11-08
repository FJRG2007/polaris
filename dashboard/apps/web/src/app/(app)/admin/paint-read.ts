/**
 * The browser half of `paint-reads`: one Management region's data, asked for
 * through its route so it does not queue behind the tab's other actions.
 */

import { readPoll } from "@/lib/poll-fetch";
import type { PaintAnswer, PaintQuery, PaintReadName } from "./paint-reads";

export function paintRead<K extends PaintReadName>(
    name: K,
    query: PaintQuery<K> = {} as PaintQuery<K>
): Promise<PaintAnswer<K>> {
    const search: Record<string, string> = {};
    for (const [key, value] of Object.entries(query as Record<string, unknown>)) {
        if (typeof value === "string") search[key] = value;
    }
    return readPoll<PaintAnswer<K>>(`/api/admin/paint/${encodeURIComponent(name)}`, search);
}
