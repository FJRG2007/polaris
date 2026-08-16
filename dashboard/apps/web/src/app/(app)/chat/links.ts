/**
 * The addresses a conversation and a message have.
 *
 * Every conversation is a URL already - a channel, a group and a direct message
 * are all one kind of thing with one id - and a message is that URL with the
 * message on the end. So a link somebody pastes into an email points at the
 * line, not at the room with an instruction to scroll.
 *
 * Built on the address Polaris hands out rather than on the tab's own hostname:
 * that may be the LAN name the installer wrote, which resolves on this network
 * and nowhere else. Same reason, and the same helper, as a task link.
 */

/** The conversation itself: a channel, a group chat or a direct message. */
export function channelLink(baseUrl: string, channelId: string): string {
    return `${baseUrl}/chat/c/${channelId}`;
}

/** One message inside it. */
export function messageLink(baseUrl: string, channelId: string, messageId: string): string {
    return `${channelLink(baseUrl, channelId)}/${messageId}`;
}

/**
 * The root of the thread a message belongs to, or null when it is not a reply.
 *
 * Where a link lands when the conversation itself does not hold the message. A
 * reply is deliberately left out of the channel - it belongs under its root, and
 * the root's reply count is what points at it - so a screen that walked the
 * channel backwards looking for one would walk the whole of it and still report
 * that the message was out of reach. Anything without a parent is a message the
 * channel does hold, and not finding it there was the true answer.
 */
export function threadRootFor<T extends { readonly id: string; readonly parentId: string | null }>(
    thread: readonly T[],
    messageId: string
): T | null {
    const target = thread.find((entry) => entry.id === messageId);
    if (!target?.parentId) return null;
    return thread.find((entry) => entry.id === target.parentId) ?? null;
}

/**
 * Put something on the clipboard, or do nothing.
 *
 * There is no clipboard on an insecure origin and none in a document that is not
 * focused, and neither is a state worth interrupting somebody about - they will
 * see that nothing was copied and press it again.
 */
export async function copyText(value: string): Promise<void> {
    if (!navigator.clipboard) return;
    try {
        await navigator.clipboard.writeText(value);
    } catch {
        // Refused. Nothing useful to say about it.
    }
}

/**
 * Save a file out of a conversation.
 *
 * A link with a name on it and nothing else: the route serves the bytes under
 * the name they were uploaded with, and `download` is what makes the browser
 * keep them rather than navigate to them. The query says the same thing to the
 * server, which sets the disposition to match - a recording is served to be
 * played, and this is the one request that wants it as a file.
 *
 * Here rather than beside either of the two menus that offer it, because both do
 * and a second copy would be the one that forgets the query.
 */
export function downloadFile(url: string, name: string): void {
    const anchor = document.createElement("a");
    anchor.href = `${url}${url.includes("?") ? "&" : "?"}download=1`;
    anchor.download = name;
    anchor.click();
}
