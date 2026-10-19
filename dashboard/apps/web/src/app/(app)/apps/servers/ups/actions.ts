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
import { wordsFor } from "@/lib/notifications/notice-words";
import * as upsData from "@/lib/ups/ups-data";
import * as upsService from "@/lib/ups/ups-service";
import * as upsReading from "@/lib/ups/ups-reading";
import * as upsSettings from "@/lib/ups/ups-settings";

export type UpsActionResult<T = undefined> = { ok: true; value: T } | { ok: false; error: string };

const idSchema = z.string().uuid();
const commandSchema = upsSettings.nutName;

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
        await upsData.logAction({ upsId, actorId: user.id, kind: "command", name: parsed, outcome });
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

export async function updateUpsSettingsAction(id: string, raw: unknown): Promise<UpsActionResult> {
    const user = await requirePermission("system.manage");
    try {
        const upsId = idSchema.parse(id);
        const input = upsSettings.upsSettingsSchema.parse(upsSettings.normalizeUpsSettings(raw));
        const row = await upsService.getUps(upsId);
        if (!row) return { ok: false, error: "notFound" };
        if (input.netserverEnabled && !upsService.canOfferNetwork(row)) return { ok: false, error: "networkUnavailable" };
        await upsService.updateUpsSettings(upsId, input);
        await recordAudit({
            actorId: user.id,
            action: "ups.settings",
            targetType: "ups",
            targetId: upsId,
            metadata: {
                currency: input.currency,
                retentionDays: input.retentionDays,
                reportSchedule: input.reportSchedule,
                netserverEnabled: input.netserverEnabled
            }
        });
        return { ok: true, value: undefined };
    } catch (error) {
        return refused(error);
    }
}

export async function updateUpsVariableMapAction(id: string, raw: unknown): Promise<UpsActionResult> {
    const user = await requirePermission("system.manage");
    try {
        const upsId = idSchema.parse(id);
        const map = upsSettings.variableMapSchema.parse(raw);
        if (!(await upsService.updateUpsVariableMap(upsId, map))) return { ok: false, error: "notFound" };
        await recordAudit({
            actorId: user.id,
            action: "ups.mapping",
            targetType: "ups",
            targetId: upsId,
            metadata: { mapped: Object.keys(map).length }
        });
        return { ok: true, value: undefined };
    } catch (error) {
        return refused(error);
    }
}

const acknowledgeSchema = z.union([z.literal("all"), z.array(z.string().uuid()).min(1).max(200)]);

export async function acknowledgeUpsEventsAction(id: string, ids: unknown): Promise<UpsActionResult<number>> {
    const user = await requirePermission("system.manage");
    try {
        const upsId = idSchema.parse(id);
        const which = acknowledgeSchema.parse(ids);
        return { ok: true, value: await upsData.acknowledgeEvents(upsId, which, user.id) };
    } catch (error) {
        return refused(error);
    }
}

export async function setUpsVarAction(
    id: string,
    raw: unknown
): Promise<UpsActionResult<{ outcome: upsService.UpsSetResult; error?: string }>> {
    const user = await requirePermission("system.manage");
    try {
        const upsId = idSchema.parse(id);
        const input = upsSettings.setVarSchema.parse(raw);
        const row = await upsService.getUps(upsId);
        if (!row) return { ok: false, error: "notFound" };
        const result = await upsService.setUpsVar(row, input.name, input.value);
        await upsData.logAction({
            upsId,
            actorId: user.id,
            kind: "variable",
            name: input.name,
            value: input.value,
            outcome: result.outcome
        });
        await recordAudit({
            actorId: user.id,
            action: "ups.variable",
            targetType: "ups",
            targetId: upsId,
            metadata: { name: input.name, outcome: result.outcome }
        });
        return { ok: true, value: result };
    } catch (error) {
        return refused(error);
    }
}

/** The login another machine's upsmon types, for a UPS offered to the network. */
export async function upsNetworkLoginAction(
    id: string
): Promise<UpsActionResult<{ user: string; password: string; port: number; upsName: string }>> {
    const user = await requirePermission("system.manage");
    try {
        const upsId = idSchema.parse(id);
        const row = await upsService.getUps(upsId);
        if (!row) return { ok: false, error: "notFound" };
        if (!row.netserverEnabled || !upsService.canOfferNetwork(row)) return { ok: false, error: "networkUnavailable" };
        const upsName = upsService.daemonUpsName(row);
        if (!upsName) return { ok: false, error: "networkUnavailable" };
        await recordAudit({ actorId: user.id, action: "ups.networkLogin", targetType: "ups", targetId: upsId });
        return { ok: true, value: { ...upsService.netserverLogin(), upsName } };
    } catch (error) {
        return refused(error);
    }
}

const exportSchema = z.object({ what: z.enum(upsSettings.EXPORT_KINDS), days: z.number().int().min(1).max(365) });

/** One UPS's records as CSV, written into this admin's own drive. */
export async function saveUpsExportAction(id: string, raw: unknown): Promise<UpsActionResult<string>> {
    const user = await requirePermission("system.manage");
    try {
        const upsId = idSchema.parse(id);
        const input = exportSchema.parse(raw);
        const row = await upsService.getUps(upsId);
        if (!row) return { ok: false, error: "notFound" };
        const csv = await upsData.exportCsv(upsId, input.what, input.days);
        const name = `${upsData.fileStem(row.name)}-${input.what}-${new Date().toISOString().slice(0, 10)}.csv`;
        return { ok: true, value: await upsData.saveToDrive(user.id, name, csv) };
    } catch (error) {
        return refused(error);
    }
}

/** The last full period's report, made now into this admin's own drive. */
export async function makeUpsReportAction(id: string): Promise<UpsActionResult<string>> {
    const user = await requirePermission("system.manage");
    try {
        const upsId = idSchema.parse(id);
        const row = await upsService.getUps(upsId);
        if (!row) return { ok: false, error: "notFound" };
        const schedule = row.reportSchedule === "off" ? "daily" : (row.reportSchedule as "daily" | "weekly" | "monthly");
        const period = upsSettings.previousPeriod(schedule, Date.now());
        const words = await wordsFor(user.id, "notices");
        const content = await upsData.buildReport(row, period, (key, values) => words(`ups.${key}` as const, values));
        const name = `${upsData.fileStem(row.name)}-${schedule}-${period.from.toISOString().slice(0, 10)}.md`;
        return { ok: true, value: await upsData.saveToDrive(user.id, name, content) };
    } catch (error) {
        return refused(error);
    }
}

