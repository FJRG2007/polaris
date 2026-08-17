/**
 * Reading somebody's privacy settings, and answering "may this person see that".
 *
 * The rule itself is `core.audienceAllows` - pure, and testable without a
 * database. This is the part that needs one: the row, the friendship, the list of
 * people a rule names, and whether the person looking administers the instance.
 *
 * Three things are stated here because they are easy to lose sight of:
 *
 * - An account with no row is on the defaults. Absence is not a stricter
 *   setting; somebody who has never opened the screen has not asked for
 *   anything - which is why the two that arrive shut (the address and the
 *   number) are shut in the schema's defaults rather than by the absence of a
 *   row.
 * - An administrator sees everything. That is said in the copy on the screen
 *   too, because a setting that pretended otherwise would be a promise Polaris
 *   cannot keep - whoever runs the instance can read the database.
 * - A rule that names a list nobody can find shows nothing. The list is only
 *   ever read here, so the failure to find one has to fail closed here.
 */

import { prisma } from "@polaris/db";
import * as core from "@polaris/core";
import { friendIds } from "@/lib/friends-service";

/** Something the person doing it can be told about, in a sentence. */
export class PrivacyError extends Error {
    constructor(message: string) {
        super(message);
        this.name = "PrivacyError";
    }
}

/** The columns holding one row's audiences, which is every field there is. */
const AUDIENCE_COLUMNS = {
    avatar: true,
    photoFullSize: true,
    email: true,
    phone: true,
    lastSeen: true,
    forwarding: true,
    discoverable: true,
    readReceipts: true
} as const;

export async function privacyFor(userId: string): Promise<core.PrivacySettings> {
    const [row, links] = await Promise.all([
        prisma.userPrivacy.findUnique({ where: { userId }, select: AUDIENCE_COLUMNS }),
        prisma.privacyFieldList.findMany({
            where: { userId },
            select: {
                field: true,
                listId: true,
                list: { select: { name: true, members: { select: { userId: true } } } }
            }
        })
    ]);
    if (!row && links.length === 0) return core.DEFAULT_PRIVACY;

    // A named list comes back as the id it is; a setting's own unnamed one comes
    // back as the people on it, because that is what its row draws and the id is
    // an implementation detail of having somewhere to keep them.
    const linked = new Map(
        links.map((link) => [
            link.field,
            link.list.name === ""
                ? { listId: null, people: link.list.members.map((member) => member.userId) }
                : { listId: link.listId, people: [] }
        ])
    );
    const parsed = core.privacySettingsSchema.safeParse(
        Object.fromEntries(
            core.PRIVACY_FIELDS.map((field) => [
                field,
                { audience: core.storedAudience(field, row?.[field]), ...(linked.get(field) ?? {}) }
            ])
        )
    );
    return parsed.success ? parsed.data : core.DEFAULT_PRIVACY;
}

/**
 * Which of these accounts let this viewer do one thing.
 *
 * Asked of a set rather than one at a time because that is how it comes up: a
 * search asks about a page of results, and a conversation asks about the authors
 * of fifty messages. One query for the settings, and one more each for the lists
 * and the friendships - both only when somebody's answer actually turns on them,
 * which is the uncommon case.
 *
 * Absence is the schema's default, as everywhere else: an account that has never
 * opened the screen has not asked for anything.
 */
export async function allowedBy(
    viewer: PrivacyViewer,
    field: keyof core.PrivacySettings,
    userIds: readonly string[]
): Promise<Set<string>> {
    const wanted = [...new Set(userIds)];
    if (wanted.length === 0) return new Set();
    // Nothing to look up: an administrator sees everything, and everybody sees
    // their own.
    if (viewer.isAdmin) return new Set(wanted);

    // The whole row rather than the one column: which column is a parameter
    // here, and a computed key in a `select` is a type Prisma cannot check. Seven
    // short strings, on a table with one row per account.
    const rows = await prisma.userPrivacy.findMany({
        where: { userId: { in: wanted } },
        select: { userId: true, ...AUDIENCE_COLUMNS }
    });
    const stored = new Map(rows.map((row) => [row.userId, row[field]]));
    // An account with no row of its own falls to the field's own default, which
    // for an address and a number is nobody. Read through `storedAudience` and
    // never by parsing a rule around it: a default on the whole rule does not
    // fire for a rule that is present with an empty audience.
    const audiences = new Map(
        wanted.map((userId) => [userId, core.storedAudience(field, stored.get(userId))])
    );
    const [listed, friends] = await Promise.all([
        listingViewer(
            viewer.id,
            field,
            wanted.filter((userId) => core.audienceNeedsList(audiences.get(userId)!))
        ),
        wanted.some((userId) => {
            const audience = audiences.get(userId)!;
            return audience === "friends" || audience === "friendsExcept";
        })
            ? friendIds(viewer.id)
            : new Set<string>()
    ]);

    return new Set(
        wanted.filter((userId) =>
            core.audienceAllows(audiences.get(userId)!, {
                self: userId === viewer.id,
                friends: friends.has(userId),
                viewerIsAdmin: false,
                inList: listed.has(userId)
            })
        )
    );
}

/**
 * Which of these accounts have this viewer on the list their rule names.
 *
 * Two reads and never per subject: the rows that say which list each setting
 * uses, then one look for the viewer across every list named. A subject whose
 * rule names a list that has gone is simply not in the answer, which is what
 * makes a deleted list close a setting rather than open it.
 */
async function listingViewer(
    viewerId: string,
    field: keyof core.PrivacySettings,
    subjectIds: readonly string[]
): Promise<Set<string>> {
    if (subjectIds.length === 0) return new Set();

    const links = await prisma.privacyFieldList.findMany({
        where: { field, userId: { in: [...subjectIds] } },
        select: { userId: true, listId: true }
    });
    if (links.length === 0) return new Set();

    const holding = await prisma.privacyListMember.findMany({
        where: { userId: viewerId, listId: { in: links.map((link) => link.listId) } },
        select: { listId: true }
    });
    const has = new Set(holding.map((row) => row.listId));
    return new Set(links.filter((link) => has.has(link.listId)).map((link) => link.userId));
}

/** Somebody, as a list has them before it knows what it may say about them. */
export interface ContactPerson {
    readonly id: string;
    readonly email: string;
    readonly username: string | null;
}

/**
 * The line under somebody's name on a list of people.
 *
 * Their address when they allow this viewer to see it, and their handle when
 * they do not - the line is there to tell two people with the same name apart.
 * An account with neither gets an empty line and the row simply leaves it out,
 * which is the honest answer: there is nothing this reader may be told.
 *
 * It exists because every roster, every share dialog and every member list wants
 * the same thing and each of them used to reach for the address directly. One
 * function, one decision: a screen that has never heard of the privacy setting
 * cannot leak past it.
 */
export async function contactLines(
    viewer: PrivacyViewer,
    people: readonly ContactPerson[]
): Promise<Map<string, string>> {
    const allowed = await allowedBy(
        viewer,
        "email",
        people.map((person) => person.id)
    );
    return new Map(
        people.map((person) => [
            person.id,
            allowed.has(person.id) ? person.email : person.username ? `@${person.username}` : ""
        ])
    );
}

/** Which of these accounts this viewer is allowed to find. */
export async function discoverableBy(
    viewer: PrivacyViewer,
    userIds: readonly string[]
): Promise<Set<string>> {
    return allowedBy(viewer, "discoverable", userIds);
}

/**
 * Save the audiences, and the people each one names.
 *
 * One save for the whole screen, including the people picked on a row: a chip
 * that stayed after a reload because it wrote itself, next to a dropdown that did
 * not because nobody pressed Save, is a screen that lies about what is in force.
 *
 * A list id arriving from a form is a claim like any other, so every one of them
 * has to be this account's own - pointing a setting at somebody else's list would
 * let anybody decide who counts as an exception for anybody.
 *
 * Only the audiences that name people keep any. A row moved to "everybody" or
 * "nobody" is a row that no longer means anybody in particular, and keeping the
 * names it used to carry would be somebody's answer to a question they stopped
 * being asked - held indefinitely, and put back silently the day the audience
 * changes again.
 */
export async function setPrivacy(userId: string, settings: core.PrivacySettings): Promise<void> {
    const naming = core.PRIVACY_FIELDS.filter((field) =>
        core.audienceNeedsList(settings[field].audience)
    );
    const saved = naming
        .map((field) => ({ field, listId: settings[field].listId }))
        .filter(
            (entry): entry is { field: core.PrivacyField; listId: string } => entry.listId !== null
        );
    await assertOwnLists(
        userId,
        saved.map((entry) => entry.listId)
    );

    // The rows keeping their own set of people. Written before the links below,
    // which have to name a list that exists.
    const own: { field: core.PrivacyField; listId: string }[] = [];
    for (const field of naming) {
        const rule = settings[field];
        if (rule.listId !== null || rule.people.length === 0) continue;
        own.push({ field, listId: await ownListFor(userId, field, rule.people) });
    }

    const named = [...saved, ...own];
    const audiences = Object.fromEntries(
        core.PRIVACY_FIELDS.map((field) => [field, settings[field].audience])
    ) as Record<core.PrivacyField, core.PrivacyAudience>;

    await prisma.$transaction([
        prisma.userPrivacy.upsert({
            where: { userId },
            create: { userId, ...audiences },
            update: audiences
        }),
        prisma.privacyFieldList.deleteMany({
            where: { userId, field: { notIn: named.map((entry) => entry.field) } }
        }),
        ...named.map((entry) =>
            prisma.privacyFieldList.upsert({
                where: { userId_field: { userId, field: entry.field } },
                create: { userId, field: entry.field, listId: entry.listId },
                update: { listId: entry.listId }
            })
        )
    ]);

    await forgetUnusedOwnLists(userId);
}

/**
 * The list one setting keeps its own people on, made if it has none yet.
 *
 * Reused rather than replaced so the row's set survives a change of audience -
 * switching from "everybody except" to "only" and back must not lose the two
 * names that were picked.
 *
 * A row that was pointing at a saved list gets a new list of its own instead of
 * quietly rewriting the saved one: that list is somebody else's answer too.
 */
async function ownListFor(
    userId: string,
    field: core.PrivacyField,
    people: readonly string[]
): Promise<string> {
    const link = await prisma.privacyFieldList.findUnique({
        where: { userId_field: { userId, field } },
        select: { list: { select: { id: true, name: true } } }
    });
    const own = link && link.list.name === "" ? link.list.id : null;
    const listId =
        own ?? (await prisma.privacyList.create({ data: { userId }, select: { id: true } })).id;
    await setListMembers(userId, listId, people);
    return listId;
}

/** An unnamed list nothing points at is nothing: it existed only as the set one
 *  setting was using, and that setting has moved on. */
async function forgetUnusedOwnLists(userId: string): Promise<void> {
    await prisma.privacyList.deleteMany({ where: { userId, name: "", usedBy: { none: {} } } });
}

/** Who is asking, as every check below needs them. */
export interface PrivacyViewer {
    readonly id: string;
    readonly isAdmin: boolean;
}

/**
 * Whether this viewer may see one thing about one person.
 *
 * The same decision as `allowedBy`, asked about one - and made by it, so there is
 * one place where an audience, a friendship and a list turn into a yes or a no.
 */
export async function maySee(
    subjectId: string,
    field: keyof core.PrivacySettings,
    viewer: PrivacyViewer
): Promise<boolean> {
    if (subjectId === viewer.id || viewer.isAdmin) return true;
    return (await allowedBy(viewer, field, [subjectId])).has(subjectId);
}

/**
 * Whether ticks may be drawn between these two people.
 *
 * Reciprocal, and that is the whole point of the function existing rather than
 * one `maySee` call at the call site: somebody who hides that they read a
 * message does not get to see that theirs was read. A one-way version of this is
 * not a privacy setting, it is a mirror.
 *
 * Asked in both directions rather than by comparing the two settings, so
 * "everybody except him" and "only her" mean here exactly what they mean
 * everywhere else.
 *
 * An administrator sees them either way, like everything else.
 */
export async function receiptsBetween(viewer: PrivacyViewer, otherId: string): Promise<boolean> {
    if (viewer.isAdmin) return true;
    if (viewer.id === otherId) return true;

    const [theirs, mine] = await Promise.all([
        maySee(otherId, "readReceipts", viewer),
        maySee(viewer.id, "readReceipts", { id: otherId, isAdmin: false })
    ]);
    return theirs && mine;
}

// ---------------------------------------------------------------------------
// The lists a rule names
// ---------------------------------------------------------------------------

/** One of somebody's lists, as the screen draws it. */
export interface PrivacyListView {
    readonly id: string;
    /** Empty for the set picked for one setting rather than saved. */
    readonly name: string;
    readonly members: { id: string; name: string }[];
    /** Which settings use it, so a saved list says what it is doing before
     *  anybody edits or deletes it. */
    readonly usedBy: core.PrivacyField[];
}

/**
 * The lists this account has saved under a name.
 *
 * Only those: a set picked on one setting's row is that setting's, is drawn on
 * it, and appearing here as well would be the same people in two places with two
 * ways to edit them.
 */
export async function listsFor(userId: string): Promise<PrivacyListView[]> {
    const rows = await prisma.privacyList.findMany({
        where: { userId, name: { not: "" } },
        orderBy: [{ name: "asc" }],
        select: {
            id: true,
            name: true,
            members: { select: { user: { select: { id: true, name: true, username: true } } } },
            usedBy: { select: { field: true } }
        }
    });
    return rows.map((row) => ({
        id: row.id,
        name: row.name,
        members: row.members
            .map((member) => nameOf(member.user))
            .sort((left, right) => left.name.localeCompare(right.name)),
        usedBy: row.usedBy
            .map((use) => use.field)
            .filter((field): field is core.PrivacyField =>
                (core.PRIVACY_FIELDS as readonly string[]).includes(field)
            )
    }));
}

/** What to call somebody on a chip. Never their address: that is the one thing
 *  this whole screen exists to keep off other people's. */
function nameOf(user: { id: string; name: string; username: string | null }): {
    id: string;
    name: string;
} {
    return { id: user.id, name: user.name || (user.username ? `@${user.username}` : "Somebody") };
}

/** Names for the people a rule holds ids for, so a row can draw who it means. */
export async function namePeople(ids: readonly string[]): Promise<{ id: string; name: string }[]> {
    const wanted = [...new Set(ids)];
    if (wanted.length === 0) return [];
    const rows = await prisma.user.findMany({
        where: { id: { in: wanted } },
        select: { id: true, name: true, username: true }
    });
    return rows.map(nameOf);
}

/** Refuse anything that is not this account's own. */
async function assertOwnLists(userId: string, listIds: readonly string[]): Promise<void> {
    const wanted = [...new Set(listIds)];
    if (wanted.length === 0) return;
    const mine = await prisma.privacyList.count({ where: { userId, id: { in: wanted } } });
    if (mine !== wanted.length) throw new PrivacyError("That list is not yours");
}

/**
 * Start a list, saved under a name.
 *
 * The members are ids the picker gave back, and they are stored as they are:
 * naming somebody in your own list is not a thing they get a say in, any more
 * than writing a name in an address book is - it decides nothing about them and
 * is never shown to them.
 */
export async function createList(userId: string, input: core.PrivacyListInput): Promise<string> {
    const members = await realPeople(input.members);
    const list = await prisma.privacyList.create({
        data: {
            userId,
            name: input.name,
            members: { create: members.map((memberId) => ({ userId: memberId })) }
        },
        select: { id: true }
    });
    return list.id;
}

/** What a list is called and who is on it, in one write - which is how the
 *  dialog that edits it is shaped, and two writes would leave a renamed list
 *  with the wrong people if the second one failed. */
export async function updateList(
    userId: string,
    listId: string,
    input: core.PrivacyListInput
): Promise<void> {
    await assertOwnLists(userId, [listId]);
    await prisma.privacyList.update({ where: { id: listId }, data: { name: input.name } });
    await setListMembers(userId, listId, input.members);
}

/** Replace who is on a list. Sent whole rather than one add at a time: the
 *  picker hands back the set somebody ended up with, and a diff computed in the
 *  browser is a diff that can be wrong. */
async function setListMembers(
    userId: string,
    listId: string,
    memberIds: readonly string[]
): Promise<void> {
    await assertOwnLists(userId, [listId]);
    const members = await realPeople(memberIds);
    await prisma.$transaction([
        prisma.privacyListMember.deleteMany({
            where: members.length === 0 ? { listId } : { listId, userId: { notIn: members } }
        }),
        ...members.map((memberId) =>
            prisma.privacyListMember.upsert({
                where: { listId_userId: { listId, userId: memberId } },
                create: { listId, userId: memberId },
                update: {}
            })
        )
    ]);
}

/**
 * Delete a list.
 *
 * Refused while a setting names it, and named in the refusal. Deleting it would
 * leave that rule pointing at nothing, and a rule pointing at nothing shows
 * nobody anything - which is safe, and is also a setting silently changing
 * meaning behind somebody's back.
 */
export async function deleteList(userId: string, listId: string): Promise<void> {
    await assertOwnLists(userId, [listId]);
    const inUse = await prisma.privacyFieldList.findMany({
        where: { listId },
        select: { field: true }
    });
    if (inUse.length > 0) {
        const names = inUse
            .map((use) => core.PRIVACY_FIELD_LABELS[use.field as core.PrivacyField] ?? use.field)
            .join(", ");
        throw new PrivacyError(`That list is still in use by: ${names.toLowerCase()}`);
    }
    await prisma.privacyList.delete({ where: { id: listId } });
}

/** The ids that are real accounts, in the order they were given. Anything else
 *  is dropped rather than refused: a list is not worth an error over somebody
 *  who has since deleted their account. */
async function realPeople(ids: readonly string[]): Promise<string[]> {
    const wanted = [...new Set(ids)];
    if (wanted.length === 0) return [];
    const found = await prisma.user.findMany({
        where: { id: { in: wanted } },
        select: { id: true }
    });
    const real = new Set(found.map((person) => person.id));
    return wanted.filter((id) => real.has(id));
}
