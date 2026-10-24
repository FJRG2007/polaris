/**
 * Who may hand a thing over, and what they may hand it to.
 *
 * `grants.ts` reads and writes the rows; it decides nothing about whether the
 * person asking is allowed to. That question belongs to the thing being shared
 * and to nobody else - running a conversation, running a space, running the
 * house - so it is answered by each app's own access module and only routed
 * here. One dispatcher rather than a rule per screen, because "who may share
 * this" is exactly the check that gets forgotten on the fourth screen.
 *
 * The candidates are the other half. A grant to a team or a role is only
 * meaningful inside the organization that has them, so what is offered is scoped
 * to the organization that owns the subject - and, for the house, which has no
 * organization at all, to the ones the person sharing actually belongs to. A
 * picker that offered every team on the instance would be a picker that leaks
 * the shape of every organization on it.
 */

import { prisma } from "@polaris/db";
import * as core from "@polaris/core";
import { sessionCan } from "@/lib/session";
import type { SessionUser } from "@/lib/session";
import { GrantError } from "@/lib/access/grants";
import { requireApplicationAccess } from "@/lib/deploy-project-access";
import { mayEditShelf as mayEditAutomationShelf } from "@/lib/automations/runner";
import { memberOrgIds, orgCan, resolveOrgAccess } from "@/lib/orgs/org-service";
import {
    requireNote as requireNoteOnShelf,
    requireSpace as requireNoteSpace
} from "@/lib/notes/access";
import { requireShareable as requireOfficeShareable } from "@/lib/office/documents";
import { requireSpace as requireChatSpace, requireChannel } from "@/lib/chat/access";
import { requireSpace as requireTaskSpace, requireFolder, requireTask } from "@/lib/tasks/access";
import { domainOwner, lendableServer } from "@/lib/machines/machine-access";
import { MailAccessError, ownedAccount as ownedMailbox } from "@/lib/mailbox/access";

/**
 * Refuse unless this account may hand this thing to somebody else.
 *
 * Sharing is always the strongest standing the thing has: an admin of a space, a
 * moderator of a channel, whoever may set the house up. Being able to open a
 * door is not being able to lend it, which is the whole point - a visitor with a
 * key must not be able to cut copies.
 */
export async function requireMayShare(
    user: SessionUser,
    subject: core.GrantSubject,
    subjectId: string
): Promise<void> {
    const actor = { id: user.id, isAdmin: user.isAdmin };
    switch (subject) {
        case "chat.space":
            await requireChatSpace({ id: user.id }, subjectId, "admin");
            return;
        case "chat.channel": {
            const access = await requireChannel({ id: user.id }, subjectId);
            if (!access.mayAdminister) throw new GrantError("You cannot share that conversation");
            return;
        }
        case "task.space":
            await requireTaskSpace(actor, subjectId, "admin");
            return;
        case "task.folder":
            await requireFolder(actor, subjectId, "admin");
            return;
        case "note.space":
            await requireNoteSpace(actor, subjectId, "admin");
            return;
        case "note.note":
            // Whoever runs the shelf it sits on: its owner on a personal one.
            await requireNoteOnShelf(actor, subjectId, "admin");
            return;
        case "office.document":
            // Editing is not enough to hand it on, exactly as opening a door is
            // not enough to lend it: sharing takes the standing of the people it
            // belongs to.
            await requireOfficeShareable(user, subjectId);
            return;
        case "place.device":
        case "place.camera":
        case "place.room":
        case "place.place":
        case "place.panel":
            // Deciding who gets a key to the house is the same standing as
            // deciding what Polaris is connected to. Being able to open a door
            // is deliberately not enough: a visitor must not be able to lend it
            // on.
            if (!(await sessionCan(user, "home.manage"))) {
                throw new GrantError("You cannot share that");
            }
            return;
        case "place.ups":
            // A UPS shuts machines down: lending it is the standing of whoever
            // runs those machines, the same permission its own screens ask.
            if (!(await sessionCan(user, "system.manage"))) {
                throw new GrantError("You cannot share that");
            }
            return;
        case "place.nas": {
            // A NAS is lent by whoever connected it, the same account its
            // console password belongs to.
            const nas = await prisma.storageConnection.findFirst({
                where: { id: subjectId, kind: "unifi-unas", ownerId: user.id },
                select: { id: true }
            });
            if (!nas) throw new GrantError("You cannot share that");
            return;
        }
        case "place.server": {
            // A registered server is lent by whoever registered it. The machine
            // Polaris runs on is never lent from here: whether anybody outside
            // may watch it is the operator's call, so it is refused rather than
            // owned.
            const host = await lendableServer(subjectId);
            if (!host || host.ownerId !== user.id) throw new GrantError("You cannot share that");
            return;
        }
        case "place.domain": {
            // A domain is lent by whoever owns the project it answers for.
            const domain = await domainOwner(subjectId);
            if (!domain || domain.ownerId !== user.id)
                throw new GrantError("You cannot share that");
            return;
        }
        case "watch.alarm": {
            // An alarm is shared by whoever made it, as every change to it is.
            const alarm = await prisma.alarm.findFirst({
                where: { id: subjectId, ownerId: user.id },
                select: { id: true }
            });
            if (!alarm) throw new GrantError("You cannot share that");
            return;
        }
        case "calendar.calendar": {
            // A calendar's owner hands it to a role; the people and teams it
            // is shared with are kept, and shared, by the Calendar itself.
            const calendar = await prisma.calendar.findFirst({
                where: { id: subjectId, ownerId: user.id, trashedAt: null },
                select: { id: true }
            });
            if (!calendar) throw new GrantError("You cannot share that");
            return;
        }
        case "calendar.booking": {
            // A booking page's owner chooses its co-hosts.
            const page = await prisma.calendarBookingPage.findFirst({
                where: { id: subjectId, ownerId: user.id },
                select: { id: true }
            });
            if (!page) throw new GrantError("You cannot share that");
            return;
        }
        case "crm.record": {
            // Whoever may change a record where it lives may show it to
            // somebody else: its owner on a personal shelf, a role that edits
            // that kind of record on an organization's.
            const [kind, id] = subjectId.split(":");
            const delegate =
                kind === "companies"
                    ? prisma.crmCompany
                    : kind === "people"
                      ? prisma.crmPerson
                      : kind === "opportunities"
                        ? prisma.crmOpportunity
                        : null;
            const row =
                delegate && id && /^[0-9a-f-]{36}$/i.test(id)
                    ? await (
                          delegate as unknown as {
                              findFirst(args: unknown): Promise<{
                                  orgId: string | null;
                                  userId: string | null;
                              } | null>;
                          }
                      ).findFirst({
                          where: { id, deletedAt: null },
                          select: { orgId: true, userId: true }
                      })
                    : null;
            if (!row) throw new GrantError("You cannot share that");
            if (row.orgId) {
                const access = await resolveOrgAccess(user, row.orgId);
                if (!orgCan(access, `crm.${kind}.edit` as core.OrgPermission)) {
                    throw new GrantError("You cannot share that");
                }
            } else if (row.userId !== user.id) {
                throw new GrantError("You cannot share that");
            }
            return;
        }
        case "automation.automation": {
            // Whoever may change automations on its shelf decides who else
            // may look at one.
            const row = /^[0-9a-f-]{36}$/i.test(subjectId)
                ? await prisma.automation.findUnique({
                      where: { id: subjectId },
                      select: { orgId: true, userId: true }
                  })
                : null;
            if (!row || !(await mayEditAutomationShelf(user, row))) {
                throw new GrantError("You cannot share that");
            }
            return;
        }
        case "dns.filter":
            // The network filter is the house's: whoever runs the house shares it.
            if (!user.isAdmin || subjectId !== core.DNS_FILTER_ID) {
                throw new GrantError("You cannot share that");
            }
            return;
        case "agents.session": {
            // Whoever reaches it as its owner - the repository's, or whoever
            // started a workspace - lets somebody else read it.
            const { getSession } = await import("@/lib/agents/session-service");
            if (!(await getSession(subjectId, user.id)))
                throw new GrantError("You cannot share that");
            return;
        }
        case "mail.mailbox":
            // Only the person who linked a mailbox lends it, as only they read
            // it. Whoever runs the organization it is part of cannot: they can
            // take it back, never open it.
            try {
                await ownedMailbox(user.id, subjectId);
            } catch (caught) {
                if (caught instanceof MailAccessError)
                    throw new GrantError("You cannot share that");
                throw caught;
            }
            return;
        case "polar.project": {
            // Only its owner shows a project to somebody else.
            const project = await prisma.polarProject.findUnique({
                where: { id: subjectId },
                select: { ownerId: true }
            });
            if (!project || project.ownerId !== user.id)
                throw new GrantError("You cannot share that");
            return;
        }
        case "task.task":
            // Whoever may make it a public link may show it to a person.
            await requireTask(actor, subjectId, "member");
            return;
        case "backup.plan": {
            // Only its owner shows a plan to somebody else.
            const plan = await prisma.backupPlan.findUnique({
                where: { id: subjectId },
                select: { ownerId: true }
            });
            if (!plan || plan.ownerId !== user.id) throw new GrantError("You cannot share that");
            return;
        }
        case "telemetry.project": {
            // Whoever may open the project as its owner (or an administrator)
            // decides who else reads its issues.
            const { requireProject } = await import("@/lib/telemetry/project-service");
            const owns = await requireProject(
                { id: user.id, isAdmin: user.isAdmin },
                subjectId
            ).then(
                () => true,
                () => false
            );
            if (!owns) throw new GrantError("You cannot share that");
            return;
        }
        case "analytics.site": {
            // Whoever may configure a service decides who else reads its numbers.
            const configurable = await requireApplicationAccess(
                subjectId,
                user.id,
                "service.configure"
            ).then(
                () => true,
                () => false
            );
            if (!configurable) throw new GrantError("You cannot share that");
            return;
        }
        case "crm.dashboard": {
            // Whoever may change dashboards where it lives may show one to
            // somebody else: its owner on a personal shelf, a role that edits
            // some kind of record on an organization's.
            const row = /^[0-9a-f-]{36}$/i.test(subjectId)
                ? await prisma.crmDashboard.findFirst({
                      where: { id: subjectId },
                      select: { orgId: true, userId: true }
                  })
                : null;
            if (!row) throw new GrantError("You cannot share that");
            if (row.orgId) {
                const access = await resolveOrgAccess(user, row.orgId);
                const edits = ["companies", "people", "opportunities"].some((kind) =>
                    orgCan(access, `crm.${kind}.edit` as core.OrgPermission)
                );
                if (!edits) throw new GrantError("You cannot share that");
            } else if (row.userId !== user.id) {
                throw new GrantError("You cannot share that");
            }
            return;
        }
        case "status.page": {
            // Whoever runs status pages decides who else keeps one up to date.
            if (!(await sessionCan(user, "status.manage"))) {
                throw new GrantError("You cannot share that");
            }
            const page = await prisma.statusPage.findUnique({
                where: { id: subjectId },
                select: { id: true }
            });
            if (!page) throw new GrantError("You cannot share that");
            return;
        }
        case "watch.connectivity":
            // The record the internet alert writes, which only administrators
            // receive and read; one of them decides who else may.
            if (subjectId !== core.WATCH_CONNECTIVITY_ID || !user.isAdmin) {
                throw new GrantError("You cannot share that");
            }
            return;
    }
}

/** Somebody a grant can be written to, as the picker draws them. */
export interface GrantCandidate {
    readonly type: core.GrantPrincipal;
    readonly id: string;
    readonly name: string;
    /** Which organization it came from, for a picker showing two of them. */
    readonly orgName: string;
    /** What the row says underneath - how many people it reaches, or an
     *  address. */
    readonly detail: string;
}

/**
 * The teams and roles this thing can be handed to.
 *
 * Scoped to the organization that owns the subject, so a conversation belonging
 * to one organization cannot be handed to another's people. The house belongs to
 * no organization, so there it is the organizations the sharer is on - which is
 * how "the security team" ends up on the list at all.
 *
 * People are deliberately not here: they are found by searching, through the
 * same privacy rules every other people search obeys, rather than being listed.
 */
export async function shareCandidates(
    user: SessionUser,
    subject: core.GrantSubject,
    subjectId: string
): Promise<GrantCandidate[]> {
    const orgIds = await owningOrgIds(user, subject, subjectId);
    if (orgIds.length === 0) return [];

    const [teams, roles] = await Promise.all([
        prisma.team.findMany({
            where: { orgId: { in: orgIds } },
            orderBy: [{ org: { name: "asc" } }, { name: "asc" }],
            select: {
                id: true,
                name: true,
                org: { select: { name: true } },
                _count: { select: { members: true } }
            }
        }),
        prisma.orgRole.findMany({
            where: { orgId: { in: orgIds } },
            orderBy: [{ org: { name: "asc" } }, { name: "asc" }],
            select: { id: true, name: true, description: true, org: { select: { name: true } } }
        })
    ]);

    return [
        ...teams.map((team) => ({
            type: "team" as const,
            id: team.id,
            name: team.name,
            orgName: team.org.name,
            detail: team._count.members === 1 ? "1 person" : `${team._count.members} people`
        })),
        ...roles.map((role) => ({
            type: "role" as const,
            id: role.id,
            name: role.name,
            orgName: role.org.name,
            detail: role.description || "Everybody holding this role"
        }))
    ];
}

/**
 * Which organizations' groups are on the table for this subject.
 *
 * Exported because the write needs the same answer the picker got: a form is
 * filled in by a screen, and a share is written by whoever calls the action.
 */
export async function owningOrgIds(
    user: SessionUser,
    subject: core.GrantSubject,
    subjectId: string
): Promise<string[]> {
    const owning = await ownerOrgOf(subject, subjectId);
    if (owning) return [owning];
    // No organization owns it - somebody's own space, or the house, which is one
    // per Polaris and belongs to nobody. Then the groups worth offering are the
    // ones the person sharing is actually on.
    return memberOrgIds(user.id);
}

/**
 * The organization that owns this thing, named - or null for something nobody's
 * organization owns. What an "organization" link opens for, which is never the
 * sharer's own organizations: those are a fallback for picking groups, not an
 * owner.
 */
export async function subjectOrg(
    subject: core.GrantSubject,
    subjectId: string
): Promise<{ id: string; name: string } | null> {
    const id = await ownerOrgOf(subject, subjectId);
    if (!id) return null;
    const org = await prisma.organization.findUnique({
        where: { id },
        select: { id: true, name: true }
    });
    return org ?? null;
}

async function ownerOrgOf(subject: core.GrantSubject, subjectId: string): Promise<string | null> {
    switch (subject) {
        case "office.document":
            return orgOf(
                await prisma.officeDocument.findUnique({
                    where: { id: subjectId },
                    select: { orgId: true }
                })
            );
        case "chat.space":
            return orgOf(
                await prisma.chatSpace.findUnique({
                    where: { id: subjectId },
                    select: { orgId: true }
                })
            );
        case "chat.channel": {
            const channel = await prisma.chatChannel.findUnique({
                where: { id: subjectId },
                select: { space: { select: { orgId: true } } }
            });
            return channel?.space?.orgId ?? null;
        }
        case "task.space":
            return orgOf(
                await prisma.taskSpace.findUnique({
                    where: { id: subjectId },
                    select: { orgId: true }
                })
            );
        case "task.folder": {
            const folder = await prisma.taskFolder.findUnique({
                where: { id: subjectId },
                select: { space: { select: { orgId: true } } }
            });
            return folder?.space?.orgId ?? null;
        }
        case "note.space":
            return orgOf(
                await prisma.noteSpace.findUnique({
                    where: { id: subjectId },
                    select: { orgId: true }
                })
            );
        default:
            return null;
    }
}

/**
 * Whether the place a door or a UPS stands in has a location to measure
 * "only near the place" from - asked by the share dialog so it can say so
 * before a fence is drawn that would refuse every press. Null where the
 * question does not apply.
 */
export async function subjectPlaceLocated(
    subject: core.GrantSubject,
    subjectId: string
): Promise<boolean | null> {
    const placeId =
        subject === "place.ups"
            ? (await prisma.ups.findUnique({ where: { id: subjectId }, select: { placeId: true } }))
                  ?.placeId
            : subject === "place.device"
              ? (
                    await prisma.placeDevice.findUnique({
                        where: { id: subjectId },
                        select: { placeId: true }
                    })
                )?.placeId
              : subject === "place.room"
                ? (
                      await prisma.placeRoom.findUnique({
                          where: { id: subjectId },
                          select: { placeId: true }
                      })
                  )?.placeId
                : subject === "place.panel"
                  ? (
                        await prisma.placePanel.findUnique({
                            where: { id: subjectId },
                            select: { placeId: true }
                        })
                    )?.placeId
                  : undefined;
    if (placeId === undefined) return null;
    if (!placeId) return false;
    const place = await prisma.place.findUnique({
        where: { id: placeId },
        select: { latitude: true, longitude: true }
    });
    return Boolean(place && place.latitude !== null && place.longitude !== null);
}

function orgOf(row: { orgId: string | null } | null): string | null {
    return row?.orgId ?? null;
}

/**
 * Whether a grant on this subject is worth bounding by hours and uses.
 *
 * A door lent to a visitor is; a conversation handed to the support team is not.
 * The columns exist either way - one table - but a form that asked how many
 * times somebody may read a channel would be asking a question with no meaning,
 * and a form nobody can answer is a form nobody fills in.
 */
export function shareIsBounded(subject: core.GrantSubject): boolean {
    return (
        subject === "place.device" ||
        subject === "place.camera" ||
        subject === "place.ups" ||
        subject === "place.nas" ||
        subject === "place.server" ||
        subject === "place.domain" ||
        subject === "place.room" ||
        subject === "place.place" ||
        subject === "place.panel" ||
        subject === "watch.connectivity"
    );
}

/** What each capability is called and what it means, for the picker. Kept beside
 *  the vocabulary rather than in each screen, so the three places that draw this
 *  say the same words. */
export const CAPABILITY_LABELS: Record<string, { label: string; hint: string }> = {
    // i18n-ignore said in the reader's words by the share dialog (share.capabilities)
    guest: { label: "Guest", hint: "Read it, and comment where they are involved." },
    // i18n-ignore said in the reader's words by the share dialog (share.capabilities)
    member: { label: "Member", hint: "Take part: post, create and edit." },
    // i18n-ignore said in the reader's words by the share dialog (share.capabilities)
    admin: { label: "Admin", hint: "Everything a member can do, plus running it." },
    // i18n-ignore said in the reader's words by the share dialog (share.capabilities)
    view: { label: "Can see", hint: "Watch it and see its state. Nothing else." },
    // i18n-ignore said in the reader's words by the share dialog (share.capabilities)
    control: { label: "Can operate", hint: "Open, close and switch it, as well as see it." },
    // i18n-ignore said in the reader's words by the share dialog (share.capabilities)
    edit: { label: "Can change", hint: "Change it and keep it up to date. Not delete it." }
};

/**
 * Where the person something was shared with finds it, for the bell. Only the
 * subjects whose screen does not need more than the id; null leaves the notice
 * without a link rather than guessing one.
 */
export function subjectHref(subject: core.GrantSubject, subjectId: string): string | null {
    switch (subject) {
        case "watch.connectivity":
            return "/watch/connectivity";
        case "watch.alarm":
            return "/watch/alarms";
        case "status.page":
            return `/status-pages/${subjectId}`;
        case "calendar.calendar":
            return "/calendar";
        case "calendar.booking":
            return `/calendar/booking/${subjectId}`;
        case "crm.record": {
            const [kind, id] = subjectId.split(":");
            return `/crm/${kind}/${encodeURIComponent(id ?? "")}`;
        }
        case "crm.dashboard":
            return "/crm/dashboards";
        case "note.note":
            return `/notes?note=${encodeURIComponent(subjectId)}`;
        case "backup.plan":
            return "/apps/backups";
        case "task.task":
            return `/tasks/t/${subjectId}`;
        case "polar.project":
            return "/polar";
        case "mail.mailbox":
            return `/mail/shared/${subjectId}`;
        case "agents.session":
            return `/apps/agents/sessions/${subjectId}`;
        case "dns.filter":
            return "/apps/network-filter";
        case "telemetry.project":
            return `/apps/telemetry?project=${encodeURIComponent(subjectId)}`;
        case "analytics.site":
            return `/apps/analytics?scope=application&id=${encodeURIComponent(subjectId)}`;
        case "automation.automation":
            return `/automations/${subjectId}`;
        case "office.document":
            return "/office/shared";
        case "place.ups":
            return `/places/ups/${encodeURIComponent(subjectId)}`;
        default:
            return subject.startsWith("place.") ? "/places" : null;
    }
}
