import { gameInviteIn } from "@/lib/chat/game-server-card";
import type { ChatMessageView } from "@/lib/chat/messages";
import { sealedChatActive } from "@/lib/chat/e2ee/sealed-chat";

/**
 * Whether the pencil is offered on a row (its author is checked apart).
 *
 * A poll's body is the question people answered, and a game invite is a card,
 * not text, so neither is rewritten. A sealed row is edited sealed, from this
 * browser's device (`editSealedMessage`, docs/chat-e2ee-mls.md), so the pencil
 * is offered on one only while sealed chat is on here; the plain edit refuses
 * it (`errors.sealedNotEditable`).
 */
export function rewritable(message: Pick<ChatMessageView, "kind" | "body" | "sealed">): boolean {
    return message.kind !== "poll" && (!message.sealed || sealedChatActive()) && !gameInviteIn(message.body);
}
