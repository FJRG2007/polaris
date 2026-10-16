"use server";

/**
 * Agent rollouts and the command queue. Platform admins only: every action asks
 * for system.manage before it reads anything, the same gate as the Servers app.
 */

import { z } from "zod";
import { requirePermission } from "@/lib/session";
import { recordAudit } from "@/lib/audit-service";
import * as plan from "@/lib/agent-rollouts/plan";
import * as queue from "@/lib/agent-rollouts/queue";
import * as rollouts from "@/lib/agent-rollouts/service";

export type Result<T = undefined> = { ok: true; value: T } | { ok: false; error: string };

function refused(error: unknown): { ok: false; error: string } {
    if (error instanceof rollouts.RolloutRefusal) return { ok: false, error: error.code };
    if (error instanceof z.ZodError) return { ok: false, error: "invalid" };
    console.error("polaris: agent rollout action failed:", error);
    return { ok: false, error: "failed" };
}

const startSchema = z.object({
    version: z.string().trim().min(1).max(64),
    waves: z.array(z.number().int()).refine(plan.validWaves),
    healthMinutes: z.number().int().min(1).max(240)
});

const pinSchema = z.object({
    serverId: queue.serverIdSchema,
    version: z.string().trim().min(1).max(64).nullable()
});

export async function rolloutScreenAction(): Promise<Result<rollouts.RolloutScreen>> {
    await requirePermission("system.manage");
    try {
        return { ok: true, value: await rollouts.rolloutScreen() };
    } catch (error) {
        return refused(error);
    }
}

export async function startRolloutAction(input: z.input<typeof startSchema>): Promise<Result> {
    const user = await requirePermission("system.manage");
    try {
        const parsed = startSchema.parse(input);
        const rollout = await rollouts.startRollout(parsed, user.id);
        await recordAudit({
            actorId: user.id,
            action: "agent.rollout.start",
            targetType: "agentRollout",
            targetId: rollout.id,
            metadata: { version: parsed.version, waves: parsed.waves }
        });
        return { ok: true, value: undefined };
    } catch (error) {
        return refused(error);
    }
}

export async function rolloutControlAction(
    input: "resume" | "halt" | "rollback"
): Promise<Result> {
    const user = await requirePermission("system.manage");
    try {
        const action = z.enum(["resume", "halt", "rollback"]).parse(input);
        if (action === "resume") await rollouts.resumeRollout();
        else if (action === "halt") await rollouts.haltRollout();
        else await rollouts.rollbackRollout();
        await recordAudit({
            actorId: user.id,
            action: `agent.rollout.${action}`,
            targetType: "agentRollout"
        });
        return { ok: true, value: undefined };
    } catch (error) {
        return refused(error);
    }
}

export async function setPinAction(input: z.input<typeof pinSchema>): Promise<Result> {
    const user = await requirePermission("system.manage");
    try {
        const parsed = pinSchema.parse(input);
        await rollouts.setPin(parsed.serverId, parsed.version);
        await recordAudit({
            actorId: user.id,
            action: parsed.version ? "agent.pin" : "agent.unpin",
            targetType: "server",
            targetId: parsed.serverId,
            metadata: { version: parsed.version }
        });
        return { ok: true, value: undefined };
    } catch (error) {
        return refused(error);
    }
}

export async function enqueueCommandAction(
    input: z.input<typeof queue.enqueueSchema>
): Promise<Result<{ status: string }>> {
    const user = await requirePermission("system.manage");
    try {
        const parsed = queue.enqueueSchema.parse(input);
        const row = await rollouts.enqueueCommand(parsed, user.id);
        await recordAudit({
            actorId: user.id,
            action: "server.command.queue",
            targetType: "server",
            targetId: parsed.serverId,
            metadata: { kind: parsed.command.kind, command: parsed.id }
        });
        return { ok: true, value: { status: row.status } };
    } catch (error) {
        return refused(error);
    }
}

export async function cancelCommandAction(id: string): Promise<Result> {
    const user = await requirePermission("system.manage");
    try {
        const parsed = z.string().uuid().parse(id);
        await rollouts.cancelCommand(parsed);
        await recordAudit({
            actorId: user.id,
            action: "server.command.cancel",
            targetType: "serverCommand",
            targetId: parsed
        });
        return { ok: true, value: undefined };
    } catch (error) {
        return refused(error);
    }
}
