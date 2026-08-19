/**
 * What the chips inside a message should say.
 *
 * Its own module because two screens draw the same message: the conversation
 * and the search panel. Without this they would disagree - one would name the
 * room a link points at and the other would show the address it was pasted as -
 * which reads as the search results being out of date.
 *
 * The resolution itself is the server's (`lib/chat/references`). This only turns
 * it into the shape the renderer wants.
 */

import type { ChatMessageView } from "@/lib/chat/messages";
import type { ChatReferenceView } from "@/lib/chat/references";
import type { ResolvedReference } from "@/components/rich-text/rich-text";

/**
 * The message's references keyed the way a chip is addressed.
 *
 * Undefined rather than an empty map when there are none, so the renderer skips
 * the walk entirely - which is nearly every message.
 */
export function referenced(
    message: ChatMessageView
): ReadonlyMap<string, ResolvedReference> | undefined {
    if (message.references.length === 0) return undefined;
    return new Map(
        message.references.map((found) => [
            `${found.kind}/${found.id}`,
            {
                reachable: found.reachable,
                label: labelOf(found),
                // Anything drawn in full underneath comes out of the sentence.
                // The address said nothing the card does not say better, and
                // leaving it in is the same thing twice - once as a link nobody
                // wants to follow.
                hidden: hasCard(found)
            }
        ])
    );
}

/**
 * Whether this reference is drawn as a card under the message.
 *
 * Here rather than in the list that draws them, because two things have to agree
 * about it: what gets a card, and what comes out of the text. Splitting them is
 * how you end up with an address in the sentence and nothing underneath, or a
 * card with the address still sitting above it.
 */
export function hasCard(found: ChatReferenceView): boolean {
    if (!found.reachable) return false;
    return found.kind === "message" || (found.kind === "channel" && found.channelKind === "voice");
}

/**
 * What the chip in the sentence says.
 *
 * A conversation and a task say what they are called. A message has no name of
 * its own, and "Message" on its own next to a card quoting it says nothing
 * twice - so it says where it was said, which is the thing the sentence around
 * it is usually missing.
 */
function labelOf(found: ChatReferenceView): string {
    if (found.kind !== "message") return found.name;
    return found.name ? `Message in ${found.name}` : "Message";
}
