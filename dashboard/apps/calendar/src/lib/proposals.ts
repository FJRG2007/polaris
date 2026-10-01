/**
 * Meeting proposals (Nextcloud's "propose a meeting"): candidate times the
 * people invited vote on, each through a link of their own, before the owner
 * picks one. Picking a date writes the event through `writeItem` with
 * everybody as its attendees - so the ordinary invitation path tells them - and
 * closes the proposal.
 *
 * A participant is reached the way an invitation reaches them: a Polaris
 * account gets a notice in the bell, anybody else an email. Either way the
 * vote itself is the public link, so nobody needs an account to answer.
 *
 * Server-only.
 */

import * as engine from "../engine";
import { prisma } from "@polaris/db";
import { writeItem } from "./objects";
import { host } from "@polaris/app-host";
import { CalendarRefusal } from "./errors";
import { requireWritableCalendar, type SessionUser } from "./access";
import { calendarT, calendarTFor, calendarTIn, localeOf } from "./i18n";
import { VOTES, type ProposalInput, type Vote } from "./scheduling-schemas";
import type { ProposalSummary, ProposalView, VotePageView } from "./scheduling-wire";
import { callerAddress, mayMailOutside, newLinkToken, throttle } from "./scheduling-guard";

/** Open proposals one person may keep. */
const MAX_OPEN = 50;

const INCLUDE = {
    dates: { orderBy: { start: "asc" } },
    participants: { orderBy: { email: "asc" } }
} as const;

type ProposalRow = Awaited<ReturnType<typeof loadRow>>;

async function loadRow(id: string) {
    return prisma.calendarProposal.findUniqueOrThrow({ where: { id }, include: INCLUDE });
}

function readVotes(raw: string): Record<string, Vote> {
    try {
        const parsed = JSON.parse(raw) as unknown;
        if (!parsed || typeof parsed !== "object") return {};
        return Object.fromEntries(
            Object.entries(parsed).filter((entry): entry is [string, Vote] =>
                (VOTES as readonly unknown[]).includes(entry[1])
            )
        );
    } catch {
        return {};
    }
}

function view(row: ProposalRow): ProposalView {
    return {
        id: row.id,
        title: row.title,
        description: row.description,
        location: row.location,
        durationMinutes: row.durationMinutes,
        timezone: row.timezone,
        notify: row.notify,
        status: row.status === "closed" ? "closed" : "open",
        calendarId: row.calendarId,
        objectId: row.objectId,
        dates: row.dates.map((date) => ({ id: date.id, start: date.start.toISOString() })),
        participants: row.participants.map((participant) => ({
            id: participant.id,
            name: participant.name,
            email: participant.email,
            required: participant.required,
            internal: participant.userId !== null,
            respondedAt: participant.respondedAt?.toISOString() ?? null,
            votes: readVotes(participant.votes)
        }))
    };
}

async function ownProposal(user: SessionUser, id: string): Promise<ProposalRow> {
    const found = await prisma.calendarProposal.findFirst({
        where: { id, ownerId: user.id },
        select: { id: true }
    });
    if (!found) throw new CalendarRefusal((await calendarT())("proposals.notFound"));
    return loadRow(found.id);
}

export async function listProposals(user: SessionUser): Promise<ProposalSummary[]> {
    const rows = await prisma.calendarProposal.findMany({
        where: { ownerId: user.id },
        include: {
            participants: { select: { respondedAt: true } },
            _count: { select: { dates: true } }
        },
        orderBy: { updatedAt: "desc" },
        take: 200
    });
    return rows.map((row) => ({
        id: row.id,
        title: row.title,
        status: row.status === "closed" ? "closed" : "open",
        dates: row._count.dates,
        participants: row.participants.length,
        answered: row.participants.filter((participant) => participant.respondedAt !== null).length,
        updatedAt: row.updatedAt.toISOString()
    }));
}

export async function proposal(user: SessionUser, id: string): Promise<ProposalView> {
    return view(await ownProposal(user, id));
}

/** Tell participants they have been asked: the bell for an account, mail for
 *  anybody else. One that cannot be reached does not stop the rest. */
async function invite(
    owner: SessionUser,
    row: ProposalRow,
    participantIds: readonly string[]
): Promise<void> {
    if (!row.notify || participantIds.length === 0) return;
    const base = await host.domainService.appBaseUrl();
    const locale = await localeOf(owner.id);
    for (const participant of row.participants.filter((entry) =>
        participantIds.includes(entry.id)
    )) {
        const link = `${base}/cal/vote/${participant.token}`;
        try {
            if (participant.userId) {
                const t = await calendarTFor(participant.userId);
                await host.notificationsDispatch.notify({
                    userId: participant.userId,
                    event: "calendar.proposal",
                    title: t("proposals.notifyTitle", { who: owner.name, title: row.title }),
                    body: t("proposals.notifyBody", { count: row.dates.length }),
                    href: `/cal/vote/${participant.token}`
                });
                continue;
            }
            const t = calendarTIn(locale);
            const result = await host.calendarHost.sendCalendarEmail({
                to: participant.email,
                subject: t("proposals.mailSubject", { who: owner.name, title: row.title }),
                text: `${[
                    t("proposals.mailIntro", { who: owner.name }),
                    "",
                    row.title,
                    ...(row.location ? [row.location] : []),
                    ...(row.description ? ["", row.description] : []),
                    "",
                    t("proposals.mailAction"),
                    link
                ].join("\n")}\n`
            });
            if (result.error)
                console.error("polaris: a proposal email was not sent:", result.error);
        } catch (caught) {
            console.error("polaris: a proposal participant was not told:", caught);
        }
    }
}

/** The Polaris accounts behind these addresses. */
async function accountsFor(emails: readonly string[]): Promise<Map<string, string>> {
    const found = await host.calendarHost.accountsByEmail(emails);
    return new Map(found.map((account) => [account.email, account.id]));
}

/** Spend the owner's allowance of mail to people outside Polaris on the people
 *  about to be asked, before anything is written. */
async function spendMail(
    user: SessionUser,
    notify: boolean,
    emails: readonly string[],
    accounts: Map<string, string>
): Promise<void> {
    const outside = notify ? emails.filter((email) => !accounts.has(email)).length : 0;
    if (!(await mayMailOutside(user.id, outside)))
        throw new CalendarRefusal((await calendarT())("proposals.slowDown"));
}

export async function createProposal(
    user: SessionUser,
    input: ProposalInput
): Promise<ProposalView> {
    const open = await prisma.calendarProposal.count({
        where: { ownerId: user.id, status: "open" }
    });
    if (open >= MAX_OPEN) throw new CalendarRefusal((await calendarT())("proposals.tooMany"));
    const emails = input.participants.map((participant) => participant.email);
    const accounts = await accountsFor(emails);
    await spendMail(user, input.notify, emails, accounts);
    const created = await prisma.calendarProposal.create({
        data: {
            ownerId: user.id,
            title: input.title,
            description: input.description,
            location: input.location,
            durationMinutes: input.durationMinutes,
            timezone: input.timezone,
            notify: input.notify,
            dates: { create: input.dates.map((start) => ({ start: new Date(start) })) },
            participants: {
                create: input.participants.map((participant) => ({
                    email: participant.email,
                    name: participant.name,
                    required: participant.required,
                    userId: accounts.get(participant.email) ?? null,
                    token: newLinkToken()
                }))
            }
        },
        select: { id: true }
    });
    const row = await loadRow(created.id);
    await invite(
        user,
        row,
        row.participants.map((participant) => participant.id)
    );
    return view(row);
}

/**
 * Change an open proposal. Dates kept keep their votes; a date taken away takes
 * its votes with it; people added are asked, people removed lose their link.
 */
export async function updateProposal(
    user: SessionUser,
    id: string,
    input: ProposalInput
): Promise<ProposalView> {
    const row = await ownProposal(user, id);
    if (row.status !== "open") throw new CalendarRefusal((await calendarT())("proposals.closed"));

    const wanted = new Set(input.dates.map((date) => new Date(date).getTime()));
    const keptDates = row.dates.filter((date) => wanted.has(date.start.getTime()));
    const droppedDates = row.dates
        .filter((date) => !wanted.has(date.start.getTime()))
        .map((date) => date.id);
    const newDates = [...wanted].filter(
        (time) => !keptDates.some((date) => date.start.getTime() === time)
    );

    const byEmail = new Map(
        row.participants.map((participant) => [participant.email, participant])
    );
    const wantedEmails = new Set(input.participants.map((participant) => participant.email));
    const removed = row.participants
        .filter((participant) => !wantedEmails.has(participant.email))
        .map((participant) => participant.id);
    const added = input.participants.filter((participant) => !byEmail.has(participant.email));
    const accounts = await accountsFor(added.map((participant) => participant.email));
    await spendMail(
        user,
        input.notify,
        added.map((participant) => participant.email),
        accounts
    );

    await prisma.$transaction([
        prisma.calendarProposal.update({
            where: { id: row.id },
            data: {
                title: input.title,
                description: input.description,
                location: input.location,
                durationMinutes: input.durationMinutes,
                timezone: input.timezone,
                notify: input.notify
            }
        }),
        prisma.calendarProposalDate.deleteMany({ where: { id: { in: droppedDates } } }),
        prisma.calendarProposalDate.createMany({
            data: newDates.map((time) => ({ proposalId: row.id, start: new Date(time) }))
        }),
        prisma.calendarProposalParticipant.deleteMany({ where: { id: { in: removed } } }),
        ...input.participants
            .filter((participant) => byEmail.has(participant.email))
            .map((participant) =>
                prisma.calendarProposalParticipant.update({
                    where: { id: byEmail.get(participant.email)!.id },
                    data: { name: participant.name, required: participant.required }
                })
            ),
        prisma.calendarProposalParticipant.createMany({
            data: added.map((participant) => ({
                proposalId: row.id,
                email: participant.email,
                name: participant.name,
                required: participant.required,
                userId: accounts.get(participant.email) ?? null,
                token: newLinkToken()
            }))
        })
    ]);

    // Votes on dates that are gone are dropped from every ballot.
    if (droppedDates.length > 0) {
        for (const participant of row.participants.filter((entry) => !removed.includes(entry.id))) {
            const votes = readVotes(participant.votes);
            const left = Object.fromEntries(
                Object.entries(votes).filter(([dateId]) => !droppedDates.includes(dateId))
            );
            if (Object.keys(left).length !== Object.keys(votes).length) {
                await prisma.calendarProposalParticipant.update({
                    where: { id: participant.id },
                    data: { votes: JSON.stringify(left) }
                });
            }
        }
    }
    const updated = await loadRow(row.id);
    await invite(
        user,
        updated,
        updated.participants
            .filter((participant) => added.some((entry) => entry.email === participant.email))
            .map((participant) => participant.id)
    );
    return view(updated);
}

export async function deleteProposal(user: SessionUser, id: string): Promise<void> {
    const row = await ownProposal(user, id);
    await prisma.calendarProposal.delete({ where: { id: row.id } });
}

/**
 * Settle on one date: the event is written into the chosen calendar with every
 * participant invited (required or optional as they were asked), and the
 * proposal closes.
 */
export async function chooseDate(
    user: SessionUser,
    input: { proposalId: string; dateId: string; calendarId: string }
): Promise<{ objectId: string }> {
    const t = await calendarT();
    const row = await ownProposal(user, input.proposalId);
    if (row.status !== "open") throw new CalendarRefusal(t("proposals.closed"));
    const date = row.dates.find((entry) => entry.id === input.dateId);
    if (!date) throw new CalendarRefusal(t("proposals.dateGone"));
    const calendar = await requireWritableCalendar(user.id, input.calendarId);
    const zone = engine.resolveZone(row.timezone) ?? "UTC";
    const end = new Date(date.start.getTime() + row.durationMinutes * 60_000);
    const at = (instant: Date) => ({
        dateTime: engine.formatWall(engine.instantToWall(instant, zone)),
        tzid: zone
    });
    const item = engine.eventItem(
        engine.newEvent({
            summary: row.title,
            description: row.description,
            location: row.location,
            start: at(date.start),
            end: at(end),
            organizer: { email: user.email.toLowerCase(), name: user.name },
            attendees: row.participants.map((participant) => ({
                email: participant.email,
                name: participant.name,
                role: participant.required ? "REQ-PARTICIPANT" : "OPT-PARTICIPANT",
                partstat: "NEEDS-ACTION",
                rsvp: true,
                type: "INDIVIDUAL"
            }))
        })
    );
    const claimed = await prisma.calendarProposal.updateMany({
        where: { id: row.id, status: "open" },
        data: { status: "closed", calendarId: calendar.id }
    });
    if (claimed.count === 0) throw new CalendarRefusal(t("proposals.closed"));
    let objectId: string;
    try {
        objectId = await writeItem(calendar.id, null, item, { actor: user, floatingZone: zone });
    } catch (caught) {
        await prisma.calendarProposal.update({
            where: { id: row.id },
            data: { status: "open", calendarId: row.calendarId }
        });
        throw caught;
    }
    await prisma.calendarProposal.update({ where: { id: row.id }, data: { objectId } });
    return { objectId };
}

// ---------------------------------------------------------------- the vote link

async function participantByToken(token: string) {
    if (!/^[A-Za-z0-9_-]{20,64}$/.test(token)) return null;
    return prisma.calendarProposalParticipant.findUnique({
        where: { token },
        include: { proposal: { include: INCLUDE } }
    });
}

/** A proposal as one participant's link shows it. Other people's votes and
 *  addresses are not part of it. */
export async function votePage(token: string): Promise<VotePageView | null> {
    const participant = await participantByToken(token);
    if (!participant) return null;
    const row = participant.proposal;
    const [owner] = await host.calendarHost.peopleByIds([row.ownerId]);
    let chosen: string | null = null;
    if (row.status === "closed" && row.objectId) {
        const object = await prisma.calendarObject.findUnique({
            where: { id: row.objectId },
            select: { startsAt: true, deletedAt: true }
        });
        chosen = object && !object.deletedAt ? (object.startsAt?.toISOString() ?? null) : null;
    }
    return {
        title: row.title,
        description: row.description,
        location: row.location,
        durationMinutes: row.durationMinutes,
        timezone: row.timezone,
        status: row.status === "closed" ? "closed" : "open",
        organizer: owner?.name ?? "",
        participantName: participant.name,
        dates: row.dates.map((date) => ({ id: date.id, start: date.start.toISOString() })),
        votes: readVotes(participant.votes),
        chosen
    };
}

/** Record one participant's ballot and tell the owner. */
export async function castVotes(
    token: string,
    votes: Readonly<Record<string, Vote>>
): Promise<void> {
    const t = await calendarT();
    await throttle(`calendar.vote:${await callerAddress()}`, 60, 3_600_000);
    await throttle(`calendar.vote-token:${token}`, 20, 3_600_000);
    const participant = await participantByToken(token);
    if (!participant) throw new CalendarRefusal(t("vote.linkGone"));
    const row = participant.proposal;
    if (row.status !== "open") throw new CalendarRefusal(t("proposals.closed"));
    const known = new Set(row.dates.map((date) => date.id));
    const ballot = Object.fromEntries(
        Object.entries(votes).filter(([dateId]) => known.has(dateId))
    );
    const first = participant.respondedAt === null;
    await prisma.calendarProposalParticipant.update({
        where: { id: participant.id },
        data: { votes: JSON.stringify(ballot), respondedAt: new Date() }
    });
    const owner = await calendarTFor(row.ownerId);
    await host.notificationsDispatch
        .notify({
            userId: row.ownerId,
            event: "calendar.proposal",
            title: owner(first ? "proposals.votedTitle" : "proposals.revotedTitle", {
                who: participant.name || participant.email,
                title: row.title
            }),
            href: `/calendar/proposals/${row.id}`
        })
        .catch((caught: unknown) =>
            console.error("polaris: a proposal notice was not sent:", caught)
        );
}
