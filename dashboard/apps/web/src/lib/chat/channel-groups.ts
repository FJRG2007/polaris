/**
 * The teams and roles a private channel is opened to as it is made.
 *
 * The same groups and the same rows a channel's Share dialog offers and writes:
 * the space's organization's teams and roles (or the creator's own
 * organizations, for a space no organization owns), each written as a member
 * grant on the channel.
 */

import * as core from "@polaris/core";
import { prisma } from "@polaris/db";
import { GrantError, writeGrants } from "@/lib/access/grants";
import { publishAccessChange } from "@/lib/access-live";
import { memberOrgIds } from "@/lib/orgs/org-service";
import { groupCandidates, type GrantCandidate } from "@/lib/access/sharing-service";
import { ChatAccessError, requireChannel, requireSpace, type ChatActor } from "./access";

/** Which organizations' teams and roles a channel in this space may be opened to. */
async function spaceOrgIds(actor: ChatActor, spaceId: string): Promise<string[]> {
    const space = await prisma.chatSpace.findUnique({ where: { id: spaceId }, select: { orgId: true } });
    return space?.orgId ? [space.orgId] : memberOrgIds(actor.id);
}

/** What the Create dialog offers, for whoever may make a channel in the space. */
export async function channelGroupCandidates(
    actor: ChatActor,
    spaceId: string
): Promise<GrantCandidate[]> {
    await requireSpace(actor, spaceId, "admin");
    const orgIds = await spaceOrgIds(actor, spaceId);
    if (orgIds.length === 0) return [];
    return (await groupCandidates(orgIds)).filter(
        (group) => group.type === "team" || group.type === "role"
    );
}

/** Open a channel just made to these teams and roles. Checked the way Share
 *  checks it: only whoever administers the channel, only groups of the
 *  organizations it belongs to. */
export async function grantChannelGroups(
    actor: ChatActor,
    channelId: string,
    groups: readonly core.ChatChannelGroupInput[]
): Promise<number> {
    if (groups.length === 0) return 0;
    const access = await requireChannel(actor, channelId);
    if (!access.mayAdminister || !access.spaceId) {
        throw new ChatAccessError({ key: "errors.spaceAdminOnly" });
    }
    const orgIds = await spaceOrgIds(actor, access.spaceId);
    const unique = [...new Map(groups.map((group) => [`${group.type}:${group.id}`, group])).values()];
    try {
        const written = await writeGrants(
            "chat.channel",
            channelId,
            unique.map((group) =>
                core.accessGrantSchema.parse({
                    principalType: group.type,
                    principalId: group.id,
                    capability: "member"
                })
            ),
            actor.id,
            orgIds
        );
        publishAccessChange({});
        return written;
    } catch (caught) {
        // A team or role gone since the dialog listed it, or one of another
        // organization: said on the screen, the channel stands either way.
        if (caught instanceof GrantError) {
            throw new ChatAccessError({ key: "errors.channelGroupsNotAdded" });
        }
        throw caught;
    }
}
