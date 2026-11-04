/**
 * Name tags on the server: what an organization (or the instance) defines, which
 * one somebody wears, and what a viewer is shown.
 *
 * Nothing about a worn tag is ever copied. A choice row names an organization
 * and nothing else; whether it still draws - the person is still a member, the
 * organization still has its tag on, the instance still has one - is decided
 * every time a name is drawn. So leaving, being removed, or the switch going off
 * drops the tag with nothing to clean up.
 *
 * Who may see somebody's tag follows the same audience as their badges.
 */

import { prisma } from "@polaris/db";
import * as core from "@polaris/core";
import { orgAvatarUrl } from "@/lib/avatar-url";
import { getSetting, setSetting } from "@/lib/setting-store";
import { allowedBy, type PrivacyViewer } from "@/lib/privacy-service";
import { memberOrgIds, requireOrgPermission, type OrgActor } from "@/lib/orgs/org-service";

/** What this instance is called, whose short forms are reserved. */
export const INSTANCE_NAME = core.NAME_TAG_INSTANCE_NAME;

export const INSTANCE_TAG_KEY = "profiles.nameTag.instance";

export class NameTagError extends Error {
    constructor(readonly code: string) {
        super(code);
        this.name = "NameTagError";
    }
}

export interface NameTagSettings {
    enabled: boolean;
    text: string;
    emblem: string;
    color: core.NameTagColor;
}

const OFF: NameTagSettings = { enabled: false, text: "", emblem: "spark", color: "blue" };

const ORG_TAG_SELECT = {
    tagEnabled: true,
    tagText: true,
    tagEmblem: true,
    tagColor: true
} as const;

/** A stored definition read total: anything that no longer parses is off. */
function parsedStored(raw: unknown, allowAvatar: boolean): NameTagSettings {
    const parsed = core
        .nameTagDefinitionSchema({ instanceName: INSTANCE_NAME, staff: true, allowAvatar })
        .safeParse(raw);
    return parsed.success ? parsed.data : OFF;
}

function orgSettings(row: {
    tagEnabled: boolean;
    tagText: string | null;
    tagEmblem: string;
    tagColor: string;
}): NameTagSettings {
    return parsedStored(
        {
            enabled: row.tagEnabled,
            text: row.tagText ?? "",
            emblem: row.tagEmblem,
            color: row.tagColor
        },
        true
    );
}

export async function instanceTag(): Promise<NameTagSettings> {
    const raw = await getSetting(INSTANCE_TAG_KEY);
    if (raw === null) return OFF;
    try {
        return parsedStored(JSON.parse(raw), false);
    } catch {
        return OFF;
    }
}

export async function setInstanceTag(actor: OrgActor, input: unknown): Promise<void> {
    if (!actor.isAdmin) throw new NameTagError("forbidden");
    const parsed = core
        .nameTagDefinitionSchema({ instanceName: INSTANCE_NAME, staff: true, allowAvatar: false })
        .safeParse(input);
    if (!parsed.success) throw new NameTagError(parsed.error.issues[0]?.message ?? "invalid");
    await setSetting(INSTANCE_TAG_KEY, JSON.stringify(parsed.data));
}

export async function tagOfOrg(orgId: string): Promise<NameTagSettings> {
    const row = await prisma.organization.findUnique({
        where: { id: orgId },
        select: ORG_TAG_SELECT
    });
    return row ? orgSettings(row) : OFF;
}

/** An organization's tag, by somebody who runs it. Reserved words stay the
 *  instance administrators' own. */
export async function saveOrganizationTag(
    actor: OrgActor,
    orgId: string,
    input: unknown
): Promise<void> {
    await requireOrgPermission(actor, orgId, "settings.manage");
    const parsed = core
        .nameTagDefinitionSchema({
            instanceName: INSTANCE_NAME,
            staff: actor.isAdmin,
            allowAvatar: true
        })
        .safeParse(input);
    if (!parsed.success) throw new NameTagError(parsed.error.issues[0]?.message ?? "invalid");
    const tag = parsed.data;
    await prisma.organization.update({
        where: { id: orgId },
        data: {
            tagEnabled: tag.enabled,
            tagText: tag.text,
            tagEmblem: tag.emblem,
            tagColor: tag.color
        }
    });
}

export interface NameTagOption {
    /** Null for the instance's tag. */
    orgId: string | null;
    name: string;
    tag: core.NameTagView;
}

export interface MyNameTags {
    options: NameTagOption[];
    chosen: core.NameTagChoice;
}

/** The tags this person may wear right now, and the one they chose - "none"
 *  when what they chose no longer draws. */
export async function myNameTags(userId: string): Promise<MyNameTags> {
    const [orgIds, instance, choice] = await Promise.all([
        memberOrgIds(userId),
        instanceTag(),
        prisma.nameTagChoice.findUnique({ where: { userId }, select: { orgId: true } })
    ]);
    const orgs =
        orgIds.length === 0
            ? []
            : await prisma.organization.findMany({
                  where: { id: { in: orgIds }, tagEnabled: true },
                  select: { id: true, name: true, image: true, ...ORG_TAG_SELECT },
                  orderBy: { name: "asc" },
                  take: 200
              });
    const options: NameTagOption[] = [];
    if (instance.enabled)
        options.push({ orgId: null, name: INSTANCE_NAME, tag: viewOf(instance, null, null) });
    for (const org of orgs) {
        const settings = orgSettings(org);
        if (settings.enabled)
            options.push({
                orgId: org.id,
                name: org.name,
                tag: viewOf(settings, org.id, org.image)
            });
    }
    const chosen: core.NameTagChoice =
        choice === null
            ? { source: "none" }
            : choice.orgId === null
              ? options.some((option) => option.orgId === null)
                  ? { source: "instance" }
                  : { source: "none" }
              : options.some((option) => option.orgId === choice.orgId)
                ? { source: "org", orgId: choice.orgId }
                : { source: "none" };
    return { options, chosen };
}

/** Wear one tag, or none. Only a tag this person may wear right now. */
export async function setNameTagChoice(userId: string, input: unknown): Promise<void> {
    const parsed = core.nameTagChoiceSchema.safeParse(input);
    if (!parsed.success) throw new NameTagError("invalid");
    const choice = parsed.data;
    if (choice.source === "none") {
        await prisma.nameTagChoice.deleteMany({ where: { userId } });
        return;
    }
    const orgId = choice.source === "org" ? choice.orgId : null;
    const { options } = await myNameTags(userId);
    if (!options.some((option) => option.orgId === orgId)) throw new NameTagError("unavailable");
    await prisma.nameTagChoice.upsert({
        where: { userId },
        create: { userId, orgId },
        update: { orgId }
    });
}

function viewOf(
    settings: NameTagSettings,
    orgId: string | null,
    image: string | null
): core.NameTagView {
    const avatar = settings.emblem === core.NAME_TAG_AVATAR;
    return {
        text: settings.text,
        // An avatar that is not there falls back to the first drawn emblem.
        emblem:
            avatar && (orgId === null || image === null)
                ? core.NAME_TAG_EMBLEMS[0]
                : settings.emblem,
        color: settings.color,
        orgId,
        image: avatar && orgId !== null && image !== null ? orgAvatarUrl(orgId) : null
    };
}

/**
 * The tags one viewer may see, for every person on one screen - one read of the
 * choices (with each organization's switch and the membership of exactly these
 * people), one of the instance tag when anybody wears it, and one batched
 * privacy decision. The cost does not grow with the number of names but with
 * nothing: N people is the same three questions.
 */
export async function nameTagsFor(
    viewer: PrivacyViewer | null,
    userIds: readonly string[]
): Promise<Map<string, core.NameTagView>> {
    const ids = [...new Set(userIds)].slice(0, core.NAME_TAG_LOOKUP_MAX);
    const shown = new Map<string, core.NameTagView>();
    if (ids.length === 0) return shown;
    const rows = await prisma.nameTagChoice.findMany({
        where: { userId: { in: ids } },
        select: {
            userId: true,
            orgId: true,
            org: {
                select: {
                    id: true,
                    image: true,
                    ownerId: true,
                    ...ORG_TAG_SELECT,
                    members: {
                        where: { userId: { in: ids }, restricted: false },
                        select: { userId: true }
                    }
                }
            }
        }
    });
    const wearing = new Map<string, core.NameTagView>();
    const instanceNeeded = rows.some((row) => row.orgId === null);
    const instance = instanceNeeded ? await instanceTag() : OFF;
    for (const row of rows) {
        if (row.orgId === null) {
            if (instance.enabled) wearing.set(row.userId, viewOf(instance, null, null));
            continue;
        }
        const org = row.org;
        if (!org) continue;
        const member =
            org.ownerId === row.userId || org.members.some((m) => m.userId === row.userId);
        if (!member) continue;
        const settings = orgSettings(org);
        if (!settings.enabled) continue;
        wearing.set(row.userId, viewOf(settings, org.id, org.image));
    }
    if (wearing.size === 0) return shown;
    const asking: PrivacyViewer = viewer ?? { id: "", isAdmin: false };
    const allowed = await allowedBy(asking, "badges", [...wearing.keys()]);
    for (const [userId, tag] of wearing) {
        if (userId === asking.id || allowed.has(userId)) shown.set(userId, tag);
    }
    return shown;
}

export interface NameTagCard {
    tag: core.NameTagView;
    name: string;
    /** The organization's public page, when it is an organization. */
    href: string | null;
    image: string | null;
    /** Only for a viewer who is in the organization, or runs the instance. */
    memberCount: number | null;
}

/** What opens when somebody clicks a tag: decided again, never trusted from the
 *  screen that drew it. */
export async function nameTagCard(
    viewer: PrivacyViewer | null,
    subjectId: string
): Promise<NameTagCard | null> {
    const tag = (await nameTagsFor(viewer, [subjectId])).get(subjectId);
    if (!tag) return null;
    if (tag.orgId === null) {
        return { tag, name: INSTANCE_NAME, href: null, image: null, memberCount: null };
    }
    const org = await prisma.organization.findUnique({
        where: { id: tag.orgId },
        select: { id: true, name: true, slug: true, image: true, ownerId: true }
    });
    if (!org) return null;
    const viewerIn =
        viewer !== null &&
        viewer.id !== "" &&
        (viewer.isAdmin ||
            org.ownerId === viewer.id ||
            (await prisma.organizationMember.count({
                where: { orgId: org.id, userId: viewer.id, restricted: false }
            })) > 0);
    const memberCount = viewerIn
        ? (await prisma.organizationMember.count({ where: { orgId: org.id, restricted: false } })) +
          1
        : null;
    return {
        tag,
        name: org.name,
        href: `/o/${org.slug}`,
        image: org.image ? orgAvatarUrl(org.id) : null,
        memberCount
    };
}
