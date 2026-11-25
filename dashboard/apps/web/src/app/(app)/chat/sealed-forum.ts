/**
 * Forum posts in a sealed forum: a post's title rides inside the seal of its
 * first message, so the server's row holds none (`hasSealedTitle`) and each
 * reader's browser names the post from what that message opened to.
 */

import type { ChatForumPostView } from "@/lib/chat/forum";
import type { ChatMessageView } from "@/lib/chat/messages";
import * as sealedChat from "@/lib/chat/e2ee/sealed-chat";

/** A post whose title is inside the seal of its first message: the server keeps none. */
export function hasSealedTitle(post: ChatForumPostView): boolean {
    return post.title === "" && post.root.sealed === true;
}

/**
 * A sealed post as the list draws it: titled from its opened first message,
 * or left out when a search came back with it and neither its title nor its
 * words hold what was typed (the server cannot search a sealed title).
 */
export function openedPost(
    post: ChatForumPostView,
    root: ChatMessageView,
    query: string,
    opened: (id: string, editedAt?: string) => sealedChat.SealedContent | null | undefined = sealedChat.openedContent
): ChatForumPostView | null {
    if (!hasSealedTitle(post)) return root === post.root ? post : { ...post, root };
    const title = opened(post.root.id, post.root.sealedEditedAt)?.title ?? "";
    const wanted = query.trim().toLowerCase();
    if (wanted && !`${title}\n${root.body}`.toLowerCase().includes(wanted)) return null;
    return { ...post, title, root };
}
