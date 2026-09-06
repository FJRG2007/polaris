import type { ChatMessageView } from "@/lib/chat/messages";

/**
 * A message on screen before the server has seen it.
 *
 * Typing something and watching it sit there while a round trip happens is the
 * difference between a chat and a form, so the line is drawn immediately and
 * replaced by the real one a moment later.
 *
 * It is a function rather than an object built where it is sent, and that is not
 * tidiness. A draft has to answer every question the renderer asks of a real
 * message - who wrote it, whether it is starred, whether its links have been
 * looked at - and the way this goes wrong is not a crash. It is a field left
 * null that means something specific to whoever draws it. `authorName` was null,
 * a null author name is drawn as "Somebody who has left", and so every message
 * anybody sent was briefly attributed to a departed stranger on the sender's own
 * screen. Nothing failed; it just said the wrong thing for half a second, in the
 * one place people look.
 */
export function draftMessage(facts: {
    readonly id: string;
    readonly channelId: string;
    readonly authorId: string;
    /** The sender's own name. Never null: this message has an author, they are
     *  reading this screen, and every fallback for a missing one is a sentence
     *  about somebody who is not here. */
    readonly authorName: string;
    readonly body: string;
}): ChatMessageView {
    return {
        id: facts.id,
        channelId: facts.channelId,
        authorId: facts.authorId,
        authorName: facts.authorName,
        kind: "text",
        body: facts.body,
        parentId: null,
        replyCount: 0,
        lastReplyAt: null,
        edited: false,
        deleted: false,
        reactions: [],
        attachments: [],
        // A draft is always a line of text. A poll is written in a dialog and
        // posted from there, so there is nothing on screen for an optimistic one
        // to replace.
        poll: null,
        quote: null,
        starred: false,
        // Nobody blocks themselves, and the menu that would offer it does not
        // appear on your own row.
        blocked: false,
        // Resolved by the server on the reload a moment from now. A draft that
        // guessed would draw a card and then replace it with a different one.
        references: [],
        // Your own words, which your own setting never stands between you and.
        forwardable: true,
        // The server has not looked at any link in it yet. Left as settled
        // rather than pending on purpose: this draft is replaced by the real
        // message a moment later, and that one asks.
        link: null,
        preview: null,
        previewPending: false,
        // Nothing has happened to it yet, not even leaving. The first tick
        // arrives with the message the reload brings back.
        receipt: null,
        createdAt: new Date().toISOString()
    };
}
