/**
 * Whether an organization keeps its own chat, and which one somebody is in.
 *
 * An account has one chat: the people they talk to, wherever they know them
 * from. An organization can ask for a second one - its own people, about its own
 * work, kept off the conversations they have with everybody else - and the shelf
 * switch in the header is what somebody moves between them with. Nothing else
 * about Chat changes: the same rooms, the same rules, the same calls.
 *
 * Two switches, and both have to be on:
 *
 * - **The instance offers it.** An administrator can withdraw the choice for
 *   everybody. The reason is storage rather than policy: a second chat is a
 *   second set of conversations to keep, and a house that would rather have one
 *   says so once instead of asking every organization not to.
 * - **The organization takes it.** Off for every organization that exists, so
 *   nothing splits in two without somebody choosing it.
 *
 * **Turning either off never hides anything.** What was said in an
 * organization's chat is folded back into the shared one rather than being
 * filed somewhere nobody can reach - a switch that makes conversations vanish
 * is a switch nobody can safely change their mind about. That is what
 * `readableScopes` is for, and it is why it is a set rather than a value.
 */

import { prisma } from "@polaris/db";
import { scopeOrgIdFor } from "@/lib/workspace-scope";
import { getSetting, setSetting } from "@/lib/setting-store";

/** Whether an instance lets its organizations keep their own chat. Stored only
 *  when an administrator has said no: the absence of a row is the default, and
 *  the default is that they may. */
const OFFERED_KEY = "chat.orgIsolation";

export async function orgChatOffered(): Promise<boolean> {
    return (await getSetting(OFFERED_KEY)) !== "off";
}

export async function setOrgChatOffered(offered: boolean): Promise<void> {
    await setSetting(OFFERED_KEY, offered ? null : "off");
}

/** Whether this organization's chat is its own right now. False for a null
 *  organization, for one that has not asked, and for every organization at once
 *  when the instance has withdrawn the choice. */
export async function orgChatIsolated(orgId: string | null): Promise<boolean> {
    if (!orgId) return false;
    if (!(await orgChatOffered())) return false;
    const org = await prisma.organization.findUnique({
        where: { id: orgId },
        select: { chatIsolated: true }
    });
    return org?.chatIsolated === true;
}

/**
 * The chat this request is in: an organization's own, or the shared one.
 *
 * Read from the shelf rather than from anything the browser sends, for the
 * reason every scope here is: a conversation is filed by this, and a client that
 * could name the file it lands in is a client that can put a message somewhere
 * its author did not mean.
 */
export async function currentChatOrgId(userId: string): Promise<string | null> {
    const orgId = await scopeOrgIdFor(userId);
    return (await orgChatIsolated(orgId)) ? orgId : null;
}

/**
 * Which chats this reader's rail may show at once.
 *
 * On an organization's own chat, that one and nothing else - which is the whole
 * point of it. Anywhere else, the shared chat plus every organization that is
 * not keeping its own: those are conversations that were filed under an
 * organization while it was, and they belong back in the list rather than
 * nowhere.
 */
export async function readableChatScopes(userId: string): Promise<Set<string | null>> {
    const mine = await currentChatOrgId(userId);
    if (mine) return new Set([mine]);

    const scopes = new Set<string | null>([null]);
    if (!(await orgChatOffered())) {
        // Withdrawn for everybody: every organization's conversations are part
        // of the shared chat again, whatever their own switch still says.
        const orgs = await memberOrgs(userId, undefined);
        for (const org of orgs) scopes.add(org.id);
        return scopes;
    }
    for (const org of await memberOrgs(userId, false)) scopes.add(org.id);
    return scopes;
}

/** The organizations this account belongs to, optionally only the ones whose
 *  chat is (or is not) their own. */
async function memberOrgs(
    userId: string,
    isolated: boolean | undefined
): Promise<{ id: string }[]> {
    return prisma.organization.findMany({
        where: {
            ...(isolated === undefined ? {} : { chatIsolated: isolated }),
            OR: [{ ownerId: userId }, { members: { some: { userId } } }]
        },
        select: { id: true }
    });
}

/** Everybody on this organization's roster, its owner included, by id. Who a
 *  conversation in its own chat may be with. */
export async function orgChatPeople(orgId: string): Promise<Set<string>> {
    const org = await prisma.organization.findUnique({
        where: { id: orgId },
        select: { ownerId: true, members: { select: { userId: true } } }
    });
    if (!org) return new Set();
    return new Set([org.ownerId, ...org.members.map((row) => row.userId)]);
}
