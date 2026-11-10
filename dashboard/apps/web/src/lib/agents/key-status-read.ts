/**
 * The standing of each of an owner's keys, read for a key screen: the
 * cool-down the router stored on the row, and the day and month spend from the
 * recorded answers (two grouped reads, whatever the number of keys).
 *
 * Server-only.
 */

import type { ModelKeyView } from "@/lib/agents/model-keys";
import type { KeyHealthView } from "@/lib/agents/key-limits";
import { keyStatus } from "@/lib/agents/key-status";
import { allowanceState, keySpend, type KeySpend } from "@/lib/polar/router/limits";

/** Each key's standing, by key id. A spend that cannot be read is counted as
 *  nothing spent: the cool-downs on the rows still show. */
export async function keyStatuses(keys: readonly ModelKeyView[]): Promise<Record<string, KeyHealthView>> {
    const spend = await keySpend(keys.map((key) => key.id)).catch(
        () => new Map<string, KeySpend>()
    );
    const now = Date.now();
    return Object.fromEntries(
        keys.map((key) => {
            const spent = spend.get(key.id);
            return [key.id, keyStatus(key, spent, allowanceState(key.limits, spent), now)];
        })
    );
}
