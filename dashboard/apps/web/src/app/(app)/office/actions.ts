"use server";

/**
 * What the Office screens ask the server to do.
 *
 * Thin on purpose: every one of these resolves the caller, hands the work to
 * `lib/office/documents.ts` and turns a refusal into a sentence. The rules live
 * there, in the one module that answers "may they", so a second screen cannot
 * arrive with a second opinion.
 *
 * A refusal the reader can act on is passed through; anything else is logged and
 * replaced, which is the rule the rest of Polaris follows - an internal message
 * names paths nobody asked to publish.
 */

import * as core from "@polaris/core";
import { revalidatePath } from "next/cache";
import * as office from "@/lib/office/documents";
import { recordAudit } from "@/lib/audit-service";
import { requirePermission } from "@/lib/session";
import { scopeOrgIdFor } from "@/lib/workspace-scope";
import { listAdministeredOrgs } from "@/lib/orgs/org-service";

const PATH = "/office";

async function actor(): Promise<{ id: string; name: string }> {
    const user = await requirePermission("office.use");
    return { id: user.id, name: user.name };
}

function refusal(caught: unknown, fallback: string): { error: string } {
    if (caught instanceof office.OfficeAccessError) return { error: caught.message };
    console.error("[office] action failed", caught);
    return { error: fallback };
}

/**
 * Which owner a new document may be made for, and which one to start on.
 *
 * The shelf that is open decides the second, for the reason the space picker
 * learned: somebody working from a client's shelf who presses "new" means one
 * for that client, and defaulting to their own is how a company's work ends up
 * where nobody else can find it.
 */
export async function ownerOptionsAction(): Promise<{
    orgs?: { id: string; name: string }[];
    me?: { id: string; name: string };
    scopeOrgId?: string | null;
    error?: string;
}> {
    try {
        const user = await actor();
        const [orgs, shelf] = await Promise.all([
            listAdministeredOrgs({ id: user.id, isAdmin: false }),
            scopeOrgIdFor(user.id)
        ]);
        return {
            orgs,
            me: { id: user.id, name: user.name },
            // Only one they may actually create for. A shelf they merely belong
            // to is not an answer the picker can start on.
            scopeOrgId: orgs.some((org) => org.id === shelf) ? shelf : null
        };
    } catch (caught) {
        return refusal(caught, "Could not read your organizations");
    }
}

export async function createDocumentAction(
    input: unknown
): Promise<{ id?: string; kind?: core.OfficeKind; error?: string }> {
    try {
        const user = await actor();
        const parsed = core.officeCreateSchema.safeParse(input);
        if (!parsed.success) {
            return { error: parsed.error.issues[0]?.message ?? "That could not be created" };
        }
        const id = await office.createDocument({ id: user.id }, parsed.data);
        await recordAudit({
            actorId: user.id,
            action: "office.create",
            targetType: "officeDocument",
            targetId: id,
            metadata: { kind: parsed.data.kind, orgId: parsed.data.orgId }
        });
        revalidatePath(PATH);
        return { id, kind: parsed.data.kind };
    } catch (caught) {
        return refusal(caught, "That could not be created");
    }
}

export async function renameDocumentAction(
    documentId: string,
    title: string
): Promise<{ title?: string; error?: string }> {
    try {
        const user = await actor();
        const named = await office.renameDocument({ id: user.id }, String(documentId), String(title));
        revalidatePath(PATH);
        return { title: named };
    } catch (caught) {
        return refusal(caught, "That could not be renamed");
    }
}

export async function starDocumentAction(
    documentId: string,
    starred: boolean
): Promise<{ error?: string }> {
    try {
        const user = await actor();
        await office.starDocument({ id: user.id }, String(documentId), Boolean(starred));
        revalidatePath(PATH);
        return {};
    } catch (caught) {
        return refusal(caught, "That could not be starred");
    }
}

export async function archiveDocumentAction(
    documentId: string,
    archived: boolean
): Promise<{ error?: string }> {
    try {
        const user = await actor();
        await office.archiveDocument({ id: user.id }, String(documentId), Boolean(archived));
        revalidatePath(PATH);
        return {};
    } catch (caught) {
        return refusal(caught, "That could not be filed");
    }
}

/** Into the bin, or back out of it. Never the deletion itself: that is its own
 *  action, from the bin, where somebody can see what they are emptying. */
export async function trashDocumentAction(
    documentId: string,
    trashed: boolean
): Promise<{ error?: string }> {
    try {
        const user = await actor();
        await office.trashDocument({ id: user.id }, String(documentId), Boolean(trashed));
        await recordAudit({
            actorId: user.id,
            action: trashed ? "office.trash" : "office.restore",
            targetType: "officeDocument",
            targetId: String(documentId)
        });
        revalidatePath(PATH);
        return {};
    } catch (caught) {
        return refusal(caught, "That could not be moved");
    }
}

export async function deleteDocumentAction(documentId: string): Promise<{ error?: string }> {
    try {
        const user = await actor();
        await office.deleteDocument({ id: user.id }, String(documentId));
        await recordAudit({
            actorId: user.id,
            action: "office.delete",
            targetType: "officeDocument",
            targetId: String(documentId)
        });
        revalidatePath(PATH);
        return {};
    } catch (caught) {
        return refusal(caught, "That could not be deleted");
    }
}

/**
 * Write the document itself.
 *
 * The bytes are a Yjs update, which is what makes several people editing one
 * document possible at all - see `lib/office/content.ts`. They arrive as a plain
 * array because a server action's payload is JSON, and are put back into bytes
 * here rather than anywhere the editor can see.
 *
 * Debounced by the editor rather than here: this is the write, and a write that
 * decided for itself when to happen would fight the one place that knows whether
 * somebody has stopped typing.
 */
export async function saveDocumentAction(
    documentId: string,
    update: number[]
): Promise<{ error?: string }> {
    try {
        const user = await actor();
        const bytes = Uint8Array.from(update);
        const { openDocument, excerptOf } = await import("@/lib/office/content");
        // The excerpt is worked out from the document that was just handed over,
        // rather than asked of the editor: a client that lies about its own
        // contents should not get to write the line the search reads.
        const excerpt = excerptOf(openDocument(bytes));
        await office.saveContent({ id: user.id }, String(documentId), bytes, excerpt);
        return {};
    } catch (caught) {
        return refusal(caught, "That could not be saved");
    }
}

/** The list, fetched by the browser rather than rendered into the page - the
 *  same arrangement Mail settled on, and for the same reason. */
export async function listDocumentsAction(
    query: unknown
): Promise<{ documents?: office.OfficeDocumentView[]; error?: string }> {
    try {
        const user = await actor();
        const asked = (query ?? {}) as Partial<office.OfficeListQuery>;
        const documents = await office.listDocuments({ id: user.id }, await scopeOrgIdFor(user.id), {
            ...office.EMPTY_LIST_QUERY,
            ...asked,
            kind: core.readOfficeKindFilter(asked.kind),
            sort: core.readOfficeSort(asked.sort)
        });
        return { documents };
    } catch (caught) {
        return refusal(caught, "That list could not be loaded");
    }
}
