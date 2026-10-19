"use server";

/**
 * Adding, changing and driving a UPS. Platform admins only, the same gate as
 * the Servers app: every action asks for system.manage before it reads
 * anything. Reading a UPS is not here - a tab that keeps polling one does it
 * through `/api/servers/ups`, which a deploy cannot leave pointing at an action
 * id that no longer exists.
 */

import { z } from "zod";
import { listServerRows } from "../server-rows";
import { requirePermission } from "@/lib/session";
import { recordAudit } from "@/lib/audit-service";
import { hostSubject } from "@/lib/metrics-shared";
import * as upsService from "@/lib/ups/ups-service";
import * as upsReading from "@/lib/ups/ups-reading";

export type UpsActionResult<T = undefined> = { ok: true; value: T } | { ok: false; error: string };

const idSchema = z.string().uuid();
const commandSchema = z.enum(upsReading.UPS_COMMANDS);

function refused(error: unknown): { ok: false; error: string } {
    if (error instanceof z.ZodError) {
        const message = error.issues[0]?.message;
        return { ok: false, error: message && /^[a-zA-Z]+$/.test(message) ? message : "invalid" };
    }
    console.error("polaris: a UPS action failed:", error);
    return { ok: false, error: "failed" };
}

/** The machines this admin can name, as the metric subjects the UPS rows keep. */
async function knownMachines(userId: string): Promise<Set<string>> {
    return new Set((await listServerRows(userId)).map((row) => hostSubject(row.id)));
}

async function parseConnection(
    raw: unknown,
    userId: string
): Promise<upsReading.UpsConnectionInput> {
    const input = upsReading.upsConnectionSchema.parse(upsReading.normalizeUpsInput(raw));
    if (input.connection !== "nut" && !(await knownMachines(userId)).has(input.machineId)) {
        throw new z.ZodError([{ code: "custom", path: ["machineId"], message: "unknownMachine" }]);
    }
    return input;
}

export async function createUpsAction(raw: unknown): Promise<UpsActionResult<string>> {
    const user = await requirePermission("system.manage");
    try {
        const input = await parseConnection(raw, user.id);
        const id = await upsService.createUps(input);
        await recordAudit({
            actorId: user.id,
            action: "ups.create",
            targetType: "ups",
            targetId: id,
            metadata: { connection: input.connection, name: input.name }
        });
        return { ok: true, value: id };
    } catch (error) {
        return refused(error);
    }
}

export async function updateUpsConnectionAction(
    id: string,
    raw: unknown
): Promise<UpsActionResult> {
    const user = await requirePermission("system.manage");
    try {
        const upsId = idSchema.parse(id);
        const input = await parseConnection(raw, user.id);
        if (!(await upsService.updateUpsConnection(upsId, input)))
            return { ok: false, error: "notFound" };
        await recordAudit({
            actorId: user.id,
            action: "ups.update",
            targetType: "ups",
            targetId: upsId,
            metadata: { connection: input.connection }
        });
        return { ok: true, value: undefined };
    } catch (error) {
        return refused(error);
    }
}

export async function updateUpsShutdownAction(id: string, raw: unknown): Promise<UpsActionResult> {
    const user = await requirePermission("system.manage");
    try {
        const upsId = idSchema.parse(id);
        const input = upsReading.upsShutdownSchema.parse(raw);
        const known = await knownMachines(user.id);
        if (input.protectedMachineIds.some((machineId) => !known.has(machineId))) {
            return { ok: false, error: "unknownMachine" };
        }
        if (!(await upsService.updateUpsShutdown(upsId, input)))
            return { ok: false, error: "notFound" };
        await recordAudit({
            actorId: user.id,
            action: "ups.shutdown",
            targetType: "ups",
            targetId: upsId,
            metadata: {
                enabled: input.enabled,
                belowCharge: input.belowCharge,
                belowRuntimeMin: input.belowRuntimeMin,
                machines: input.protectedMachineIds.length
            }
        });
        return { ok: true, value: undefined };
    } catch (error) {
        return refused(error);
    }
}

export async function removeUpsAction(id: string): Promise<UpsActionResult> {
    const user = await requirePermission("system.manage");
    try {
        const upsId = idSchema.parse(id);
        if (!(await upsService.removeUps(upsId))) return { ok: false, error: "notFound" };
        await recordAudit({
            actorId: user.id,
            action: "ups.remove",
            targetType: "ups",
            targetId: upsId
        });
        return { ok: true, value: undefined };
    } catch (error) {
        return refused(error);
    }
}

export async function runUpsCommandAction(
    id: string,
    command: string
): Promise<UpsActionResult<upsService.UpsCommandResult>> {
    const user = await requirePermission("system.manage");
    try {
        const upsId = idSchema.parse(id);
        const parsed = commandSchema.parse(command);
        const row = await upsService.getUps(upsId);
        if (!row) return { ok: false, error: "notFound" };
        const outcome = await upsService.runUpsCommand(row, parsed);
        await recordAudit({
            actorId: user.id,
            action: "ups.command",
            targetType: "ups",
            targetId: upsId,
            metadata: { command: parsed, outcome }
        });
        return { ok: true, value: outcome };
    } catch (error) {
        return refused(error);
    }
}
