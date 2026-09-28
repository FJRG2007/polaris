/**
 * Telling the screens that might be drawing somebody that what they are doing
 * changed.
 *
 * Rides the chat's live channel, which is already open above every screen, the
 * way a changed face does: the frame carries the person's id and the rooms they
 * are in, and every stream keeps it only for a reader who shares one of those
 * rooms. What they are doing is never on the wire - a browser drawing that face
 * pulls it through the presence endpoint, which is where their privacy settings
 * are applied.
 *
 * Best effort on purpose. A frame that never arrives costs one presence refresh
 * interval, and nothing that writes an activity may fail because telling people
 * about it did.
 */

import { publishChatChange } from "@/lib/chat/live";
import { reachableChannelIds } from "@/lib/chat/access";

/** Announce that these accounts' activity changed. Never throws. */
export async function announceActivity(userIds: readonly string[]): Promise<void> {
    for (const userId of new Set(userIds)) {
        try {
            const channels = await reachableChannelIds({ id: userId });
            // Published even with no rooms: their own other screens still want it.
            publishChatChange({ kind: "activity", actorId: userId, channels: [...channels] });
        } catch (caught) {
            console.error("polaris: could not announce an activity change:", caught);
        }
    }
}
