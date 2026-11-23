"use server";

/**
 * Your terminals (/account/terminals): listing, renaming and signing out the
 * Polaris Terminals this account signed in, and opening one - or one shared
 * with it - through the relay. Each action needs `terminal.control`, the same
 * permission the relay asks of a controller.
 */

import { z } from "zod";
import { requirePermission } from "@/lib/session";
import { recordAudit } from "@/lib/audit-service";
import { getTranslations } from "@/lib/i18n/request";
import { newDeviceRefusal } from "@/lib/device-grace";
import * as terminals from "@/lib/terminal/instances";
import { localized } from "../security/action-messages";
import { mintViewerTicket } from "@/lib/terminal/relay";

const PERMISSION = "terminal.control";
const idSchema = z.string().uuid();

export async function listTerminalsAction(): Promise<Awaited<ReturnType<typeof terminals.listTerminals>>> {
    const user = await requirePermission(PERMISSION);
    return terminals.listTerminals(user.id);
}

export async function renameTerminalAction(id: unknown, name: unknown): Promise<{ error?: string }> {
    const user = await requirePermission(PERMISSION);
    const t = await getTranslations("account");
    const parsedId = idSchema.safeParse(id);
    const parsedName = terminals.terminalLabelSchema.safeParse(typeof name === "string" ? name.replace(/\s+/g, " ") : name);
    if (!parsedId.success) return { error: t("terminals.errors.gone") };
    if (!parsedName.success) return { error: t("terminals.errors.name") };
    return (await terminals.renameTerminal(user.id, parsedId.data, parsedName.data))
        ? {}
        : { error: t("terminals.errors.gone") };
}

export async function revokeTerminalAction(id: unknown): Promise<{ error?: string }> {
    const user = await requirePermission(PERMISSION);
    const blocked = await newDeviceRefusal(user);
    if (blocked) return localized({ error: blocked });
    const parsed = idSchema.safeParse(id);
    if (!parsed.success || !(await terminals.revokeTerminal(user.id, parsed.data)))
        return { error: (await getTranslations("account"))("terminals.errors.gone") };
    await recordAudit({ actorId: user.id, action: "account.terminal.revoked", targetType: "terminalInstance", targetId: parsed.data });
    return {};
}

/**
 * A one-shot ticket for the viewer to reach this terminal through the relay,
 * and what the caller may do there. The relay checks the same again on every
 * frame; this only spares a socket that would be turned away.
 */
export async function openTerminalAction(
    id: unknown
): Promise<{ ticket: string; access: terminals.TerminalView["access"] } | { error: string }> {
    const user = await requirePermission(PERMISSION);
    const t = await getTranslations("account");
    const parsed = idSchema.safeParse(id);
    const terminal = parsed.success ? await terminals.terminalFor(user.id, parsed.data) : null;
    if (!terminal) return { error: t("terminals.errors.gone") };
    if (!terminal.online) return { error: t("terminals.errors.offline") };
    return { ticket: await mintViewerTicket(user.id, terminal.id), access: terminal.access };
}
