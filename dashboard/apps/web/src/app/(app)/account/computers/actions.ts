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
import { lanHostsSchema } from "@/lib/computers/lan-hosts";
import { sendToRunner } from "@/lib/computers/computer-commands";

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

/** The private addresses this computer may look for model servers on. Only
 *  for an online computer of the caller's that has local models; the runner
 *  keeps the list and checks every address again. */
export async function setLanHostsAction(id: unknown, hosts: unknown): Promise<{ error?: string }> {
    const user = await requirePermission("agents.manage");
    const t = await getTranslations("account");
    const parsedId = idSchema.safeParse(id);
    const parsedHosts = lanHostsSchema.safeParse(hosts);
    if (!parsedId.success) return { error: t("computers.errors.gone") };
    if (!parsedHosts.success) return { error: t("computers.local.invalid") };
    const computer = (await computers.listComputers(user.id)).find((one) => one.id === parsedId.data);
    if (!computer) return { error: t("computers.errors.gone") };
    if (!computer.online || !computer.localModels) return { error: t("computers.local.offline") };
    const sent = await sendToRunner(computer.id, { type: "local.config", lanHosts: parsedHosts.data });
    return sent ? {} : { error: t("computers.local.offline") };
}
