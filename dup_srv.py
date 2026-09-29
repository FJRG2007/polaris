def edit(p, pairs):
    s = open(p, encoding="utf-8").read()
    for a, b in pairs:
        assert s.count(a) == 1, (p, a[:60])
        s = s.replace(a, b)
    open(p, "w", encoding="utf-8", newline="\n").write(s)

edit("src/lib/chat/messages.ts", [(
'''export async function markRead(actor: ChatActor, input: core.ChatMarkReadInput): Promise<void> {''',
'''/**
 * Catch up on whole conversations from the list, up to the newest message each
 * holds in the channel itself - a thread reply is unread inside its thread and
 * is left there, the same line the badge draws.
 *
 * One the reader cannot open is skipped rather than refused: a heading can hold
 * a private channel they are not in, and "mark all read" is not a question
 * about it.
 */
export async function markChannelsRead(
    actor: ChatActor,
    input: core.ChatMarkChannelsReadInput
): Promise<void> {
    for (const channelId of new Set(input.channelIds)) {
        if (!(await channelAccess(actor, channelId))) continue;
        const newest = await prisma.chatMessage.findFirst({
            where: { channelId, parentId: null },
            orderBy: { createdAt: "desc" },
            select: { id: true }
        });
        if (newest) await markRead(actor, { channelId, messageId: newest.id });
    }
}

export async function markRead(actor: ChatActor, input: core.ChatMarkReadInput): Promise<void> {''')])
s = open("src/lib/chat/messages.ts", encoding="utf-8").read()
i = s.index("} from \"./access\";")
block = s[s.rindex("import {", 0, i):i]
print(block)
