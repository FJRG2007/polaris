/**
 * Emoji reactions on an email, in the format Gmail reads and writes.
 *
 * A reaction is an ordinary reply carrying one extra body part of type
 * `text/vnd.google.email-reaction+json` - `{"version":1,"emoji":"👍"}` - with a
 * plain-text and an HTML part either side of it, so a client that knows nothing
 * of reactions still shows the emoji as a short reply. Its In-Reply-To names
 * the one message it reacts to. See
 * https://developers.google.com/workspace/gmail/reactions/format
 */

import { emojiOnlyCount } from "./chat-emoji.js";

/** The body part that makes a reply a reaction. */
export const MAIL_REACTION_TYPE = "text/vnd.google.email-reaction+json";

/** Gmail offers no reaction on a message with more recipients than this, and
 *  treats one sent to more as an ordinary reply. */
export const MAIL_REACTION_MOST_RECIPIENTS = 20;

/** Whether a string is exactly one emoji - a family or a flag being one - which
 *  is all a reaction may carry. A space's own `:name:` emoji is not: no other
 *  mail client could draw it. */
export function isMailReaction(text: string): boolean {
    const trimmed = text.trim();
    if (!trimmed || /\s|:/.test(trimmed)) return false;
    return emojiOnlyCount(trimmed) === 1;
}

/** The reaction a message's text carries, or "" when it carries none. */
export function mailReactionFrom(text: string): string {
    const trimmed = text.trim();
    return isMailReaction(trimmed) ? trimmed : "";
}

/** The reaction part's body. */
export function mailReactionJson(emoji: string): string {
    return JSON.stringify({ version: 1, emoji });
}
