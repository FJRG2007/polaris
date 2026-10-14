/** Where a conversation opens, and the link a bell notice about it carries.
 *  Pure, so the browser and the server match notices by the same string. */
export function conversationLink(threadId: string): string {
    return `/mail/t/${threadId}`;
}
