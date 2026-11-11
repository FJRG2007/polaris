"use server";

/**
 * What a person does to an orchestration run from its page: start one, answer
 * a gate or a question, keep one variant of a fan-out, cancel a run.
 *
 * Every action checks that the run is this account's before touching it; the
 * service's own checks are about the run's state, not about who is asking.
 */

import { z } from "zod";
import { prisma } from "@polaris/db";
import * as core from "@polaris/core";
import { revalidatePath } from "next/cache";
import { agentText } from "@/lib/agents/words";
import { requirePermission } from "@/lib/session";
import { getTranslations } from "@/lib/i18n/request";
import * as orchestration from "@/lib/agents/orchestration-service";

const RUNS_PATH = "/automations/code-review/orchestration";

type Result = { error?: string };

/** Run the work, turning a service refusal into its sentence on screen. */
async function acting(work: () => Promise<void>): Promise<Result> {
    const t = await getTranslations("agents");
    try {
        await work();
    } catch (error) {
        if (error instanceof orchestration.OrchestrationRefusal) {
            return { error: agentText(t, error.message) };
        }
        throw error;
    }
    revalidatePath(RUNS_PATH);
    return {};
}

/** The run, when this account owns it. */
async function ownedRun(runId: string): Promise<{ userId: string } | null> {
    const user = await requirePermission("agents.manage");
    return (await orchestration.ownsRun(runId, user.id)) ? { userId: user.id } : null;
}

const createSchema = z
    .object({
        objective: z.string().trim().min(1).max(4000),
        repoId: z.string().uuid(),
        baseRef: z.string().trim().max(200).default(""),
        cli: core.agentCliIdSchema,
        coordinator: z.boolean()
    })
    .strict();

export async function createRunAction(input: unknown): Promise<Result & { id?: string }> {
    const user = await requirePermission("agents.manage");
    const t = await getTranslations("agents");
    const parsed = createSchema.safeParse(input);
    if (!parsed.success) return { error: t("orchestration.errors.invalid") };
    const repo = await prisma.agentRepo.findFirst({
        where: { id: parsed.data.repoId, ownerId: user.id },
        select: { id: true }
    });
    if (!repo) return { error: t("sessions.errors.repoNotConnected") };
    let id: string | undefined;
    const result = await acting(async () => {
        ({ id } = await orchestration.createRun({ ownerId: user.id, ...parsed.data }));
    });
    return { ...result, id };
}

const taskRef = z.object({ runId: z.string().uuid(), taskId: z.string().uuid() }).strict();

export async function resolveGateAction(input: unknown): Promise<Result> {
    const t = await getTranslations("agents");
    const parsed = taskRef.extend({ approved: z.boolean() }).strict().safeParse(input);
    if (!parsed.success) return { error: t("orchestration.errors.invalid") };
    const owner = await ownedRun(parsed.data.runId);
    if (!owner) return { error: t("orchestration.errors.gone") };
    const { runId, taskId, approved } = parsed.data;
    return acting(() => orchestration.resolveGate(runId, taskId, approved, owner.userId));
}

export async function answerQuestionAction(input: unknown): Promise<Result> {
    const t = await getTranslations("agents");
    const parsed = z
        .object({
            runId: z.string().uuid(),
            messageId: z.string().uuid(),
            text: z.string().trim().min(1).max(4000)
        })
        .strict()
        .safeParse(input);
    if (!parsed.success) return { error: t("orchestration.errors.invalid") };
    if (!(await ownedRun(parsed.data.runId))) return { error: t("orchestration.errors.gone") };
    const { runId, messageId, text } = parsed.data;
    return acting(() => orchestration.answer(runId, messageId, text));
}

export async function chooseVariantAction(input: unknown): Promise<Result> {
    const t = await getTranslations("agents");
    const parsed = taskRef.safeParse(input);
    if (!parsed.success) return { error: t("orchestration.errors.invalid") };
    if (!(await ownedRun(parsed.data.runId))) return { error: t("orchestration.errors.gone") };
    return acting(() => orchestration.chooseVariant(parsed.data.runId, parsed.data.taskId));
}

export async function cancelRunAction(runId: unknown): Promise<Result> {
    const t = await getTranslations("agents");
    const parsed = z.string().uuid().safeParse(runId);
    if (!parsed.success) return { error: t("orchestration.errors.invalid") };
    if (!(await ownedRun(parsed.data))) return { error: t("orchestration.errors.gone") };
    return acting(() => orchestration.cancelRun(parsed.data));
}

const addTaskSchema = z
    .object({
        runId: z.string().uuid(),
        title: z.string().trim().min(1).max(80),
        spec: z.string().trim().min(1).max(20_000),
        // One agent is an ordinary task; several is the same task on each, to
        // compare and keep one.
        agents: z.array(core.agentCliIdSchema).min(1).max(8),
        gate: z.string().trim().max(500).default("")
    })
    .strict();

export async function addTaskAction(input: unknown): Promise<Result> {
    const t = await getTranslations("agents");
    const parsed = addTaskSchema.safeParse(input);
    if (!parsed.success) return { error: t("orchestration.errors.invalid") };
    if (!(await ownedRun(parsed.data.runId))) return { error: t("orchestration.errors.gone") };
    const { runId, title, spec, agents, gate } = parsed.data;
    const task = { title, spec, dependsOn: [], gateQuestion: gate || null };
    return acting(async () => {
        if (new Set(agents).size > 1) await orchestration.fanOut(runId, task, agents);
        else await orchestration.addTasks(runId, [{ ...task, cli: agents[0]! }]);
    });
}
