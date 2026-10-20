"use server";

/**
 * What the NAS page changes: its fan profile and running a backup task (the
 * owner, or a visitor lent that action - each act spends one use), and which
 * place it stands in (the owner only).
 */

import { z } from "zod";
import { revalidatePath } from "next/cache";
import { requireUser } from "@/lib/session";
import { spendGrant, type LiveGrant } from "@/lib/access/grants";
import { recordAudit } from "@/lib/audit-service";
import { nasStanding, type NasAct } from "@/lib/nas/nas-access";
import * as nasService from "@/lib/nas/nas-service";

export type NasActionResult = { ok: true } | { ok: false; error: "notFound" | "failed" };

const idSchema = z.string().uuid();
const fanSchema = z.enum(["quiet", "balanced", "cooling"]);
// A Drive task id as its API lists it; never more than an id's worth of text.
const taskSchema = z.string().trim().min(1).max(128);

async function reached(raw: unknown, act: NasAct | "manage") {
    const user = await requireUser();
    const id = idSchema.parse(raw);
    const row = await nasService.nasRow(id);
    if (!row?.ownerId) return null;
    const standing = await nasStanding(user, id);
    if (!standing) return null;
    if (act === "manage" ? !standing.manage : !standing[act]) return null;
    const grant: LiveGrant | null = act === "manage" ? null : (standing.grants[act] ?? null);
    return { user, row: { ...row, ownerId: row.ownerId }, grant };
}

/** Counted once the NAS did what was asked; bookkeeping, so logged, not raised. */
async function countUse(grant: LiveGrant | null): Promise<void> {
    if (!grant) return;
    await spendGrant(grant).catch((caught: unknown) =>
        console.error("polaris: a NAS use could not be counted:", caught)
    );
}

function failed(error: unknown): NasActionResult {
    if (error instanceof z.ZodError) return { ok: false, error: "failed" };
    if (error instanceof Error && error.message === "notFound") return { ok: false, error: "notFound" };
    console.error("polaris: a NAS action failed:", error);
    return { ok: false, error: "failed" };
}

export async function setNasFanAction(id: unknown, profile: unknown): Promise<NasActionResult> {
    try {
        const at = await reached(id, "fan");
        if (!at) return { ok: false, error: "notFound" };
        const next = fanSchema.parse(profile);
        await nasService.setNasFan(at.row.id, at.row.ownerId, next);
        await countUse(at.grant);
        await recordAudit({
            actorId: at.user.id,
            action: "nas.fan",
            targetType: "storage",
            targetId: at.row.id,
            metadata: { profile: next, lent: Boolean(at.grant) }
        });
        return { ok: true };
    } catch (error) {
        return failed(error);
    }
}

export async function runNasBackupAction(id: unknown, taskId: unknown): Promise<NasActionResult> {
    try {
        const at = await reached(id, "backup");
        if (!at) return { ok: false, error: "notFound" };
        const task = taskSchema.parse(taskId);
        await nasService.runNasBackup(at.row.id, at.row.ownerId, task);
        await countUse(at.grant);
        await recordAudit({
            actorId: at.user.id,
            action: "nas.backup",
            targetType: "storage",
            targetId: at.row.id,
            metadata: { taskId: task, lent: Boolean(at.grant) }
        });
        return { ok: true };
    } catch (error) {
        return failed(error);
    }
}

export async function setNasPlaceAction(id: unknown, placeId: unknown): Promise<NasActionResult> {
    try {
        const at = await reached(id, "manage");
        if (!at) return { ok: false, error: "notFound" };
        const place = idSchema.nullable().parse(placeId ?? null);
        if (!(await nasService.setNasPlace(at.row.id, place))) return { ok: false, error: "notFound" };
        await recordAudit({
            actorId: at.user.id,
            action: "nas.place",
            targetType: "storage",
            targetId: at.row.id,
            metadata: { placeId: place }
        });
        revalidatePath("/places");
        return { ok: true };
    } catch (error) {
        return failed(error);
    }
}
