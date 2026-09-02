"use server";

/**
 * Sending a file or a folder to somebody, from the screen it is on.
 *
 * The thin half. Everything that decides anything - who may be offered, what a
 * move does to the sender's copy, what happens to a name already taken - lives
 * in the service, because none of it is a Drive screen's business and all of it
 * has to hold whoever is calling.
 *
 * What IS here is the one thing a server action must never skip: nothing that
 * arrives from a browser is trusted, so every field is parsed before it reaches
 * anything, and the identity comes from the session rather than the payload.
 */

import { z } from "zod";
import { requireUser } from "@/lib/session";
import { revalidatePath } from "next/cache";
import { findPeople } from "@/lib/people-search";
import { normalizeRelPath } from "@polaris/core";
import { recordAudit } from "@/lib/audit-service";
import * as transfers from "@/lib/drive-transfer-service";
import { listMyOrgs, orgCan, resolveOrgAccess } from "@/lib/orgs/org-service";

/** What a person is allowed to say. A note is a sentence beside the offer, not a
 *  place to put a document. */
const sendSchema = z.object({
    connectionId: z.string().uuid(),
    path: z.string().min(1).max(4096),
    mode: z.enum(["copy", "move"]),
    note: z.string().max(500).optional(),
    to: z
        .array(
            z.object({ userId: z.string().uuid().optional(), orgId: z.string().uuid().optional() })
        )
        .min(1)
        .max(25)
        // Exactly one of the two, per target. A payload naming both is not a
        // half-valid request to be interpreted - it is one to refuse.
        .refine(
            (targets) => targets.every((one) => Boolean(one.userId) !== Boolean(one.orgId)),
            "Each recipient is a person or an organization"
        )
});

/** The one sentence a caller is meant to read. Anything else is logged and
 *  replaced, because the rest name paths and storages nobody asked to publish. */
function refusal(caught: unknown): { error: string } {
    if (caught instanceof transfers.TransferRefused) return { error: caught.message };
    console.error(caught);
    return { error: "That could not be sent." };
}

/** Who this account may offer something to, for the dialog's search box. Two
 *  letters at least and nothing listed, exactly as sharing does - a send dialog
 *  is not a way around somebody having taken themselves out of being found. */
export async function findTransferPeopleAction(
    query: string
): Promise<{ results: { id: string; name: string; allowed: boolean }[]; withheld: number }> {
    const user = await requireUser();
    const found = await findPeople(user, String(query ?? ""), { reachableOnly: false });
    const allowed = await transfers.mayReceiveFrom(
        user.id,
        found.people.map((person) => person.id)
    );
    return {
        // Everybody found is shown, with those who take transfers marked. Hiding
        // the rest would answer "what is that person's setting" by omission, and
        // a name that is there but not offered says nothing about why.
        results: found.people.map((person) => ({ ...person, allowed: allowed.has(person.id) })),
        withheld: found.withheld
    };
}

/** The organizations this account could put something on the shelf of. */
export async function transferOrgsAction(): Promise<{ id: string; name: string }[]> {
    const user = await requireUser();
    const orgs = await listMyOrgs(user.id);
    // Resolved one at a time rather than read off the summary, because the
    // summary carries the role's NAME and a name decides nothing here. Putting
    // something on a company's shelf is the same permission as changing anything
    // else on it, and that is a question only the access resolver answers.
    const answers = await Promise.all(
        orgs.map(async (org) => {
            const access = await resolveOrgAccess({ id: user.id, isAdmin: false }, org.id);
            return orgCan(access, "drive.manage") ? { id: org.id, name: org.name } : null;
        })
    );
    return answers.filter((org) => org !== null);
}

export async function sendTransferAction(
    input: z.input<typeof sendSchema>
): Promise<{ sent?: number; error?: string }> {
    const user = await requireUser();
    const parsed = sendSchema.safeParse(input);
    if (!parsed.success) return { error: "That is not something Polaris can send." };
    try {
        const made = await transfers.sendTransfer({
            senderId: user.id,
            connectionId: parsed.data.connectionId,
            path: normalizeRelPath(parsed.data.path),
            mode: parsed.data.mode,
            note: parsed.data.note ?? null,
            to: parsed.data.to
        });
        await recordAudit({
            actorId: user.id,
            action: "drive.transfer.send",
            targetType: "connection",
            targetId: parsed.data.connectionId,
            metadata: { path: parsed.data.path, mode: parsed.data.mode, count: String(made.length) }
        });
        revalidatePath("/drive");
        return { sent: made.length };
    } catch (caught) {
        return refusal(caught);
    }
}

export async function waitingTransfersAction(): Promise<transfers.TransferView[]> {
    const user = await requireUser();
    return transfers.transfersWaitingFor(user.id);
}

export async function sentTransfersAction(): Promise<transfers.TransferView[]> {
    const user = await requireUser();
    return transfers.transfersSentBy(user.id);
}

/** Which offer, and where in the recipient's own Drive it is to land. The folder
 *  is parsed like every other field rather than coerced with `String`: it is a
 *  path the browser chose, and the service is not the place to find out it was
 *  a number or a megabyte of text. */
const acceptSchema = z.object({
    transferId: z.string().uuid(),
    into: z.string().max(4096).optional()
});

export async function acceptTransferAction(
    transferId: string,
    into?: string
): Promise<{ path?: string; error?: string }> {
    const user = await requireUser();
    const parsed = acceptSchema.safeParse({ transferId, into });
    if (!parsed.success) return { error: "That is not an offer." };
    try {
        const landed = await transfers.acceptTransfer(
            parsed.data.transferId,
            user.id,
            parsed.data.into ?? ""
        );
        revalidatePath("/drive");
        return { path: landed.path };
    } catch (caught) {
        return refusal(caught);
    }
}

export async function declineTransferAction(transferId: string): Promise<{ error?: string }> {
    const user = await requireUser();
    if (!z.string().uuid().safeParse(transferId).success) return { error: "That is not an offer." };
    try {
        await transfers.declineTransfer(transferId, user.id);
        revalidatePath("/drive");
        return {};
    } catch (caught) {
        return refusal(caught);
    }
}

export async function cancelTransferAction(transferId: string): Promise<{ error?: string }> {
    const user = await requireUser();
    if (!z.string().uuid().safeParse(transferId).success) return { error: "That is not an offer." };
    try {
        await transfers.cancelTransfer(transferId, user.id);
        revalidatePath("/drive");
        return {};
    } catch (caught) {
        return refusal(caught);
    }
}

/** Put down the sentence saying a transfer went wrong, once its sender has read
 *  it. Only the notice goes; what happened already happened. */
export async function dismissTransferNoticeAction(transferId: string): Promise<{ error?: string }> {
    const user = await requireUser();
    if (!z.string().uuid().safeParse(transferId).success) return { error: "That is not an offer." };
    try {
        await transfers.dismissTransferNotice(transferId, user.id);
        revalidatePath("/drive");
        return {};
    } catch (caught) {
        return refusal(caught);
    }
}
