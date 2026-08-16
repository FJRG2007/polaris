/**
 * Who may reach which conversation.
 *
 * One rule decides everything downstream: **a conversation is reached by being
 * in it.** There is no administrator override and no instance-wide read. An
 * operator who runs the machine can read the database, and that is a different
 * and visible act; what they cannot do is open somebody's direct messages from a
 * screen Polaris drew for them. Chat is the one app here where the interesting
 * failure is not "somebody could not get in" but "somebody got in", so the
 * asymmetry is deliberate and stated rather than left for a reader to notice.
 *
 * The one softening is a space set to `internal`, which is the "everybody here"
 * room: whoever can see the owner is a member without being added. On an
 * organization's space that means the roster; on somebody's own space it means
 * anybody signed in holding `chat.use`.
 *
 * The instance permission (`chat.use`) says whether the app exists for this
 * account at all and is checked by the action layer. Everything below assumes it
 * passed and answers the narrower question.
 */

import { can } from "@polaris/auth";
import { prisma } from "@polaris/db";
import { memberOrgIds } from "@/lib/orgs/org-service";
import { findPeople, type FoundPeople } from "@/lib/people-search";

/** The caller, as the action layer resolved them. */
export interface ChatActor {
    readonly id: string;
}

/** What somebody may do in a space. `owner` outranks both stored roles. */
export type ChatSpaceAccess = "member" | "admin" | "owner";

export class ChatAccessError extends Error {
    constructor(message = "You are not in that conversation") {
        super(message);
        this.name = "ChatAccessError";
    }
}

/**
 * Refused by the instance's rules rather than by who the caller is: a message
 * longer than this kind of conversation allows, an edit past its window, a
 * file bigger than the ceiling.
 *
 * A subclass because every caller does the same thing with both - shows the
 * sentence - and one catch that missed this would turn a limit into a 500. The
 * name is what tells the two apart in a log.
 */
export class ChatRuleError extends ChatAccessError {
    constructor(message: string) {
        super(message);
        this.name = "ChatRuleError";
    }
}

/**
 * What this actor may do in this space, or null when it is not theirs to reach.
 *
 * An archived space still resolves: reading what was said in one is exactly what
 * archiving is for. Writing to it is refused by the write path, not here.
 */
export async function spaceAccess(
    actor: ChatActor,
    spaceId: string
): Promise<ChatSpaceAccess | null> {
    const space = await prisma.chatSpace.findUnique({
        where: { id: spaceId },
        select: { ownerId: true, orgId: true, visibility: true }
    });
    if (!space) return null;
    if (space.ownerId === actor.id) return "owner";

    const membership = await prisma.chatSpaceMember.findUnique({
        where: { spaceId_userId: { spaceId, userId: actor.id } },
        select: { role: true }
    });
    if (membership) return membership.role === "admin" ? "admin" : "member";

    if (space.visibility !== "internal") return null;
    if (!space.orgId) return "member";
    const orgs = await memberOrgIds(actor.id);
    return orgs.includes(space.orgId) ? "member" : null;
}

/** The same, refused loudly. */
export async function requireSpace(
    actor: ChatActor,
    spaceId: string,
    minimum: ChatSpaceAccess = "member"
): Promise<ChatSpaceAccess> {
    const access = await spaceAccess(actor, spaceId);
    if (!access) throw new ChatAccessError("You are not in that space");
    if (minimum === "admin" && access === "member") {
        throw new ChatAccessError("Only an admin of this space can do that");
    }
    return access;
}

/** What a reader may do in one channel. */
export interface ChannelAccess {
    readonly channelId: string;
    readonly spaceId: string | null;
    readonly kind: string;
    readonly archived: boolean;
    /** Whether they are a row in the channel rather than reaching it through the
     *  space. Only a member has a read mark, so this decides whether catching up
     *  writes anything. */
    readonly member: boolean;
    /** Whether they may post. False in an archived channel and in an archived
     *  space, which is what archiving means. */
    readonly mayPost: boolean;
    /** Whether they may rename it, set the topic, or add people. */
    readonly mayAdminister: boolean;
}

/**
 * Resolve one channel for one reader, or null when they cannot reach it.
 *
 * A direct message and a private channel are reached one way only: a membership
 * row. A public channel in a space is reached by reaching the space, which is
 * what makes an `internal` space usable without adding everybody to every
 * channel in it.
 */
export async function channelAccess(
    actor: ChatActor,
    channelId: string
): Promise<ChannelAccess | null> {
    const channel = await prisma.chatChannel.findUnique({
        where: { id: channelId },
        select: {
            id: true,
            spaceId: true,
            kind: true,
            private: true,
            archived: true,
            space: { select: { archived: true } }
        }
    });
    if (!channel) return null;

    const membership = await prisma.chatChannelMember.findUnique({
        where: { channelId_userId: { channelId, userId: actor.id } },
        select: { role: true }
    });

    const spaceArchived = channel.space?.archived ?? false;
    const live = !channel.archived && !spaceArchived;

    if (!channel.spaceId) {
        // A direct message. There is no space to fall back on, so the row is
        // the whole answer, and everybody in one is equal in it.
        if (!membership) return null;
        return {
            channelId: channel.id,
            spaceId: null,
            kind: channel.kind,
            archived: channel.archived,
            member: true,
            mayPost: live,
            mayAdminister: false
        };
    }

    const space = await spaceAccess(actor, channel.spaceId);
    if (!space) return null;
    if (channel.private && !membership) return null;

    const admin = space === "owner" || space === "admin" || membership?.role === "admin";
    return {
        channelId: channel.id,
        spaceId: channel.spaceId,
        kind: channel.kind,
        archived: channel.archived,
        member: Boolean(membership),
        mayPost: live,
        mayAdminister: admin
    };
}

/** The same, refused loudly. */
export async function requireChannel(actor: ChatActor, channelId: string): Promise<ChannelAccess> {
    const access = await channelAccess(actor, channelId);
    if (!access) throw new ChatAccessError();
    return access;
}

/** The same again, for a write. Says which of the two reasons refused it, since
 *  "you are not in it" and "it is archived" call for different next steps. */
export async function requirePostable(actor: ChatActor, channelId: string): Promise<ChannelAccess> {
    const access = await requireChannel(actor, channelId);
    if (!access.mayPost) throw new ChatAccessError("That conversation is archived");
    return access;
}

/**
 * Every channel this actor can currently reach.
 *
 * Used by the rail to list conversations and by the live stream to decide which
 * frames are theirs to be told about. One query per source rather than a join
 * across four tables: the sets are small (a person is in tens of channels, not
 * thousands) and each source is a different question, which a single clever
 * query would make unreadable without making it faster.
 */
export async function reachableChannelIds(actor: ChatActor): Promise<Set<string>> {
    const [direct, spaces] = await Promise.all([
        prisma.chatChannelMember.findMany({
            where: { userId: actor.id },
            select: { channelId: true }
        }),
        reachableSpaceIds(actor)
    ]);

    const open = spaces.size
        ? await prisma.chatChannel.findMany({
              where: { spaceId: { in: [...spaces] }, private: false },
              select: { id: true }
          })
        : [];

    return new Set([...direct.map((row) => row.channelId), ...open.map((row) => row.id)]);
}

/**
 * Which of these accounts can be talked to at all.
 *
 * Somebody whose `chat.use` has been taken away does not have the app: no rail,
 * no conversations, nothing that would show them a message. Putting them in one
 * anyway would be a room where somebody is spoken to and never hears it, and the
 * person doing the speaking would have no way to know. So they are not offered
 * in a picker and they are refused at the write.
 *
 * One resolution per account rather than a single query, because whether
 * somebody holds a capability is a policy evaluation and not a column - roles,
 * policies, groups and the override on the account all get a say. The sets here
 * are a popup's worth or a group's worth, so the cost is bounded by the shape of
 * the thing asking.
 */
/**
 * Who this account may start a conversation with.
 *
 * The instance-wide person search, narrowed to accounts that can actually
 * receive a message: an account without `chat.use` has no screen one could
 * arrive on, and that is the same capability the write enforces, so what is
 * offered and what is allowed are one set.
 *
 * Everything else about who may be found - that nothing is listed, and that
 * somebody who has hidden themselves is not there at all - is `findPeople`,
 * because it is a privacy rule and must not have a second copy here.
 */
export async function searchForConversation(
    actor: ChatActor,
    query: string,
    limit = 8
): Promise<FoundPeople> {
    return findPeople(actor, query, { reachableOnly: true, reachable: messageable, limit });
}

/**
 * Who can be named with an @ in one conversation.
 *
 * The people in the room, and only them. Which is both what everybody expects -
 * Discord and WhatsApp offer the room, not a directory - and the privacy answer:
 * being in a conversation together is the fact that makes somebody nameable,
 * rather than sharing a space in another app entirely.
 *
 * That was the bug. The @ picker had one reach for the whole dashboard, worked
 * out from shared work - Tasks spaces and organization rosters - so two people
 * whose only connection was the conversation they were sitting in could not name
 * each other in it. Nothing was refused; the list simply came back empty.
 *
 * Null when this account cannot reach the conversation at all, which the caller
 * answers by falling back rather than by refusing: a caret typing @ is not a
 * request worth failing.
 */
export async function conversationAudience(
    actor: ChatActor,
    channelId: string
): Promise<string[] | null> {
    const access = await channelAccess(actor, channelId);
    if (!access) return null;

    // A channel in a space is read by the space's people, whether or not they
    // have a row on the channel: a public channel has member rows only for the
    // people who joined it, and everybody in the space can see what is said.
    // A private one is its own list, which is what makes it private.
    const open = access.spaceId ? !(await isPrivate(channelId)) : false;
    const [space, inSpace, inChannel] = await Promise.all([
        // The owner, who has no membership row of their own - the space is
        // theirs - and would otherwise be the one person nobody could name.
        open && access.spaceId
            ? prisma.chatSpace.findUnique({
                  where: { id: access.spaceId },
                  select: { ownerId: true }
              })
            : null,
        open && access.spaceId
            ? prisma.chatSpaceMember.findMany({
                  where: { spaceId: access.spaceId },
                  select: { userId: true }
              })
            : [],
        prisma.chatChannelMember.findMany({ where: { channelId }, select: { userId: true } })
    ]);

    const ids = [...inSpace, ...inChannel].map((row) => row.userId);
    if (space?.ownerId) ids.push(space.ownerId);
    return [...new Set(ids)];
}

async function isPrivate(channelId: string): Promise<boolean> {
    const channel = await prisma.chatChannel.findUnique({
        where: { id: channelId },
        select: { private: true }
    });
    return channel?.private ?? false;
}

export async function messageable(userIds: readonly string[]): Promise<Set<string>> {
    const unique = [...new Set(userIds)];
    if (unique.length === 0) return new Set();
    const verdicts = await Promise.all(
        unique.map(async (userId) => [userId, await can(userId, "chat.use")] as const)
    );
    return new Set(verdicts.filter(([, allowed]) => allowed).map(([userId]) => userId));
}

/** Every space this actor can reach, by the three ways in. */
export async function reachableSpaceIds(actor: ChatActor): Promise<Set<string>> {
    const orgs = await memberOrgIds(actor.id);
    const spaces = await prisma.chatSpace.findMany({
        where: {
            OR: [
                { ownerId: actor.id },
                { members: { some: { userId: actor.id } } },
                { visibility: "internal", orgId: null },
                ...(orgs.length ? [{ visibility: "internal", orgId: { in: orgs } }] : [])
            ]
        },
        select: { id: true }
    });
    return new Set(spaces.map((space) => space.id));
}
