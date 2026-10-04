"use server";

/**
 * Office and Google Drive, as the screens ask for it: which accounts can be
 * used, what is in one, bringing a file in, and saving a document back.
 *
 * Every input is parsed here; the account is always looked up under the caller,
 * so an id from somebody else's list opens nothing. The rules about what may be
 * read or written live in `lib/office/google.ts` and `lib/office/documents.ts`.
 */

import { z } from "zod";
import * as core from "@polaris/core";
import { revalidatePath } from "next/cache";
import { recordAudit } from "@/lib/audit-service";
import { requirePermission } from "@/lib/session";
import { getTranslations } from "@/lib/i18n/request";
import { OfficeImportError } from "@/lib/office/import";
import { OfficeAccessError } from "@/lib/office/documents";
import {
    googleLinkOf,
    importGoogleFile,
    listGoogleOfficeFiles,
    officeGoogleState,
    OfficeGoogleError,
    saveToGoogle,
    type GoogleOfficeFile,
    type OfficeGoogleAccount,
    type OfficeGoogleLink
} from "@/lib/office/google";

const listSchema = z.object({
    connectionId: z.string().uuid(),
    search: z.string().trim().max(100).default(""),
    pageToken: z.string().max(2000).nullable().default(null)
});

const importSchema = z.object({
    connectionId: z.string().uuid(),
    fileId: z.string().trim().min(1).max(200).regex(/^[\w-]+$/),
    orgId: core.officeCreateSchema.shape.orgId
});

const documentIdSchema = z.string().uuid();

/** A refusal in the reader's words. Anything that is not one is logged and
 *  replaced: Google's own answers name things nobody asked to publish. */
async function refusal(caught: unknown): Promise<{ error: string; relink?: boolean }> {
    const t = await getTranslations("office");
    if (caught instanceof OfficeGoogleError) {
        return {
            error: t(`google.errors.${caught.reason}`),
            ...(caught.reason === "relink" ? { relink: true } : {})
        };
    }
    if (caught instanceof OfficeImportError || caught instanceof OfficeAccessError) {
        return { error: caught.message };
    }
    console.error("[office] google action failed", caught);
    return { error: t("google.errors.failed") };
}

export async function officeGoogleStateAction(): Promise<{
    available?: boolean;
    accounts?: OfficeGoogleAccount[];
    error?: string;
}> {
    try {
        const user = await requirePermission("office.use");
        return await officeGoogleState(user.id);
    } catch (caught) {
        return refusal(caught);
    }
}

export async function listGoogleFilesAction(input: unknown): Promise<{
    files?: GoogleOfficeFile[];
    next?: string | null;
    error?: string;
    relink?: boolean;
}> {
    const parsed = listSchema.safeParse(input);
    if (!parsed.success) return refusal(new OfficeGoogleError("no-account"));
    try {
        const user = await requirePermission("office.use");
        return await listGoogleOfficeFiles(
            user.id,
            parsed.data.connectionId,
            parsed.data.search,
            parsed.data.pageToken
        );
    } catch (caught) {
        return refusal(caught);
    }
}

export async function importGoogleFileAction(input: unknown): Promise<{
    id?: string;
    kind?: core.OfficeKind;
    error?: string;
    relink?: boolean;
}> {
    const parsed = importSchema.safeParse(input);
    if (!parsed.success) return refusal(new OfficeGoogleError("not-found"));
    try {
        const user = await requirePermission("office.use");
        const made = await importGoogleFile(
            { id: user.id },
            parsed.data.connectionId,
            parsed.data.fileId,
            parsed.data.orgId ?? null
        );
        await recordAudit({
            actorId: user.id,
            action: "office.import",
            targetType: "officeDocument",
            targetId: made.id,
            metadata: { kind: made.kind, source: "google" }
        });
        revalidatePath("/office");
        return { id: made.id, kind: made.kind };
    } catch (caught) {
        return refusal(caught);
    }
}

export async function officeGoogleLinkAction(
    documentId: unknown
): Promise<{ link?: OfficeGoogleLink | null; error?: string }> {
    const parsed = documentIdSchema.safeParse(documentId);
    if (!parsed.success) return { link: null };
    try {
        const user = await requirePermission("office.use");
        return { link: await googleLinkOf(user.id, parsed.data) };
    } catch (caught) {
        return refusal(caught);
    }
}

export async function saveToGoogleAction(
    documentId: unknown
): Promise<{ link?: string; error?: string; relink?: boolean }> {
    const parsed = documentIdSchema.safeParse(documentId);
    if (!parsed.success) return refusal(new OfficeGoogleError("not-found"));
    try {
        const user = await requirePermission("office.use");
        const saved = await saveToGoogle({ id: user.id }, parsed.data);
        await recordAudit({
            actorId: user.id,
            action: "office.export",
            targetType: "officeDocument",
            targetId: parsed.data,
            metadata: { destination: "google" }
        });
        return saved;
    } catch (caught) {
        return refusal(caught);
    }
}
