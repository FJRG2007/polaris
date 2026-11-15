"use server";

/**
 * Your computers (/account/computers): pairing, renaming and forgetting the
 * computers Polar Code sessions can run on. Each action is scoped to the
 * caller's own runners and needs the permission that starts sessions.
 */

import { z } from "zod";
import { requirePermission } from "@/lib/session";
import { formatUserCode, readUserCode } from "@/lib/device-code";
import { getTranslations } from "@/lib/i18n/request";
import * as computers from "@/lib/computers/computer-service";

const idSchema = z.string().uuid();

export async function listComputersAction(): Promise<computers.ComputerView[]> {
    const user = await requirePermission("agents.manage");
    return computers.listComputers(user.id);
}

export async function openPairingAction(): Promise<{ code: string; display: string; expiresAt: string } | { error: string }> {
    const user = await requirePermission("agents.manage");
    const opened = await computers.openPairing(user.id);
    if (!opened) return { error: (await getTranslations("account"))("computers.errors.pair") };
    return { code: opened.code, display: formatUserCode(opened.code), expiresAt: opened.expiresAt.toISOString() };
}

/** Whether the code is still waiting; false once a computer used it (or it expired). */
export async function pairingWaitingAction(code: unknown): Promise<boolean> {
    const user = await requirePermission("agents.manage");
    const parsed = typeof code === "string" ? readUserCode(code) : null;
    if (!parsed) return false;
    return computers.pairingWaiting(user.id, parsed);
}

export async function renameComputerAction(id: unknown, name: unknown): Promise<{ error?: string }> {
    const user = await requirePermission("agents.manage");
    const t = await getTranslations("account");
    const parsedId = idSchema.safeParse(id);
    const parsedName = computers.computerNameSchema.safeParse(typeof name === "string" ? name.replace(/\s+/g, " ") : name);
    if (!parsedId.success) return { error: t("computers.errors.gone") };
    if (!parsedName.success) return { error: t("computers.errors.name") };
    return (await computers.renameComputer(user.id, parsedId.data, parsedName.data)) ? {} : { error: t("computers.errors.gone") };
}

export async function revokeComputerAction(id: unknown): Promise<{ error?: string }> {
    const user = await requirePermission("agents.manage");
    const parsed = idSchema.safeParse(id);
    if (!parsed.success || !(await computers.revokeComputer(user.id, parsed.data)))
        return { error: (await getTranslations("account"))("computers.errors.gone") };
    return {};
}
