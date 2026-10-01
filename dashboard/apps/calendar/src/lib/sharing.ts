/**
 * Sharing a calendar with people and teams, and publishing it by link.
 *
 * Four levels, Google's: see only when it is busy, see every detail, change
 * events, and change events and who it is shared with. The owner and managers
 * share; a manager cannot hand out "manage" beyond themselves or remove the
 * owner's own reach, which is not a share.
 *
 * Publishing gives the calendar an unguessable address, readable by anybody
 * who has it: `busy` shows only that times are taken, `full` every detail of
 * its public events (private ones stay busy blocks, as they do for a read-only
 * sharee). Turning it off deletes the token, so turning it on again is a new
 * address - the old one must not come back to life.
 *
 * Server-only.
 */

import { prisma } from "@polaris/db";
import type { ShareView } from "./wire";
import { host } from "@polaris/app-host";
import { randomBytes } from "node:crypto";
import { CalendarRefusal } from "./errors";
import { calendarT, calendarTFor } from "./i18n";
import { forgetReminders } from "./reminders";
import { reachOf, reaches, requireCalendar, type ShareLevel, type SessionUser } from "./access";

/** Shares one calendar may carry. */
const MAX_SHARES = 200;

export async function listShares(user: SessionUser, calendarId: string): Promise<ShareView[]> {
    await requireCalendar(user.id, calendarId, "manage");
    const rows = await prisma.calendarShare.findMany({
        where: { calendarId },
        select: {
            id: true,
            access: true,
            user: { select: { id: true, name: true } },
            team: { select: { id: true, name: true } }
        },
        orderBy: { createdAt: "asc" }
    });
    return rows.flatMap((row): ShareView[] => {
        const access = row.access as ShareView["access"];
        if (row.user) return [{ id: row.id, target: { kind: "user", id: row.user.id, name: row.user.name }, access }];
        if (row.team) return [{ id: row.id, target: { kind: "team", id: row.team.id, name: row.team.name }, access }];
        return [];
    });
}

/** Share with a person or a team, or change the level they have. */
export async function share(
    user: SessionUser,
    input: { calendarId: string; target: { kind: "user" | "team"; id: string }; access: ShareLevel }
): Promise<void> {
    const calendar = await requireCalendar(user.id, input.calendarId, "manage");
    const t = await calendarT();
    if (calendar.kind === "resource") throw new CalendarRefusal(t("sharing.notResources"));
    if (input.target.kind === "user" && input.target.id === calendar.ownerId) {
        throw new CalendarRefusal(t("sharing.alreadyOwner"));
    }
    if (input.access === "manage" && calendar.reach !== "owner") throw new CalendarRefusal(t("sharing.onlyOwnerManage"));
    if (input.target.kind === "team") {
        const teams = await host.calendarHost.teamsOf(user.id);
        if (!teams.some((team) => team.id === input.target.id)) throw new CalendarRefusal(t("sharing.notYourTeam"));
    } else {
        const [person] = await host.calendarHost.peopleByIds([input.target.id]);
        if (!person) throw new CalendarRefusal(t("sharing.noSuchPerson"));
    }
    const count = await prisma.calendarShare.count({ where: { calendarId: calendar.id } });
    if (count >= MAX_SHARES) throw new CalendarRefusal(t("sharing.tooMany"));

    const where =
        input.target.kind === "user"
            ? { calendarId_userId: { calendarId: calendar.id, userId: input.target.id } }
            : { calendarId_teamId: { calendarId: calendar.id, teamId: input.target.id } };
    const existing = await prisma.calendarShare.findUnique({ where, select: { id: true, access: true } });
    if (existing?.access === input.access) return;
    if (existing?.access === "manage" && calendar.reach !== "owner") throw new CalendarRefusal(t("sharing.onlyOwnerManage"));
    await prisma.calendarShare.upsert({
        where,
        create: {
            calendarId: calendar.id,
            access: input.access,
            createdById: user.id,
            ...(input.target.kind === "user" ? { userId: input.target.id } : { teamId: input.target.id })
        },
        update: { access: input.access }
    });
    if (!existing) await announceShare(user, calendar.id, input.target);
    else if (input.access === "freebusy") {
        await forgetLostReaders(calendar, input.target.kind === "user" ? { userId: input.target.id } : { teamId: input.target.id });
    }
}

/** Stop reminding the people a share reached who no longer read the calendar. */
async function forgetLostReaders(
    calendar: { id: string; ownerId: string; kind: string },
    target: { userId?: string | null; teamId?: string | null }
): Promise<void> {
    const people = target.userId ? [target.userId] : target.teamId ? await host.calendarHost.teamMemberIds(target.teamId) : [];
    const lost: string[] = [];
    for (const person of people) {
        const level = (await reachOf(person, [{ ...calendar, trashedAt: null }])).get(calendar.id) ?? null;
        if (!reaches(level, "read")) lost.push(person);
    }
    await forgetReminders(calendar.id, lost);
}

/** Tell the people a calendar was just shared with. */
async function announceShare(user: SessionUser, calendarId: string, target: { kind: "user" | "team"; id: string }): Promise<void> {
    const calendar = await prisma.calendar.findUnique({ where: { id: calendarId }, select: { name: true } });
    const people = target.kind === "user" ? [target.id] : await host.calendarHost.teamMemberIds(target.id);
    for (const userId of people.filter((id) => id !== user.id).slice(0, 200)) {
        const t = await calendarTFor(userId);
        await host.notificationsDispatch
            .notify({
                userId,
                event: "calendar.shared",
                title: t("sharing.sharedTitle", { who: user.name, calendar: calendar?.name ?? "" }),
                href: `/calendar?c=${calendarId}`
            })
            .catch(() => undefined);
    }
}

/** Stop sharing with one person or team. */
export async function unshare(user: SessionUser, shareId: string): Promise<void> {
    const row = await prisma.calendarShare.findUnique({
        where: { id: shareId },
        select: { id: true, calendarId: true, access: true, userId: true, teamId: true }
    });
    if (!row) throw new CalendarRefusal((await calendarT())("sharing.notFound"));
    const calendar = await requireCalendar(user.id, row.calendarId, "manage");
    if (row.access === "manage" && calendar.reach !== "owner") {
        throw new CalendarRefusal((await calendarT())("sharing.onlyOwnerManage"));
    }
    await prisma.calendarShare.delete({ where: { id: row.id } });
    await forgetLostReaders(calendar, row);
}

/** Who and which teams this person could share with, for the picker. */
export async function shareTargets(user: SessionUser, query: string) {
    const [people, teams] = await Promise.all([
        host.calendarHost.searchPeople({ id: user.id, isAdmin: user.isAdmin }, query),
        host.calendarHost.teamsOf(user.id)
    ]);
    const term = query.trim().toLowerCase();
    return {
        people: people.filter((person) => person.id !== user.id).map((person) => ({ id: person.id, name: person.name, username: person.username })),
        teams: teams.filter((team) => !term || team.name.toLowerCase().includes(term) || team.orgName.toLowerCase().includes(term))
    };
}

/** Publish, change how much the link shows, or stop publishing. */
export async function publish(user: SessionUser, calendarId: string, mode: "" | "busy" | "full"): Promise<string | null> {
    const calendar = await requireCalendar(user.id, calendarId, "manage");
    const row = await prisma.calendar.findUniqueOrThrow({
        where: { id: calendar.id },
        select: { publicToken: true, publicMode: true }
    });
    if (mode === "") {
        await prisma.calendar.update({ where: { id: calendar.id }, data: { publicToken: null, publicMode: "" } });
        return null;
    }
    const token = row.publicToken ?? randomBytes(24).toString("base64url");
    if (row.publicMode !== mode || !row.publicToken) {
        await prisma.calendar.update({ where: { id: calendar.id }, data: { publicToken: token, publicMode: mode } });
    }
    return token;
}

/** A new address for a published calendar; the old one stops working. */
export async function rotatePublicLink(user: SessionUser, calendarId: string): Promise<string> {
    const calendar = await requireCalendar(user.id, calendarId, "manage");
    const row = await prisma.calendar.findUniqueOrThrow({ where: { id: calendar.id }, select: { publicMode: true } });
    if (!row.publicMode) throw new CalendarRefusal((await calendarT())("sharing.notPublished"));
    const token = randomBytes(24).toString("base64url");
    await prisma.calendar.update({ where: { id: calendar.id }, data: { publicToken: token } });
    return token;
}

/** Mail somebody the public link of a published calendar (Nextcloud's "send
 *  link"). Rate limited: this sends mail to an address somebody typed. */
export async function mailPublicLink(user: SessionUser, calendarId: string, email: string): Promise<void> {
    const calendar = await requireCalendar(user.id, calendarId, "manage");
    const row = await prisma.calendar.findUniqueOrThrow({
        where: { id: calendar.id },
        select: { name: true, publicToken: true, publicMode: true }
    });
    const t = await calendarT();
    if (!row.publicToken || !row.publicMode) throw new CalendarRefusal(t("sharing.notPublished"));
    const limited = await host.rateLimitService.rateLimit(`calendar.mail-link:${user.id}`, 20, 60 * 60 * 1000);
    if (!limited.ok) throw new CalendarRefusal(t("sharing.slowDown"));
    const base = await host.domainService.appBaseUrl();
    const result = await host.calendarHost.sendCalendarEmail({
        to: email,
        subject: t("sharing.mailSubject", { who: user.name, calendar: row.name }),
        text: `${t("sharing.mailBody", { who: user.name, calendar: row.name })}\n\n${base}/cal/p/${row.publicToken}\n`
    });
    if (result.error) throw new CalendarRefusal(result.error);
}

/** A published calendar by its token, or null. */
export async function publishedCalendar(token: string) {
    if (!/^[A-Za-z0-9_-]{20,64}$/.test(token)) return null;
    const row = await prisma.calendar.findUnique({
        where: { publicToken: token },
        select: { id: true, name: true, color: true, description: true, publicMode: true, timezone: true, trashedAt: true }
    });
    if (!row || row.trashedAt || !row.publicMode) return null;
    return row;
}
