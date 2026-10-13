/**
 * What the CRM app needs from the dashboard beyond what other apps take: which
 * shelf the reader is working from, what their organization's roles let them do
 * there, and who is on that shelf to own a record.
 *
 * Each function is one of the dashboard's own services narrowed to the question
 * the app asks, so `lib/app-host/server.ts` can hand it over without handing the
 * app the whole module behind it.
 *
 * Server-only.
 */

import { prisma } from "@polaris/db";
import { resolveScope } from "@/lib/workspace-scope";
import { isUuid } from "@/lib/uuid";
import { CRM_REQUEST_URL_MAX, chatSendSchema, normalizeRelPath } from "@polaris/core";
import { mayReadDrive, requireDriveDriver } from "@/lib/drive-authz";
import { follow, safeUrl } from "@/lib/safe-fetch";
import { sessionCan, type SessionUser } from "@/lib/session";
import { listOrgRoles } from "@/lib/orgs/role-service";
import { listOrgMembers, orgCan, resolveOrgAccess, type OrgActor } from "@/lib/orgs/org-service";

/** The shelf somebody is working from: an organization, or their own (null). */
export interface CrmShelf {
    readonly orgId: string | null;
    readonly orgName: string | null;
}

/** The shelf open in this request, with the membership re-checked. */
export async function crmShelf(userId: string): Promise<CrmShelf> {
    const { org } = await resolveScope(userId);
    return { orgId: org?.id ?? null, orgName: org?.name ?? null };
}

/**
 * What this account's role holds in one organization, or null when it is not
 * theirs to see. The wildcard comes back as is; `hasOrgPermission` from
 * `@polaris/core` reads it.
 */
export async function crmOrgPermissions(
    actor: OrgActor,
    orgId: string
): Promise<readonly string[] | null> {
    return (await resolveOrgAccess(actor, orgId))?.permissions ?? null;
}

/** This account's role in one organization and what it holds, or null when
 *  the organization is not theirs to see. The owner has no role here (null):
 *  nothing an organization writes about its roles holds them back. */
export async function crmOrgAccess(
    actor: OrgActor,
    orgId: string
): Promise<{ readonly role: string | null; readonly permissions: readonly string[] } | null> {
    const access = await resolveOrgAccess(actor, orgId);
    if (!access) return null;
    return { role: access.isOwner ? null : access.role, permissions: access.permissions };
}

/** A role of an organization, as the CRM's rules screen names it. */
export interface CrmOrgRole {
    readonly slug: string;
    readonly name: string;
    readonly permissions: readonly string[];
}

/** The organization's roles, for somebody whose role manages them; nothing
 *  for anybody else. */
export async function crmOrgRoles(actor: OrgActor, orgId: string): Promise<CrmOrgRole[]> {
    if (!orgCan(await resolveOrgAccess(actor, orgId), "roles.manage")) return [];
    return (await listOrgRoles(orgId)).map((role) => ({
        slug: role.slug,
        name: role.name,
        permissions: role.permissions
    }));
}

/** Somebody who can own a record on a shelf. */
export interface CrmShelfPerson {
    readonly id: string;
    readonly name: string;
    /** Their address or handle, as far as they let this reader see it. */
    readonly contact: string;
}

/**
 * Who may be named as a record's owner on an organization's shelf: its roster,
 * with each line under a name as private as the roster screen draws it.
 * Nobody, for a reader whose role does not see the roster.
 */
export async function crmOrgPeople(actor: OrgActor, orgId: string): Promise<CrmShelfPerson[]> {
    if (!orgCan(await resolveOrgAccess(actor, orgId), "org.read")) return [];
    return (await listOrgMembers(orgId, actor)).map((member) => ({
        id: member.userId,
        name: member.name,
        contact: member.contact
    }));
}

/** A note as a CRM record lists it. */
export interface CrmNote {
    readonly id: string;
    readonly title: string;
    /** The opening of its text, plain. */
    readonly excerpt: string;
    readonly updatedAt: string;
}

/** A Notes shelf a note can be written on from a record: null is the reader's own. */
export interface CrmNoteShelf {
    readonly id: string | null;
    readonly name: string;
}

async function mayUseNotes(actor: OrgActor): Promise<boolean> {
    if (actor.isAdmin) return true;
    const { userHasPermission } = await import("@polaris/auth");
    return userHasPermission(actor.id, "notes.use");
}

/** Whether this account may read Notes and Tasks at all, so a record leaves out what it may not open. */
export async function crmReach(actor: OrgActor): Promise<{ notes: boolean; tasks: boolean }> {
    if (actor.isAdmin) return { notes: true, tasks: true };
    const { userHasPermission } = await import("@polaris/auth");
    const [notes, tasks] = await Promise.all([
        userHasPermission(actor.id, "notes.use"),
        userHasPermission(actor.id, "tasks.read")
    ]);
    return { notes, tasks };
}

/**
 * Some notes by id, as far as this account may read them in Notes: one gone,
 * archived, or on a shelf that is not theirs is left out. In the order given.
 */
export async function crmNotesByIds(actor: OrgActor, ids: readonly string[]): Promise<CrmNote[]> {
    if (ids.length === 0 || !(await mayUseNotes(actor))) return [];
    const { prisma } = await import("@polaris/db");
    const access = await import("@/lib/notes/access");
    const spaces = await access.visibleSpaceIds(actor);
    const rows = await prisma.note.findMany({
        where: {
            id: { in: ids.slice(0, 200) },
            archived: false,
            OR: [{ spaceId: null, userId: actor.id }, { spaceId: { in: spaces } }]
        },
        select: { id: true, title: true, body: true, updatedAt: true }
    });
    const found = new Map(
        rows.map((row) => [
            row.id,
            {
                id: row.id,
                title: row.title,
                excerpt: row.body
                    .replace(/[#>*_`~[\]()!-]+/g, " ")
                    .replace(/\s+/g, " ")
                    .trim()
                    .slice(0, 160),
                updatedAt: row.updatedAt.toISOString()
            }
        ])
    );
    return ids.flatMap((id) => found.get(id) ?? []);
}

/**
 * Where this account may write a note from a record: its own shelf, then every
 * Notes space of the open workspace it is a member or better of. Null when it
 * may not use Notes at all.
 */
export async function crmNoteShelves(actor: OrgActor): Promise<CrmNoteShelf[] | null> {
    if (!(await mayUseNotes(actor))) return null;
    const { prisma } = await import("@polaris/db");
    const core = await import("@polaris/core");
    const access = await import("@/lib/notes/access");
    const ids = await access.shelfSpaceIds(actor);
    const spaces = await prisma.noteSpace.findMany({
        where: { id: { in: ids }, archived: false },
        select: { id: true, name: true },
        orderBy: { name: "asc" },
        take: 50
    });
    const roles = await Promise.all(
        spaces.map((space) => access.resolveSpaceRole(actor, space.id))
    );
    return [
        { id: null, name: "" },
        ...spaces.filter((_, at) => {
            const role = roles[at];
            return role === "owner" || (role !== null && core.spaceRoleAtLeast(role!, "member"));
        })
    ];
}

/**
 * Write a note from a record, on the reader's shelf or a space they may write
 * in, through the Notes service. A refusal comes back as its sentence.
 */
export async function crmCreateNote(
    actor: OrgActor,
    input: { title: string; body: string; spaceId: string | null }
): Promise<{ id: string } | { refused: string }> {
    if (!(await mayUseNotes(actor))) return { refused: "" };
    const core = await import("@polaris/core");
    const access = await import("@/lib/notes/access");
    const notes = await import("@/lib/notes/note-service");
    const parsed = core.noteCreateSchema.safeParse({
        title: input.title,
        body: input.body,
        spaceId: input.spaceId
    });
    if (!parsed.success) return { refused: parsed.error.issues[0]?.message ?? "" };
    try {
        await access.requirePlacement(actor, { spaceId: input.spaceId, folderId: null });
        return { id: await notes.createNote(actor.id, parsed.data) };
    } catch (caught) {
        if (caught instanceof access.NoteAccessError) return { refused: caught.message };
        throw caught;
    }
}

/** A Drive file a record points at, as the record page lists it. */
export interface CrmDriveFile {
    readonly id: string;
    readonly name: string;
    /** Where the file opens in Drive. */
    readonly href: string;
}

const driveFileName = (path: string): string => path.split("/").at(-1) || path;

/**
 * A file picked out of Drive, as the id a record can point at: the file's own
 * Drive entry, made if it has none yet, so it follows the file when it is moved
 * or renamed there. Nothing is copied. Refused when the reader may not read the
 * file, or the path is a folder or is gone.
 */
export async function crmDriveFileRef(
    actor: OrgActor,
    connectionId: string,
    rawPath: string
): Promise<{ id: string; name: string } | { refused: true }> {
    let path: string;
    try {
        path = normalizeRelPath(rawPath);
    } catch {
        return { refused: true };
    }
    if (!isUuid(connectionId) || !path) return { refused: true };
    const driver = await requireDriveDriver(actor.id, connectionId, path, "read", {
        skipLock: true
    }).catch(() => null);
    if (!driver) return { refused: true };
    try {
        const stat = await driver.stat(path).catch(() => null);
        if (!stat || stat.kind !== "file") return { refused: true };
    } finally {
        await driver.dispose().catch(() => undefined);
    }
    const connection = await prisma.storageConnection.findUnique({
        where: { id: connectionId },
        select: { ownerId: true, orgId: true }
    });
    const owner = connection?.ownerId ?? connection?.orgId;
    if (!owner) return { refused: true };
    const entry = await prisma.driveItemMeta.upsert({
        where: { connectionId_path: { connectionId, path } },
        create: { ownerId: owner, connectionId, path },
        update: {},
        select: { id: true }
    });
    return { id: entry.id, name: driveFileName(path) };
}

/**
 * The Drive files behind these ids that the reader may still read, in the
 * order asked. A file they lost access to is left out, not named.
 */
export async function crmDriveFiles(
    actor: OrgActor,
    ids: readonly string[]
): Promise<CrmDriveFile[]> {
    if (ids.length === 0) return [];
    const rows: { id: string; connectionId: string; path: string }[] =
        await prisma.driveItemMeta.findMany({
            where: { id: { in: [...ids] } },
            select: { id: true, connectionId: true, path: true }
        });
    const readable = await Promise.all(
        rows.map(async (row) =>
            (await mayReadDrive(actor.id, row.connectionId, row.path)) ? row : null
        )
    );
    const byId = new Map(readable.flatMap((row) => (row ? [[row.id, row] as const] : [])));
    return ids.flatMap((id) => {
        const row = byId.get(id);
        if (!row) return [];
        return [
            {
                id,
                name: driveFileName(row.path),
                href: `/drive/open?c=${encodeURIComponent(row.connectionId)}&p=${encodeURIComponent(row.path)}`
            }
        ];
    });
}

/**
 * The account a CRM workflow runs as, when it still may: not deleted, banned or
 * switched off, and still allowed to use the CRM. Null otherwise, and the
 * workflow does not run.
 */
export async function crmRunner(userId: string): Promise<SessionUser | null> {
    if (!isUuid(userId)) return null;
    const found = await prisma.user.findFirst({
        where: { id: userId, bannedAt: null, disabledAt: null },
        select: { id: true, email: true, name: true, isAdmin: true }
    });
    if (!found) return null;
    const user: SessionUser = { ...found, sessionId: "" };
    return (await sessionCan(user, "crm.use")) ? user : null;
}

/**
 * A CRM workflow's call out: a POST of JSON to the address it was given, only
 * through the checked fetch, so it cannot reach the network Polaris sits on.
 * Answers the status, leaving what came back unread, or why nothing was sent.
 */
export async function crmPostJson(
    address: string,
    body: string
): Promise<{ status: number } | { failed: "address" | "unreachable" }> {
    const url = safeUrl(address, CRM_REQUEST_URL_MAX);
    if (!url) return { failed: "address" };
    const response = await follow(url, "application/json", {
        contentType: "application/json",
        body
    });
    if (!response) return { failed: "unreachable" };
    await response.body?.cancel().catch(() => undefined);
    return { status: response.status };
}

/** A conversation in the reader's own mail, as a record's activity shows it. */
export interface CrmMailThread {
    readonly id: string;
    readonly subject: string;
    readonly snippet: string;
    readonly participants: readonly { readonly name: string; readonly address: string }[];
    readonly messageCount: number;
    readonly lastMessageAt: string;
    readonly href: string;
}

/** An event in the reader's own calendars, as a record's activity shows it. */
export interface CrmCalendarEvent {
    readonly id: string;
    readonly summary: string;
    readonly location: string;
    readonly startsAt: string | null;
    readonly endsAt: string | null;
    readonly allDay: boolean;
    readonly href: string;
}

async function mayUse(actor: OrgActor, permission: "mail.use" | "calendar.use"): Promise<boolean> {
    if (actor.isAdmin) return true;
    const { userHasPermission } = await import("@polaris/auth");
    return userHasPermission(actor.id, permission);
}

/** The mailbox a workflow's email goes from: the first one this account
 *  added. Null when it may not use Mail or has no mailbox. */
async function sendingAccount(actor: OrgActor): Promise<string | null> {
    if (!(await mayUse(actor, "mail.use"))) return null;
    const account = await prisma.mailAccount.findFirst({
        where: { userId: actor.id },
        orderBy: { id: "asc" },
        select: { id: true }
    });
    return account?.id ?? null;
}

/** Whether this account has a mailbox a workflow's email can go from. */
export async function crmCanSendMail(actor: OrgActor): Promise<boolean> {
    return (await sendingAccount(actor)) !== null;
}

/**
 * Queue an email from this account's own mailbox, through the same queue its
 * Send button uses, so it is in its Sent folder like any other. Sent at once:
 * nobody is there to undo it. Answers `refused` when there is no mailbox to
 * send from.
 */
export async function crmSendMail(
    actor: OrgActor,
    message: { to: readonly string[]; subject: string; body: string }
): Promise<{ sent: true } | { refused: "mail" }> {
    const accountId = await sendingAccount(actor);
    if (!accountId) return { refused: "mail" };
    const { queueSend } = await import("@/lib/mailbox/compose");
    await queueSend(actor.id, {
        accountId,
        identityId: null,
        to: message.to.map((address) => ({ name: "", address })),
        cc: [],
        bcc: [],
        replyTo: "",
        subject: message.subject,
        body: message.body,
        attachmentIds: [],
        inReplyToId: null,
        forward: false,
        sendAt: new Date(),
        requestReceipt: false,
        draftId: null
    });
    return { sent: true };
}

/** A chat channel a workflow may post in. */
export interface CrmChatChannel {
    readonly id: string;
    readonly name: string;
}

/** The text channels this account can post in, by name: what a workflow's
 *  chat message may be sent to. Empty when Chat is not theirs to use. */
export async function crmChatChannels(actor: OrgActor): Promise<CrmChatChannel[]> {
    const { listChannels } = await import("@/lib/chat/chat-service");
    try {
        return (await listChannels({ id: actor.id }))
            .filter((channel) => channel.kind === "text" && !channel.archived)
            .map((channel) => ({ id: channel.id, name: channel.name }))
            .sort((a, b) => a.name.localeCompare(b.name));
    } catch (caught) {
        console.error("crm: could not list chat channels", caught);
        return [];
    }
}

/**
 * Post a message in a chat channel as this account, through the same path its
 * composer uses, so the channel's own rules - membership, archive, a time-out -
 * decide. Answers `refused` with Chat's own reason when it will not take it.
 */
export async function crmSendChat(
    actor: OrgActor,
    message: { channelId: string; body: string }
): Promise<{ sent: true } | { refused: string }> {
    const [{ send }, { ChatAccessError }] = await Promise.all([
        import("@/lib/chat/messages"),
        import("@/lib/chat/access")
    ]);
    // A filled-in template can outgrow a message: checked as the composer's
    // input is, before anything is posted.
    const input = chatSendSchema.safeParse(message);
    if (!input.success) return { refused: input.error.issues[0]?.message ?? "invalid" };
    try {
        await send({ id: actor.id }, input.data);
        return { sent: true };
    } catch (caught) {
        if (caught instanceof ChatAccessError) return { refused: caught.message };
        throw caught;
    }
}

/** The most addresses one question asks about: a company with a long staff
 *  list reads its most recent people, not a query the size of the table. */
const MAX_ADDRESSES = 50;

function addressList(addresses: readonly string[]): string[] {
    return [
        ...new Set(
            addresses.map((one) => one.trim().toLowerCase()).filter((one) => one.includes("@"))
        )
    ].slice(0, MAX_ADDRESSES);
}

/**
 * The newest conversations in this account's own mailboxes that any of these
 * addresses took part in, or null when the account may not use Mail. Only the
 * reader's own mail: nobody else's mailbox is read for a record they share.
 * Conversations left only in the trash or junk are not counted.
 */
export async function crmMailWith(
    actor: OrgActor,
    addresses: readonly string[],
    limit: number
): Promise<CrmMailThread[] | null> {
    if (!(await mayUse(actor, "mail.use"))) return null;
    const wanted = addressList(addresses);
    if (wanted.length === 0) return [];
    const accounts = await prisma.mailAccount.findMany({
        where: { userId: actor.id },
        select: { id: true }
    });
    if (accounts.length === 0) return [];
    const { addressesFrom } = await import("@/lib/mailbox/json");
    const { snippetFrom } = await import("@polaris/core");
    const rows = await prisma.mailThread.findMany({
        where: {
            accountId: { in: accounts.map((one) => one.id) },
            // Participants are held lowercased, so containment on the address
            // alone matches whatever name came with it.
            OR: wanted.map((address) => ({ participants: { array_contains: [{ address }] } })),
            messages: {
                some: {
                    deleted: false,
                    folder: { role: { notIn: ["trash", "junk"] } }
                }
            }
        },
        select: {
            id: true,
            subject: true,
            snippet: true,
            participants: true,
            messageCount: true,
            lastMessageAt: true
        },
        orderBy: { lastMessageAt: "desc" },
        take: Math.min(Math.max(limit, 1), 50)
    });
    return rows.map((row) => ({
        id: row.id,
        subject: row.subject,
        snippet: snippetFrom(row.snippet),
        participants: addressesFrom(row.participants).map((one) => ({
            name: one.name,
            address: one.address
        })),
        messageCount: row.messageCount,
        lastMessageAt: row.lastMessageAt.toISOString(),
        href: `/mail/t/${row.id}`
    }));
}

/** Escape what ILIKE reads as a wildcard, so `a_b@x` matches only itself. */
const likeLiteral = (value: string) => value.replace(/[\\%_]/g, "\\$&");

/**
 * The events in this account's own calendars that any of these addresses is
 * invited to or organizes, the latest first, or null when the account may not
 * use Calendar. Read from the stored iCalendar text with its folded lines
 * joined first, since a long address can be split across one.
 */
export async function crmEventsWith(
    actor: OrgActor,
    addresses: readonly string[],
    limit: number
): Promise<CrmCalendarEvent[] | null> {
    if (!(await mayUse(actor, "calendar.use"))) return null;
    const wanted = addressList(addresses);
    if (wanted.length === 0) return [];
    const patterns = wanted.map((address) => `%mailto:${likeLiteral(address)}%`);
    const take = Math.min(Math.max(limit, 1), 50);
    const rows = await prisma.$queryRaw<
        {
            id: string;
            summary: string;
            location: string;
            startsAt: Date | null;
            endsAt: Date | null;
            allDay: boolean;
        }[]
    >`
        SELECT o."id", o."summary", o."location", o."startsAt", o."endsAt", o."allDay"
        FROM "CalendarObject" o
        JOIN "Calendar" c ON c."id" = o."calendarId"
        WHERE c."ownerId" = ${actor.id}::uuid
          AND o."deletedAt" IS NULL
          AND o."component" = 'VEVENT'
          AND regexp_replace(o."ics", E'\r?\n[ \t]', '', 'g') ILIKE ANY (${patterns}::text[])
        ORDER BY o."startsAt" DESC NULLS LAST
        LIMIT ${take}
    `;
    return rows.map((row) => ({
        id: row.id,
        summary: row.summary,
        location: row.location,
        startsAt: row.startsAt?.toISOString() ?? null,
        endsAt: row.endsAt?.toISOString() ?? null,
        allDay: row.allDay,
        href: `/calendar/e/${row.id}`
    }));
}
