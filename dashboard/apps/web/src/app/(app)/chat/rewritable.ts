import { gameInviteIn } from "@/lib/chat/game-server-card";
import type { ChatMessageView } from "@/lib/chat/messages";

/**
 * Whether the pencil is offered on a row (its author is checked apart).
 *
 * A poll's body is the question people answered, and a game invite is a card,
 * not text, so neither is rewritten. A sealed row is refused by the service
 * (`errors.sealedNotEditable`): an edit of it would have to be sealed too, which
 * is designed but not built (docs/chat-e2ee-mls.md), so the pencil is not
 * offered rather than answered with that refusal.
 */
export function rewritable(message: Pick<ChatMessageView, "kind" | "body" | "sealed">): boolean {
    return message.kind !== "poll" && !message.sealed && !gameInviteIn(message.body);
}
