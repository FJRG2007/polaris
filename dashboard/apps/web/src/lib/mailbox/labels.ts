/**
 * Labels, and the identities a mailbox sends as.
 *
 * Two small things that share a file because they are the same kind of thing:
 * something a person adds on top of what the mail server knows about, kept here
 * and pushed to the server only where the server has somewhere to put it.
 *
 * A label is applied to a message by its row AND by its Message-Id. The row is
 * how it is drawn; the header id is how it finds its way back after a mailbox is
 * resynced from scratch and every row has been replaced. Losing somebody's
 * labels because a server reissued its uids would be the kind of quiet data loss
 * that makes people stop trusting a client.
 */

import * as core from "@polaris/core";
import { prisma } from "@polaris/db";
import { MailSetupError } from "./accounts";
import { MailAccessError, ownedAccount } from "./access";

export interface MailLabelView {
    readonly id: string;
    readonly name: string;
    readonly color: string;
    readonly position: number;
    /** How many messages carry it, for the rail. */
    readonly count: number;
}

export async function listLabels(userId: string): Promise<MailLabelView[]> {
    const rows = await prisma.mailLabel.findMany({
        where: { userId },
        orderBy: [{ position: "asc" }, { name: "asc" }],
        select: {
            id: true,
            name: true,
            color: true,
            position: true,
            _count: { select: { messages: true } }
        }
    });
    return rows.map((row) => ({
        id: row.id,
        name: row.name,
        color: row.color,
        position: row.position,
        count: row._count.messages
    }));
}

/** Raised when a name is already taken, which is the one refusal worth its own
 *  sentence: two labels with the same name are two labels nobody can tell
 *  apart. */
export class MailLabelNameTaken extends Error {
    public constructor(name: string) {
        super(`You already have a label called ${name}.`);
        this.name = "MailLabelNameTaken";
    }
}

export async function createLabel(userId: string, name: string, color: string): Promise<string> {
    const held = await prisma.mailLabel.findUnique({
        where: { userId_name: { userId, name } },
        select: { id: true }
    });
    if (held) throw new MailLabelNameTaken(name);
    const last = await prisma.mailLabel.findFirst({
        where: { userId },
        orderBy: { position: "desc" },
        select: { position: true }
    });
    const created = await prisma.mailLabel.create({
        data: { userId, name, color, position: (last?.position ?? -1) + 1 },
        select: { id: true }
    });
    return created.id;
}

export async function renameLabel(
    userId: string,
    labelId: string,
    name: string,
    color: string
): Promise<void> {
    const clash = await prisma.mailLabel.findFirst({
        where: { userId, name, id: { not: labelId } },
        select: { id: true }
    });
    if (clash) throw new MailLabelNameTaken(name);
    await prisma.mailLabel.updateMany({ where: { id: labelId, userId }, data: { name, color } });
}

/** Delete a label. What it was on keeps everything else about it: a label is
 *  something added here, and taking it away takes away nothing else. */
export async function deleteLabel(userId: string, labelId: string): Promise<void> {
    await prisma.mailLabel.deleteMany({ where: { id: labelId, userId } });
}

/** Put a label on a set of messages, or take it off them. */
export async function applyLabel(
    userId: string,
    labelId: string,
    messageIds: readonly string[],
    applied: boolean
): Promise<number> {
    const label = await prisma.mailLabel.findFirst({
        where: { id: labelId, userId },
        select: { id: true }
    });
    if (!label) return 0;
    const messages = await prisma.mailMessage.findMany({
        where: { id: { in: [...messageIds] }, account: { userId } },
        select: { id: true, messageId: true }
    });
    if (messages.length === 0) return 0;

    if (!applied) {
        const removed = await prisma.mailMessageLabel.deleteMany({
            where: { labelId, messageId: { in: messages.map((message) => message.id) } }
        });
        return removed.count;
    }

    // createMany with skipDuplicates rather than a loop: labelling a hundred
    // selected messages is one statement, and applying a label that is already
    // on one of them is not an error.
    const added = await prisma.mailMessageLabel.createMany({
        data: messages.map((message) => ({
            labelId,
            messageId: message.id,
            headerId: message.messageId
        })),
        skipDuplicates: true
    });
    return added.count;
}

/* -------------------------------------------------------------------------- */
/* Identities                                                                  */
/* -------------------------------------------------------------------------- */

export interface MailIdentityView {
    readonly id: string;
    readonly address: string;
    readonly displayName: string;
    readonly replyTo: string;
    readonly signature: string;
    readonly isDefault: boolean;
}

export async function listIdentities(
    userId: string,
    accountId: string
): Promise<MailIdentityView[]> {
    await ownedAccount(userId, accountId);
    return prisma.mailIdentity.findMany({
        where: { accountId },
        orderBy: [{ isDefault: "desc" }, { address: "asc" }],
        select: {
            id: true,
            address: true,
            displayName: true,
            replyTo: true,
            signature: true,
            isDefault: true
        }
    });
}

/**
 * Add or change a second address this mailbox may send from.
 *
 * Nothing here proves the address is one the server will let this account send
 * as - only the server can say that, and it says it by refusing the message. So
 * the first send from a new identity is the test, and its refusal is shown as
 * what it is rather than as a general failure.
 */
export async function saveIdentity(
    userId: string,
    accountId: string,
    identityId: string | null,
    identity: {
        address: string;
        displayName: string;
        replyTo: string;
        signature: string;
        isDefault: boolean;
    }
): Promise<string> {
    const owned = await ownedAccount(userId, accountId);

    /**
     * Not one this mailbox already has.
     *
     * There is a unique index behind this, and until now that index was the only
     * thing saying no: a repeat came back as a Prisma violation, which `failure`
     * has no case for, so the screen said "That address could not be saved" and
     * the person was left to guess which of the four fields was wrong. Its own
     * address counts - sending as it is what the mailbox does anyway, and an
     * identity for it is a second row that wins or loses by insertion order.
     *
     * Compared with `sameAddress` rather than by the index's exact match, so
     * `Ana@` is refused against `ana@` here instead of a hundred milliseconds
     * later in Postgres.
     */
    const clash =
        core.sameAddress(owned.address, identity.address) ||
        (
            await prisma.mailIdentity.findMany({
                where: { accountId, ...(identityId ? { id: { not: identityId } } : {}) },
                select: { address: true }
            })
        ).some((one) => core.sameAddress(one.address, identity.address));
    if (clash) {
        throw new MailSetupError("This mailbox can already send as that address.", "address");
    }

    let id = identityId;
    if (id) {
        // Narrowed by the account in the same statement rather than checked and
        // then updated. The account has just been proved to be this person's, so
        // an identity that is not on it is not theirs - and updating by the id
        // alone would let anybody who can guess one rewrite somebody else's
        // sending address, reply-to and signature.
        const changed = await prisma.mailIdentity.updateMany({
            where: { id, accountId },
            data: identity
        });
        // The same answer as an id that does not exist: telling the two apart
        // would say whether an id is a real one on somebody else's mailbox.
        if (changed.count === 0) throw new MailAccessError("That address is not on this mailbox.");
    } else {
        id = (
            await prisma.mailIdentity.create({
                data: { accountId, ...identity },
                select: { id: true }
            })
        ).id;
    }

    // One default, always. Set in the same transaction as the row that claimed
    // it, or two identities can both be the default and the composer picks
    // whichever the database happened to return first.
    if (identity.isDefault) {
        await prisma.mailIdentity.updateMany({
            where: { accountId, id: { not: id } },
            data: { isDefault: false }
        });
    }
    return id;
}

export async function deleteIdentity(
    userId: string,
    accountId: string,
    identityId: string
): Promise<void> {
    await ownedAccount(userId, accountId);
    await prisma.mailIdentity.deleteMany({ where: { id: identityId, accountId } });
}
