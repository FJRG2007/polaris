"use server";

/**
 * Quick send: the server half of making, listing and taking back a disposable
 * transfer. Every field is parsed here, and the identity comes from the session,
 * never from the payload. The bytes themselves arrive through their own streamed
 * route, not through an action.
 */

import { z } from "zod";
import { revalidatePath } from "next/cache";
import { requirePermission } from "@/lib/session";
import { getTranslations } from "@/lib/i18n/request";
import * as disposable from "@/lib/disposable-transfer-service";

const createSchema = z.object({
    expiry: z.enum(Object.keys(disposable.EXPIRY_CHOICES) as [disposable.ExpiryChoice]),
    maxDownloads: z
        .number()
        .int()
        .refine((value) => (disposable.DOWNLOAD_CHOICES as readonly number[]).includes(value)),
    note: z.string().trim().max(500).optional()
});

const finishSchema = z.object({
    id: z.string().uuid(),
    recipients: z.array(z.string().uuid()).max(disposable.MAX_RECIPIENTS)
});

type Result<T> = ({ ok: true } & T) | { ok: false; error: string };

async function refused(caught: unknown): Promise<{ ok: false; error: string }> {
    const t = await getTranslations("drive");
    if (caught instanceof disposable.TransferRefused) return { ok: false, error: t(caught.key) };
    console.error(caught);
    return { ok: false, error: t("disposable.errors.generic") };
}

async function invalid(): Promise<{ ok: false; error: string }> {
    return { ok: false, error: (await getTranslations("drive"))("disposable.errors.invalid") };
}

export async function createQuickSendAction(input: unknown): Promise<Result<{ id: string }>> {
    const user = await requirePermission("drive.write");
    const parsed = createSchema.safeParse(input);
    if (!parsed.success) return invalid();
    try {
        const { id } = await disposable.createTransfer(user.id, parsed.data);
        return { ok: true, id };
    } catch (caught) {
        return refused(caught);
    }
}

export async function finishQuickSendAction(
    input: unknown
): Promise<Result<{ url: string; notified: number; refused: number }>> {
    const user = await requirePermission("drive.write");
    const parsed = finishSchema.safeParse(input);
    if (!parsed.success) return invalid();
    try {
        const done = await disposable.finishTransfer(
            user.id,
            parsed.data.id,
            parsed.data.recipients,
            user.name || user.email
        );
        revalidatePath("/drive/quick-send");
        return { ok: true, ...done };
    } catch (caught) {
        return refused(caught);
    }
}

/** Abandon a transfer while it is being made, or take back a live one. */
export async function revokeQuickSendAction(id: unknown): Promise<{ ok: boolean }> {
    const user = await requirePermission("drive.write");
    const parsed = z.string().uuid().safeParse(id);
    if (!parsed.success) return { ok: false };
    await disposable.revokeTransfer(user.id, parsed.data);
    revalidatePath("/drive/quick-send");
    return { ok: true };
}

export async function listQuickSendsAction(): Promise<disposable.TransferView[]> {
    const user = await requirePermission("drive.read");
    return disposable.listTransfers(user.id);
}
