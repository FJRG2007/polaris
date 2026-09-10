/**
 * Message templates: what somebody writes often enough to keep.
 *
 * A signature is one of these with a fixed place to go. A template is the same
 * idea with a name and no limit on how many: the reply to the question
 * everybody asks, the note that goes with an invoice. The composer lists them
 * and puts the chosen one where the cursor is.
 *
 * Everything is narrowed by the person inside the query. A template tied to a
 * mailbox is checked against the person's own mailboxes when it is saved, so a
 * guessed mailbox id cannot be used to hang a template on somebody else's
 * account.
 */

import { prisma } from "@polaris/db";
import type * as core from "@polaris/core";
import { MailAccessError, ownedAccount } from "./access";

export interface MailTemplateView {
    readonly id: string;
    readonly name: string;
    readonly subject: string;
    readonly body: string;
    /** The one mailbox it is offered for, or null for every one. */
    readonly accountId: string | null;
}

/** Raised when a name is already taken: two templates with the same name are
 *  two entries nobody can tell apart in a menu. */
export class MailTemplateNameTaken extends Error {
    public constructor(name: string) {
        super(`You already have a template called ${name}.`);
        this.name = "MailTemplateNameTaken";
    }
}

/** Every template this person has, by name. */
export async function listTemplates(userId: string): Promise<MailTemplateView[]> {
    return prisma.mailTemplate.findMany({
        where: { userId },
        orderBy: { name: "asc" },
        select: { id: true, name: true, subject: true, body: true, accountId: true }
    });
}

/**
 * Make one, or change one.
 *
 * A template aimed at a mailbox has to be aimed at one of this person's own;
 * `ownedAccount` refuses anything else with the same answer as a mailbox that
 * does not exist.
 */
export async function saveTemplate(
    userId: string,
    templateId: string | null,
    input: core.MailTemplateInput
): Promise<string> {
    if (input.accountId) await ownedAccount(userId, input.accountId);
    const clash = await prisma.mailTemplate.findFirst({
        where: { userId, name: input.name, ...(templateId ? { id: { not: templateId } } : {}) },
        select: { id: true }
    });
    if (clash) throw new MailTemplateNameTaken(input.name);

    const data = {
        name: input.name,
        subject: input.subject,
        body: input.body,
        accountId: input.accountId
    };
    if (!templateId) {
        const created = await prisma.mailTemplate.create({
            data: { userId, ...data },
            select: { id: true }
        });
        return created.id;
    }
    const { count } = await prisma.mailTemplate.updateMany({
        where: { id: templateId, userId },
        data
    });
    if (count === 0) throw new MailAccessError("That template is not yours.");
    return templateId;
}

/** Throw one away. Somebody else's is not found, which is the same answer. */
export async function deleteTemplate(userId: string, templateId: string): Promise<void> {
    await prisma.mailTemplate.deleteMany({ where: { id: templateId, userId } });
}
