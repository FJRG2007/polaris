/**
 * What the Calendar app needs from the dashboard beyond what other apps take:
 * the outside accounts people link for it, a way to seal a server password, a
 * fetch that is safe to point at an address somebody typed, the people and
 * teams it shares with and invites, the tasks it shows, and mail that can carry
 * an invitation.
 *
 * Each function is one of the dashboard's own services narrowed to the question
 * the app asks, so `lib/app-host/server.ts` can hand it over without handing the
 * app the whole module behind it.
 *
 * Server-only.
 */

import { loadEnv } from "@polaris/config";
import { prisma, VISIBLE_USER } from "@polaris/db";
import { CredentialDecryptError, decryptSecret, encryptSecret } from "@polaris/storage";
import { getConnection, listConnections, readCredential } from "@/lib/connections/store";
import {
    GOOGLE_CALENDAR_SCOPES,
    GoogleAuthExpiredError,
    getGoogleOAuthClient,
    googleAccessToken
} from "@/lib/google-calendar/service";
import {
    MICROSOFT_CALENDAR_SCOPES,
    MicrosoftAuthExpiredError,
    getMicrosoftOAuthClient,
    microsoftAccessToken
} from "@/lib/connections/microsoft";
import { sendAuthEmail } from "@/lib/auth-mail";
import { configuredRequest } from "@/lib/safe-fetch";
import type { EmailMessage } from "@/lib/mail/types";
import { searchAccounts, type AccountCandidate } from "@/lib/rich-text/mention-service";

/** The providers a calendar can be linked from through a linked account. */
export type CalendarLinkProvider = "google" | "microsoft";

/** One outside account somebody linked, as the Calendar's accounts screen needs it. */
export interface CalendarLink {
    readonly id: string;
    readonly provider: CalendarLinkProvider;
    readonly label: string;
    /** Whether it was granted reading and writing calendars. A link made for
     *  something else (a backup, mail) reaches everything but the calendars and
     *  has to be authorized again for them. */
    readonly grantsCalendar: boolean;
}

/** The scope that decides whether a link reaches calendars, by provider. */
const CALENDAR_SCOPE: Record<CalendarLinkProvider, string> = {
    google: GOOGLE_CALENDAR_SCOPES[GOOGLE_CALENDAR_SCOPES.length - 1]!,
    microsoft: "Calendars.ReadWrite"
};

/** Whether a granted scope string carries calendar read and write access. */
export function grantsCalendar(provider: CalendarLinkProvider, scope: string): boolean {
    const wanted = CALENDAR_SCOPE[provider];
    return scope.split(/\s+/).some((granted) => granted === wanted || granted.endsWith(`/${wanted}`));
}

/** Every Google and Microsoft account this person linked. */
export async function listCalendarLinks(userId: string): Promise<CalendarLink[]> {
    const links = await Promise.all(
        (["google", "microsoft"] as const).map(async (provider) =>
            (await listConnections(userId, provider))
                .filter((link) => link.method === "oauth")
                .map((link) => ({
                    id: link.id,
                    provider,
                    label: link.label,
                    grantsCalendar: grantsCalendar(provider, link.scope)
                }))
        )
    );
    return links.flat();
}

/** Where somebody starts linking an account for their calendars. */
export async function calendarLinkUrl(provider: CalendarLinkProvider): Promise<string> {
    return `/api/connections/${provider}/link?scope=calendar`;
}

/**
 * The link stopped being accepted - revoked, a changed password, or never
 * granted calendars. The app says "connect it again" rather than an error.
 */
export class CalendarLinkExpiredError extends Error {
    constructor() {
        super("The linked account needs authorizing again.");
        this.name = "CalendarLinkExpiredError";
    }
}

/**
 * A fresh access token for one of this person's links, minted for calendars.
 *
 * Refuses a link that is not theirs: the id comes from a row the app stored, and
 * a row is not proof of whose account it is.
 */
export async function calendarAccessToken(userId: string, connectionId: string): Promise<string> {
    const link = await getConnection(userId, connectionId);
    if (!link || (link.provider !== "google" && link.provider !== "microsoft")) {
        throw new CalendarLinkExpiredError();
    }
    const refreshToken = (await readCredential(connectionId))?.refreshToken;
    if (!refreshToken) throw new CalendarLinkExpiredError();
    try {
        if (link.provider === "google") {
            const client = await getGoogleOAuthClient();
            if (!client) throw new CalendarLinkExpiredError();
            return await googleAccessToken(client, refreshToken);
        }
        const client = await getMicrosoftOAuthClient();
        if (!client) throw new CalendarLinkExpiredError();
        return await microsoftAccessToken(
            client,
            refreshToken,
            MICROSOFT_CALENDAR_SCOPES.filter((scope) => scope !== "openid" && scope !== "email")
        );
    } catch (caught) {
        if (caught instanceof GoogleAuthExpiredError || caught instanceof MicrosoftAuthExpiredError) {
            throw new CalendarLinkExpiredError();
        }
        throw caught;
    }
}

/** A secret sealed under the instance master key, as three columns. */
export interface SealedSecret {
    readonly encryptedSecret: Buffer;
    readonly secretNonce: Buffer;
    readonly secretKeyId: string;
}

/** Seal a CalDAV app password for storing. */
export async function sealCalendarSecret(secret: string): Promise<SealedSecret> {
    const blob = encryptSecret(secret, loadEnv().POLARIS_MASTER_KEY);
    return { encryptedSecret: blob.ciphertext, secretNonce: blob.nonce, secretKeyId: blob.keyId };
}

/** The stored password, or null when there is none or the master key it was
 *  sealed under is gone - which reads as "enter it again", like every other
 *  credential in Polaris. */
export async function openCalendarSecret(sealed: {
    readonly encryptedSecret: Uint8Array | null;
    readonly secretNonce: Uint8Array | null;
    readonly secretKeyId: string | null;
}): Promise<string | null> {
    if (!sealed.encryptedSecret || !sealed.secretNonce) return null;
    try {
        return decryptSecret(
            {
                ciphertext: Buffer.from(sealed.encryptedSecret),
                nonce: Buffer.from(sealed.secretNonce),
                keyId: sealed.secretKeyId ?? ""
            },
            loadEnv().POLARIS_MASTER_KEY
        );
    } catch (caught) {
        if (caught instanceof CredentialDecryptError) return null;
        throw caught;
    }
}

/**
 * A request to a calendar server or feed somebody configured.
 *
 * Public addresses only, unless whoever configured it administers this Polaris:
 * a CalDAV server on the operator's own network is an ordinary thing to link,
 * and letting any member point Polaris at the LAN would make the calendar a way
 * to probe it.
 */
export async function calendarFetch(
    url: string,
    init: RequestInit & { timeoutMs?: number },
    options: { allowPrivate: boolean }
): Promise<Response> {
    return configuredRequest(url, init, options);
}

/** One Polaris account, as an attendee or a sharee is drawn. */
export interface CalendarPerson {
    readonly id: string;
    readonly name: string;
    readonly email: string;
    readonly username: string | null;
}

/** Accounts by id. Hidden and deleted accounts are left out. */
export async function peopleByIds(ids: readonly string[]): Promise<CalendarPerson[]> {
    if (ids.length === 0) return [];
    return prisma.user.findMany({
        where: { id: { in: [...new Set(ids)] }, ...VISIBLE_USER },
        select: { id: true, name: true, email: true, username: true }
    });
}

/**
 * The accounts that own these addresses - their main address or any address
 * they added and proved. Used to deliver an invitation inside Polaris rather
 * than by mail; never shown to the organizer.
 */
export async function accountsByEmail(
    emails: readonly string[]
): Promise<{ id: string; email: string }[]> {
    const wanted = [...new Set(emails.map((email) => email.trim().toLowerCase()))].filter(Boolean);
    if (wanted.length === 0) return [];
    const [primary, extra] = await Promise.all([
        prisma.user.findMany({
            where: { email: { in: wanted }, ...VISIBLE_USER },
            select: { id: true, email: true }
        }),
        prisma.userEmail.findMany({
            where: { email: { in: wanted }, verifiedAt: { not: null }, user: VISIBLE_USER },
            select: { userId: true, email: true }
        })
    ]);
    return [
        ...primary.map((row) => ({ id: row.id, email: row.email.toLowerCase() })),
        ...extra.map((row) => ({ id: row.userId, email: row.email.toLowerCase() }))
    ];
}

/** People this account may pick, by the same reach as every other picker. */
export async function searchPeople(
    actor: { id: string; isAdmin: boolean },
    query: string
): Promise<AccountCandidate[]> {
    return searchAccounts(actor, query);
}

/** One team, as a share target. */
export interface CalendarTeam {
    readonly id: string;
    readonly name: string;
    readonly orgName: string;
}

/** The teams this account is in - the ones it may share a calendar with. */
export async function teamsOf(userId: string): Promise<CalendarTeam[]> {
    const rows = await prisma.teamMember.findMany({
        where: { userId },
        select: { team: { select: { id: true, name: true, org: { select: { name: true } } } } }
    });
    return rows.map((row) => ({ id: row.team.id, name: row.team.name, orgName: row.team.org.name }));
}

/** Who is on a team, for a share or an invitation to it. */
export async function teamMemberIds(teamId: string): Promise<string[]> {
    const rows = await prisma.teamMember.findMany({ where: { teamId }, select: { userId: true } });
    return rows.map((row) => row.userId);
}

/** The teams an account is on, for reading a calendar shared with one of them. */
export async function teamIdsOf(userId: string): Promise<string[]> {
    const rows = await prisma.teamMember.findMany({ where: { userId }, select: { teamId: true } });
    return rows.map((row) => row.teamId);
}

/**
 * Send one message through the instance's mail channel, the one sign-in codes
 * and notifications leave by. An error string when there is no channel or it
 * refused - the caller records it and tells the organizer, since an invitation
 * that never left is worth knowing about.
 */
export async function sendCalendarEmail(
    message: EmailMessage
): Promise<{ error?: string }> {
    return sendAuthEmail(message);
}

/** One Tasks task, as the calendar draws it. */
export interface CalendarTask {
    readonly id: string;
    readonly name: string;
    readonly reference: string;
    readonly due: string | null;
    readonly timed: boolean;
    readonly done: boolean;
    readonly listName: string;
}

/**
 * The Tasks work assigned to this account: with a due date inside the window,
 * or with none at all for the unscheduled panel. Only what is assigned to them -
 * a calendar is somebody's own day, and every task they can see would bury it.
 */
export async function assignedTasks(
    userId: string,
    window: { from: Date; to: Date } | "unscheduled",
    limit = 500
): Promise<CalendarTask[]> {
    const rows = await prisma.task.findMany({
        where: {
            archived: false,
            assignees: { some: { userId } },
            ...(window === "unscheduled"
                ? { dueDate: null, completedAt: null }
                : { dueDate: { gte: window.from, lt: window.to } })
        },
        select: {
            id: true,
            name: true,
            number: true,
            dueDate: true,
            timed: true,
            completedAt: true,
            list: { select: { name: true } },
            space: { select: { prefix: true } }
        },
        orderBy: { dueDate: "asc" },
        take: limit
    });
    return rows.map((row) => ({
        id: row.id,
        name: row.name,
        reference: `${row.space.prefix}-${row.number}`,
        due: row.dueDate?.toISOString() ?? null,
        timed: row.timed,
        done: row.completedAt !== null,
        listName: row.list.name
    }));
}

/**
 * Give a task a due date (or take it away), as somebody who may change it.
 * Goes through the Tasks service, so its history, automations and watchers see
 * the change exactly as if it was made on the task.
 */
export async function scheduleTask(
    actor: { id: string; isAdmin: boolean },
    taskId: string,
    due: { at: string; timed: boolean } | null
): Promise<void> {
    const access = await import("@/lib/tasks/access");
    const tasks = await import("@/lib/tasks/task-service");
    await access.requireTask(actor, taskId, "member");
    await tasks.updateTask(actor.id, {
        taskId,
        dueDate: due?.at ?? null,
        ...(due ? { timed: due.timed } : {})
    });
}

/**
 * A Polaris meeting link for an event - Nextcloud's "add a Talk room", Google's
 * Meet link. Only for somebody allowed to hand out meeting links, and only
 * while calls work on this Polaris; otherwise the reason, in the reader's words,
 * so the editor can say why the button did nothing.
 */
export async function createMeetingLink(
    userId: string,
    input: { title: string; scheduledAt: Date | null }
): Promise<{ link: string } | { refused: string }> {
    const { userHasPermission } = await import("@polaris/auth");
    const calls = await import("@/lib/chat/call-server");
    const meetings = await import("@/lib/chat/meetings");
    const { readerWords } = await import("@/lib/i18n/reader-words");
    const allowed =
        (await userHasPermission(userId, "chat.use")) && (await userHasPermission(userId, "chat.meetings"));
    const admin = await prisma.user.findUnique({ where: { id: userId }, select: { isAdmin: true } });
    if (!allowed && !admin?.isAdmin) return { refused: (await readerWords("api"))("refusals.calendar.noMeetings") };
    const off = await calls.callsUnavailable();
    if (off) return { refused: off };
    const created = await meetings.createMeeting(
        { id: userId },
        {
            title: input.title,
            scheduledAt: input.scheduledAt,
            approveGuests: false,
            requireAccount: false
        }
    );
    const { appBaseUrl } = await import("@/lib/domain-service");
    return { link: `${await appBaseUrl()}/m/${created.guestToken}` };
}
