/**
 * Where a call rings, as the card that says who is calling puts it: which
 * group, or nothing for a one-to-one, which is only ever the caller.
 *
 * Pure, so the wording can be asserted without a browser.
 */

import type { CallGroup } from "./live";

export function whereLine(group: CallGroup | undefined): string | null {
    if (!group) return null;
    if (group.name) return `in ${group.name}`;
    return group.size > 0 ? `in a group of ${group.size}` : "in a group";
}
