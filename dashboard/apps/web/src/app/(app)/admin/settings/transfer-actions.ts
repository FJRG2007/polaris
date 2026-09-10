"use server";

/**
 * Moving this Polaris to another machine: writing the export, and reading one
 * back on a fresh install. Admin-only - an export is every account, every secret
 * and every setting on the instance, sealed only by the passphrase.
 */

import { z } from "zod";
import { stat } from "node:fs/promises";
import { requireAdmin } from "@/lib/session";
import { passwordIsBreached } from "@/lib/pwned-passwords";
import {
    BREACHED_PASSWORD_MESSAGE,
    IDENTITY_PASSWORD_MESSAGE,
    passwordMatchesIdentity
} from "@polaris/core";
import { recordAudit } from "@/lib/audit-service";
import * as transfer from "@/lib/instance-transfer/transfer";
import { dropTransferFile, newTransferFile, transferPath } from "@/lib/instance-transfer/files";

const passphraseSchema = z
    .string()
    .min(12, "Use at least 12 characters")
    .max(1024, "That passphrase is longer than it needs to be");
const idSchema = z.string().uuid("That upload has expired. Upload the file again.");

type Result<T> = { error: string } | ({ error?: undefined } & T);

function failed(error: unknown): { error: string } {
    if (error instanceof transfer.TransferError) return { error: error.message };
    console.error("polaris: instance transfer failed:", error);
    return { error: "That did not work. Nothing was changed." };
}

/** Write the export; the browser downloads it by the id this answers with. */
export async function exportInstanceAction(
    passphrase: string
): Promise<Result<{ id: string; summary: transfer.TransferSummary }>> {
    const user = await requireAdmin();
    const parsed = passphraseSchema.safeParse(passphrase);
    if (!parsed.success) return { error: parsed.error.issues[0]?.message ?? "Choose a passphrase" };
    // Asked again here: the screen's answer is advice the server does not take on trust.
    if (passwordMatchesIdentity(parsed.data, ["polaris", user.email, user.name]))
        return { error: IDENTITY_PASSWORD_MESSAGE };
    if (await passwordIsBreached(parsed.data)) return { error: BREACHED_PASSWORD_MESSAGE };
    const file = await newTransferFile();
    try {
        const summary = await transfer.exportInstance(parsed.data, file.path);
        await recordAudit({ actorId: user.id, action: "instance.export" });
        return { id: file.id, summary };
    } catch (error) {
        await dropTransferFile(file.id);
        return failed(error);
    }
}

async function uploaded(id: string): Promise<string> {
    const parsed = idSchema.safeParse(id);
    const path = parsed.success ? transferPath(parsed.data) : null;
    if (!path || !(await stat(path).catch(() => null))) {
        throw new transfer.TransferError("That upload has expired. Upload the file again.");
    }
    return path;
}

/** Read an uploaded export through without writing anything, and say what it holds. */
export async function previewImportAction(
    id: string,
    passphrase: string
): Promise<Result<{ summary: transfer.TransferSummary; refused: string | null }>> {
    await requireAdmin();
    const parsed = passphraseSchema.safeParse(passphrase);
    if (!parsed.success) return { error: "The passphrase is wrong, or the file has been changed" };
    try {
        const path = await uploaded(id);
        const [summary, refused] = await Promise.all([
            transfer.previewTransfer(path, parsed.data),
            transfer.notFreshReason()
        ]);
        return { summary, refused };
    } catch (error) {
        return failed(error);
    }
}

/**
 * Replace everything here with the export. The account asking is replaced too, so
 * the caller signs in again afterwards with an account from the file.
 */
export async function applyImportAction(
    id: string,
    passphrase: string,
    confirm: string
): Promise<Result<{ summary: transfer.TransferSummary }>> {
    await requireAdmin();
    if (confirm !== "replace") return { error: "Confirm that everything here is replaced" };
    const parsed = passphraseSchema.safeParse(passphrase);
    if (!parsed.success) return { error: "The passphrase is wrong, or the file has been changed" };
    try {
        const path = await uploaded(id);
        const summary = await transfer.applyTransfer(path, parsed.data);
        await dropTransferFile(id);
        // Nobody signed in here any more: the import replaced every account.
        await recordAudit({
            actorId: null,
            action: "instance.imported",
            metadata: {
                exportedAt: summary.exportedAt,
                unreadableSecrets: summary.unreadableSecrets
            }
        }).catch(() => undefined);
        return { summary };
    } catch (error) {
        return failed(error);
    }
}
