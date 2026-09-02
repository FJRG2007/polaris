/**
 * Sending a file or a folder to somebody, and their answer.
 *
 * A transfer is not a share. A share leaves the file where it is and lets
 * somebody else look at it; this puts it in their own Drive, theirs to keep,
 * rename and delete, no longer connected to the original. It is what people
 * actually do by downloading a file and uploading it again, done in one press.
 *
 * Three rules hold the whole thing up, and each of them is here because the
 * alternative is somebody's Drive filling with things they did not ask for:
 *
 *   1. NOTHING LANDS UNTIL IT IS ACCEPTED. A transfer is an offer. The sender
 *      cannot put anything anywhere; the recipient's answer is what copies.
 *   2. WHO MAY OFFER IS THE RECIPIENT'S TO DECIDE, through the same privacy
 *      vocabulary as everything else. Friends by default, colleagues counted as
 *      friends, and `nobody` meaning nobody at all.
 *   3. THE SENDER'S COPY IS NEVER REMOVED FIRST. A move deletes the original
 *      after the copy has landed, so a transfer that fails half way leaves the
 *      file where it was rather than nowhere.
 */

import { prisma } from "@polaris/db";
import * as core from "@polaris/core";
import { blockedBetween } from "@/lib/blocks";
import { pathExists } from "@/lib/upload-naming";
import { allowedBy } from "@/lib/privacy-service";
import { ensurePersonalDrive } from "@/lib/personal-drive";
import { recordItemCreator } from "@/lib/drive-meta-service";
import { getDriverForConnection } from "@/lib/storage-service";
import { ensureOrganizationDrive } from "@/lib/organization-drive";
import { requireDriveDriver, DriveAccessError } from "@/lib/drive-authz";
import { memberOrgIds, resolveOrgAccess, orgCan } from "@/lib/orgs/org-service";

/**
 * How long an unanswered offer stands.
 *
 * A fortnight, because the source is a live path rather than a copy set aside:
 * an offer nobody answered for a month is one whose file has probably moved,
 * been renamed or been deleted, and accepting it then fails in a way that reads
 * as a bug rather than as an old invitation.
 */
const OFFER_STANDS_FOR = 14 * 24 * 60 * 60 * 1000;

/** How many offers one account may have waiting for one recipient. Not a
 *  performance limit: it is what stops "send" being a way to put a hundred
 *  notifications in front of somebody who has not answered the first. */
const PENDING_PER_PAIR = 20;

/** The refusals a person is meant to read. Anything else that goes wrong in here
 *  is a storage failing and its message belongs in the log, not on a screen
 *  where it would name paths nobody asked to publish. */
export class TransferRefused extends Error {}

export type TransferMode = "copy" | "move";

export interface TransferTarget {
    /** An account, or an organization's shelf. Exactly one. */
    readonly userId?: string;
    readonly orgId?: string;
}

/**
 * Who this account may offer a file to, out of the people it named.
 *
 * Asked of a set because that is how it comes up: the send dialog offers a list
 * of people and needs to know which of them the button may be shown for. Anybody
 * refused is simply not offered, which is the same shape every other privacy
 * answer here has - nobody is told they were turned down.
 *
 * A colleague counts as a friend, and only for this. Being put in the same
 * organization is somebody with authority over both accounts saying they work
 * together, which is a stronger statement than a friend request - but it widens
 * `friends`, and nothing else. The colleagues are handed back to the same
 * privacy check as a fact about the sender rather than added to its answer
 * afterwards, because the answer is where every audience that names an
 * exception lives: `nobody`, but also "everybody except him" and "only these
 * two", each of which is a decision somebody made on purpose and none of which
 * a second door here may open.
 */
export async function mayReceiveFrom(
    senderId: string,
    candidateIds: readonly string[]
): Promise<Set<string>> {
    const wanted = [...new Set(candidateIds)].filter((id) => id !== senderId);
    if (wanted.length === 0) return new Set();

    const viewer = { id: senderId, isAdmin: false };
    const allowed = await allowedBy(viewer, "fileTransfers", wanted);

    // The colleagues among the rest, asked again as friends. Only the rest,
    // because somebody already allowed cannot be allowed more.
    const undecided = wanted.filter((id) => !allowed.has(id));
    if (undecided.length > 0) {
        const colleagues = await colleaguesAmong(senderId, undecided);
        if (colleagues.size > 0) {
            for (const id of await allowedBy(
                viewer,
                "fileTransfers",
                [...colleagues],
                colleagues
            )) {
                allowed.add(id);
            }
        }
    }

    // A block holds wherever one account can reach another, and being sent
    // somebody's files is a stronger reach than a friend request. It is asked
    // last and of everybody left, because neither door above closes on it:
    // blocking a friend does not end the friendship, and being colleagues does
    // not either.
    for (const id of await blockedBetween(senderId, [...allowed])) allowed.delete(id);
    return allowed;
}

/**
 * Which of these accounts share an organization with this one.
 *
 * The organization's owner is asked for separately, because an owner is never a
 * member row - otherwise the one account that answers for a company is the one
 * nobody in it can send anything to.
 */
async function colleaguesAmong(
    senderId: string,
    candidateIds: readonly string[]
): Promise<Set<string>> {
    const mine = await memberOrgIds(senderId);
    if (mine.length === 0) return new Set();
    const ids = [...candidateIds];
    const [members, owners] = await Promise.all([
        prisma.organizationMember.findMany({
            where: { orgId: { in: mine }, userId: { in: ids } },
            select: { userId: true }
        }),
        prisma.organization.findMany({
            where: { id: { in: mine }, ownerId: { in: ids } },
            select: { ownerId: true }
        })
    ]);
    return new Set([...members.map((row) => row.userId), ...owners.map((row) => row.ownerId)]);
}

/** Whether this account may put something on an organization's shelf, which is
 *  the same permission as changing anything else on it. */
async function mayOfferToOrg(senderId: string, orgId: string): Promise<boolean> {
    const access = await resolveOrgAccess({ id: senderId, isAdmin: false }, orgId);
    return orgCan(access, "drive.manage");
}

export interface SendInput {
    readonly senderId: string;
    readonly connectionId: string;
    readonly path: string;
    readonly mode: TransferMode;
    readonly note?: string | null;
    /** Everyone it is being offered to at once. */
    readonly to: readonly TransferTarget[];
}

/**
 * Offer one file or folder to one or more places.
 *
 * Several recipients at a time is a copy and only a copy: "move it to all of
 * them" has no meaning, and the one thing worse than refusing that is doing
 * something arbitrary with it.
 */
export async function sendTransfer(input: SendInput): Promise<string[]> {
    const path = core.normalizeRelPath(input.path);
    if (!path) throw new TransferRefused("There is nothing there to send.");
    if (input.to.length === 0) throw new TransferRefused("Choose who to send it to.");
    if (input.mode === "move" && input.to.length > 1) {
        throw new TransferRefused(
            "Sending the file itself works with one recipient. Send a copy to reach several."
        );
    }

    // Reading it is the sender's right to establish, through the same check
    // every other read goes through - so a folder they were merely shown cannot
    // be forwarded out of somebody else's drive by naming its path here. A move
    // additionally has to be theirs to delete.
    const driver = await requireDriveDriver(
        input.senderId,
        input.connectionId,
        path,
        input.mode === "move" ? "delete" : "download"
    );
    let source;
    try {
        source = await driver.stat(path);
    } finally {
        await driver.dispose().catch(() => undefined);
    }

    const userIds = input.to.map((one) => one.userId).filter((id): id is string => Boolean(id));
    const orgIds = input.to.map((one) => one.orgId).filter((id): id is string => Boolean(id));
    const allowed = await mayReceiveFrom(input.senderId, userIds);
    for (const id of userIds) {
        // Deliberately the same sentence whether they said no or do not exist.
        // "That account does not accept files from you" tells a stranger both
        // that the account is there and what its setting is.
        if (!allowed.has(id)) throw new TransferRefused("That is not somebody you can send to.");
    }
    for (const orgId of orgIds) {
        if (!(await mayOfferToOrg(input.senderId, orgId))) {
            throw new TransferRefused("That is not somewhere you can send to.");
        }
    }

    // Only the branches that actually name somebody. An empty object inside an
    // `OR` is an empty filter, which matches every row - so a send to one kind
    // of recipient would count every offer this account has waiting anywhere and
    // turn a per-recipient ceiling into a global one.
    const towards = [
        ...(userIds.length > 0 ? [{ recipientId: { in: userIds } }] : []),
        ...(orgIds.length > 0 ? [{ recipientOrg: { in: orgIds } }] : [])
    ];
    const waiting = await prisma.driveTransfer.count({
        where: { senderId: input.senderId, status: "pending", OR: towards }
    });
    if (waiting + input.to.length > PENDING_PER_PAIR) {
        throw new TransferRefused(
            "There are already several waiting to be answered. Give them a moment."
        );
    }

    const expiresAt = new Date(Date.now() + OFFER_STANDS_FOR);
    const note = (input.note ?? "").trim().slice(0, 500) || null;
    const made: string[] = [];
    for (const target of input.to) {
        const row = await prisma.driveTransfer.create({
            data: {
                senderId: input.senderId,
                connectionId: input.connectionId,
                path,
                name: core.baseName(path),
                isFolder: source.kind === "dir",
                size: source.size,
                mode: input.mode,
                note,
                recipientId: target.userId ?? null,
                recipientOrg: target.orgId ?? null,
                expiresAt
            },
            select: { id: true }
        });
        made.push(row.id);
    }
    return made;
}

export interface TransferView {
    readonly id: string;
    readonly name: string;
    readonly isFolder: boolean;
    readonly size: string;
    readonly mode: TransferMode;
    readonly note: string | null;
    readonly status: string;
    readonly createdAt: Date;
    readonly expiresAt: Date;
    readonly landedPath: string | null;
    readonly failure: string | null;
    readonly senderId: string;
    readonly senderName: string;
    readonly recipientOrg: string | null;
}

const VIEW_SELECT = {
    id: true,
    name: true,
    isFolder: true,
    size: true,
    mode: true,
    note: true,
    status: true,
    createdAt: true,
    expiresAt: true,
    landedPath: true,
    failure: true,
    senderId: true,
    recipientOrg: true,
    sender: { select: { name: true } }
} as const;

function viewOf(row: {
    id: string;
    name: string;
    isFolder: boolean;
    size: bigint;
    mode: string;
    note: string | null;
    status: string;
    createdAt: Date;
    expiresAt: Date;
    landedPath: string | null;
    failure: string | null;
    senderId: string;
    recipientOrg: string | null;
    sender: { name: string };
}): TransferView {
    return {
        id: row.id,
        name: row.name,
        isFolder: row.isFolder,
        // A string, because a folder can hold more bytes than a number here can
        // count and this crosses to the browser.
        size: row.size.toString(),
        mode: row.mode === "move" ? "move" : "copy",
        note: row.note,
        status: row.status,
        createdAt: row.createdAt,
        expiresAt: row.expiresAt,
        landedPath: row.landedPath,
        failure: row.failure,
        senderId: row.senderId,
        senderName: row.sender.name,
        recipientOrg: row.recipientOrg
    };
}

/** Everything waiting for this account to answer: offers made to them, and
 *  offers made to the organizations they may accept for. */
export async function transfersWaitingFor(userId: string): Promise<TransferView[]> {
    const orgIds = await memberOrgIds(userId);
    // Asked of every organization at once. Each answer is two queries of its
    // own, this panel is on every Drive page, and the page beside it is already
    // resolving the same organizations - a serial chain here is a wait in front
    // of a panel that is usually empty.
    const answers = await Promise.all(
        orgIds.map(async (orgId) => ((await mayOfferToOrg(userId, orgId)) ? orgId : null))
    );
    const answerable = answers.filter((orgId) => orgId !== null);
    const rows = await prisma.driveTransfer.findMany({
        where: {
            status: "pending",
            expiresAt: { gt: new Date() },
            // The organization branch only when there is one. A sentinel that
            // matches nothing has no spelling here: the id is a Postgres uuid,
            // and comparing one against a non-uuid raises rather than answering
            // empty - which would take everything waiting for this person with
            // it. See `lib/uuid.ts`.
            OR: [
                { recipientId: userId },
                ...(answerable.length > 0 ? [{ recipientOrg: { in: answerable } }] : [])
            ]
        },
        orderBy: { createdAt: "desc" },
        select: VIEW_SELECT
    });
    return rows.map(viewOf);
}

/**
 * What this account has offered: the ones still waiting, so they can be taken
 * back, and the ones that went wrong, so the sender is told.
 *
 * The second half is not decoration. A move whose copy landed but whose delete
 * failed is a transfer that succeeded and left the sender holding a duplicate
 * they asked to give away - and it leaves the "waiting to be answered" list
 * silently, so without this the only thing they can conclude is that the file
 * left. Anything carrying a `failure` stays in front of them until they say
 * they have read it.
 */
export async function transfersSentBy(userId: string): Promise<TransferView[]> {
    const rows = await prisma.driveTransfer.findMany({
        where: {
            senderId: userId,
            OR: [{ status: "pending" }, { failure: { not: null } }]
        },
        orderBy: { createdAt: "desc" },
        select: VIEW_SELECT
    });
    return rows.map(viewOf);
}

/** Put down a transfer's failure notice, once its sender has read it. The row
 *  keeps its status; only the sentence in front of them goes. */
export async function dismissTransferNotice(transferId: string, senderId: string): Promise<void> {
    const { count } = await prisma.driveTransfer.updateMany({
        where: { id: transferId, senderId, failure: { not: null } },
        data: { failure: null }
    });
    if (count === 0) throw new TransferRefused("There is nothing to put down.");
}

/** Whether this account is the one being asked. */
async function answerableBy(transferId: string, userId: string) {
    const row = await prisma.driveTransfer.findUnique({
        where: { id: transferId },
        select: {
            id: true,
            status: true,
            expiresAt: true,
            senderId: true,
            connectionId: true,
            path: true,
            name: true,
            isFolder: true,
            mode: true,
            recipientId: true,
            recipientOrg: true
        }
    });
    if (!row || row.status !== "pending") return null;
    if (row.expiresAt.getTime() <= Date.now()) return null;
    if (row.recipientId === userId) return row;
    if (row.recipientOrg && (await mayOfferToOrg(userId, row.recipientOrg))) return row;
    return null;
}

/** Turn an offer down. The sender is not told why, and nothing is copied. */
export async function declineTransfer(transferId: string, userId: string): Promise<void> {
    const row = await answerableBy(transferId, userId);
    if (!row) throw new TransferRefused("That is not waiting for you any more.");
    await prisma.driveTransfer.update({
        where: { id: row.id },
        data: { status: "declined", respondedAt: new Date() }
    });
}

/** Take back an offer nobody has answered. */
export async function cancelTransfer(transferId: string, senderId: string): Promise<void> {
    const { count } = await prisma.driveTransfer.updateMany({
        where: { id: transferId, senderId, status: "pending" },
        data: { status: "cancelled", respondedAt: new Date() }
    });
    if (count === 0) throw new TransferRefused("That has already been answered.");
}

/**
 * A name that is not already taken in the folder it is landing in.
 *
 * Overwriting is never the answer here. The recipient did not choose the name -
 * the sender did - so a transfer must not be able to replace a file somebody
 * already had by being called the same thing.
 *
 * Which is why a storage that cannot answer is a refusal rather than a free
 * name. `pathExists` tells "there is nothing here" apart from "I could not
 * look", and only the first is an answer: taking a permissions failure or a
 * dropped connection for a spare name is how the copy below lands on top of the
 * very file nobody could see.
 */
async function freeName(
    driver: Awaited<ReturnType<typeof getDriverForConnection>>,
    folder: string,
    name: string
): Promise<string> {
    const dot = name.lastIndexOf(".");
    const stem = dot > 0 ? name.slice(0, dot) : name;
    const extension = dot > 0 ? name.slice(dot) : "";
    for (let attempt = 0; attempt < 50; attempt++) {
        const candidate = attempt === 0 ? name : `${stem} (${attempt})${extension}`;
        const at = folder ? `${folder}/${candidate}` : candidate;
        if (!(await pathExists(driver, at))) return candidate;
    }
    throw new TransferRefused("There are already too many files by that name.");
}

/** The folder an offer is being accepted into, as a path this drive can hold. A
 *  browser sends it, so a value that climbs out of the drive is a refusal in a
 *  sentence rather than the path library's own error. */
function intoFolder(into: string): string {
    try {
        return core.normalizeRelPath(into);
    } catch {
        throw new TransferRefused("That is not somewhere you can put it.");
    }
}

/**
 * Accept an offer: copy it in, and only then take the sender's away if that is
 * what was asked for.
 *
 * The order is the point. A move that deleted first and failed to copy would
 * lose the file for both of them, so the sender's copy goes last and only once
 * the recipient's is there.
 *
 * Which is also why the two halves do not share one catch. Once the copy has
 * landed the transfer has happened: the recipient must not be told it failed
 * because the sender's own copy could not be cleared afterwards, and the row
 * must not say `failed` over a file that is sitting in their Drive.
 */
export async function acceptTransfer(
    transferId: string,
    userId: string,
    into = ""
): Promise<{ path: string }> {
    const row = await answerableBy(transferId, userId);
    if (!row) throw new TransferRefused("That is not waiting for you any more.");

    // Where it is going, worked out while the offer is still waiting. Both of
    // these can refuse - a folder that came from a browser as `../elsewhere`,
    // a shelf whose id is taken, a storage that is away - and a refusal after
    // the claim below would be a row left `accepting` for six hours: gone from
    // what is waiting to be answered and gone from what the sender can take
    // back, answerable by nobody.
    const folder = intoFolder(into);
    const drive = row.recipientOrg
        ? await ensureOrganizationDrive(row.recipientOrg)
        : await ensurePersonalDrive(userId);

    // Claimed before a single byte moves. Establishing that this account MAY
    // answer is not the same as being the one who DID: an offer made to an
    // organization is answerable by everybody there who can change its shelf,
    // and a second tab does it for a personal one. Two accepts that both got
    // past the check above would both copy, and the second would land beside
    // the first under a ` (1)` suffix - or, for a move, delete a path the
    // first one had already deleted.
    const claimed = await prisma.driveTransfer.updateMany({
        where: { id: row.id, status: "pending" },
        // Stamped now rather than at the end, so a claim that never finishes -
        // the process went away mid-copy - is a row the sweep below can tell
        // from one that is still working.
        data: { status: "accepting", respondedAt: new Date() }
    });
    if (claimed.count === 0) throw new TransferRefused("That has already been answered.");

    const landing = await landCopy(row, drive.id, folder, userId);

    if (row.mode === "move") {
        // Last, and never before. The sender's standing to delete was
        // established when they offered it; a failure here leaves them with
        // their copy, which is the safe way round - and leaves the transfer
        // accepted, because it was.
        try {
            const remover = await requireDriveDriver(
                row.senderId,
                row.connectionId,
                row.path,
                "delete"
            );
            try {
                await remover.delete(row.path, { recursive: true });
            } finally {
                await remover.dispose().catch(() => undefined);
            }
        } catch (caught) {
            console.error("polaris: a sender's copy could not be removed after a move:", caught);
            await prisma.driveTransfer
                .update({
                    where: { id: row.id },
                    data: { failure: "It arrived. The sender's own copy could not be removed." }
                })
                .catch(() => undefined);
        }
    }
    return { path: landing };
}

/** The half that can still fail with nothing having happened: copy it in, and
 *  record where it landed. Answers the path in the recipient's own Drive. */
async function landCopy(
    row: {
        id: string;
        senderId: string;
        connectionId: string;
        path: string;
        name: string;
        isFolder: boolean;
    },
    driveId: string,
    folder: string,
    userId: string
): Promise<string> {
    let source;
    let target;
    let started: string | null = null;
    try {
        // Read as the SENDER, because it is their file and their standing that
        // was checked when they offered it. The recipient never gets a driver on
        // somebody else's drive.
        source = await requireDriveDriver(row.senderId, row.connectionId, row.path, "download");
        // And write as the RECIPIENT, through the same door as every other
        // write. The folder they are landing it in came from a browser, so
        // taking a bare driver here would let somebody put a file in a
        // directory an explicit deny or an access lock holds shut against
        // them - on a company shelf they are otherwise allowed to change, and
        // on their own Drive too.
        target = await requireDriveDriver(userId, driveId, folder, "write");
        const name = await freeName(target, folder, row.name);
        const landing = folder ? `${folder}/${name}` : name;
        started = landing;
        await copyAcross(source, target, row.path, landing, row.isFolder);
        started = null;

        await recordItemCreator(driveId, landing, userId).catch(() => undefined);
        await prisma.driveTransfer.update({
            where: { id: row.id },
            data: { status: "accepted", respondedAt: new Date(), landedPath: landing }
        });
        return landing;
    } catch (caught) {
        await prisma.driveTransfer
            .update({
                where: { id: row.id },
                data: {
                    status: "failed",
                    respondedAt: new Date(),
                    // What a person can act on, never the storage's own
                    // message. Which side was refused decides the sentence:
                    // told "the sender can no longer reach it" when it was
                    // their own folder that was shut, somebody would go and ask
                    // the sender about a file that is sitting right there.
                    failure: !(caught instanceof DriveAccessError)
                        ? "It could not be copied across."
                        : source
                          ? "That is not somewhere you can put it."
                          : "The sender can no longer reach that file."
                }
            })
            .catch(() => undefined);
        // And take the half of it that did land back out. `freeName` had just
        // established the name was nobody's, so what is under it is this
        // copy and nothing else - left there it is a folder appearing in
        // somebody's Drive under a name they never chose, that no screen
        // mentions and no retry would ever clear.
        if (started && target) {
            await target.delete(started, { recursive: true }).catch(() => undefined);
        }
        if (caught instanceof TransferRefused) throw caught;
        throw new TransferRefused(
            caught instanceof DriveAccessError && source
                ? "That is not somewhere you can put it."
                : "That could not be copied across."
        );
    } finally {
        await source?.dispose().catch(() => undefined);
        await target?.dispose().catch(() => undefined);
    }
}

/** One file, or a folder and everything under it, from one drive to another. */
async function copyAcross(
    source: Awaited<ReturnType<typeof getDriverForConnection>>,
    target: Awaited<ReturnType<typeof getDriverForConnection>>,
    from: string,
    to: string,
    isFolder: boolean
): Promise<void> {
    if (!isFolder) {
        await target.writeStream(to, await source.readStream(from));
        return;
    }
    await target.mkdir(to);
    let cursor: string | undefined;
    do {
        const page = await source.list(from, { cursor });
        for (const entry of page.entries) {
            const next = `${to}/${entry.name}`;
            if (entry.kind === "dir") {
                await copyAcross(source, target, entry.path, next, true);
            } else if (entry.kind === "file") {
                await target.writeStream(next, await source.readStream(entry.path));
            }
        }
        cursor = page.nextCursor;
    } while (cursor);
}

/** How long a claimed transfer may be copying before the sweep calls it dead. A
 *  folder of many gigabytes over a slow link is the case this has to clear, so
 *  it is hours rather than minutes. */
const COPY_MAY_TAKE = 6 * 60 * 60 * 1000;

/** Offers nobody answered in time, and copies that were interrupted. Run from
 *  the same sweep everything else is. */
export async function expireTransfers(): Promise<number> {
    const now = new Date();
    const [expired, abandoned] = await Promise.all([
        prisma.driveTransfer.updateMany({
            where: { status: "pending", expiresAt: { lte: now } },
            data: { status: "declined", respondedAt: now }
        }),
        // A claim whose process went away leaves a row that is neither waiting
        // nor finished, and nothing else would ever move it: its `expiresAt` is
        // a fortnight out and it is no longer `pending`. Freed here rather than
        // retried, because whatever it had already copied is sitting in the
        // recipient's Drive and copying it again would land it twice.
        prisma.driveTransfer.updateMany({
            where: {
                status: "accepting",
                respondedAt: { lte: new Date(now.getTime() - COPY_MAY_TAKE) }
            },
            data: { status: "failed", failure: "It was interrupted before it finished." }
        })
    ]);
    return expired.count + abandoned.count;
}
