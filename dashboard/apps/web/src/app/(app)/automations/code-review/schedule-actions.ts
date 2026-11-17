"use server";

/**
 * A repository's scheduled sessions: list, save, switch and remove. Every
 * action re-checks `agents.manage` and that the repository is this account's,
 * because the dialog may have been open since either changed.
 */

import { z } from "zod";
import { requirePermission } from "@/lib/session";
import { getTranslations } from "@/lib/i18n/request";
import * as schedules from "@/lib/agents/session-schedules";
import { getAgentRepo } from "@/lib/agents/agent-repo-service";
import { agentChoicesFor } from "@/lib/agents/agent-readiness";

const repoIdSchema = z.string().uuid();
const scheduleRefSchema = z.object({ repoId: repoIdSchema, id: z.string().uuid() });

/** The repository, when it is this account's. */
async function ownRepo(repoId: unknown) {
    const user = await requirePermission("agents.manage");
    const parsed = repoIdSchema.safeParse(repoId);
    if (!parsed.success) return { user, repo: null };
    return { user, repo: await getAgentRepo(user.id, parsed.data) };
}

export async function listSessionSchedulesAction(repoId: unknown): Promise<{
    schedules?: schedules.SessionScheduleView[];
    agents?: { id: string; label: string }[];
    error?: string;
}> {
    const { user, repo } = await ownRepo(repoId);
    const t = await getTranslations("agents");
    if (!repo) return { error: t("errors.repoNotFound") };
    const [rows, choices] = await Promise.all([
        schedules.listSessionSchedules(repo.id),
        agentChoicesFor(user.id)
    ]);
    return { schedules: rows, agents: choices.map((choice) => ({ id: choice.id, label: choice.label })) };
}

export async function saveSessionScheduleAction(
    input: unknown
): Promise<{ schedule?: schedules.SessionScheduleView; error?: string }> {
    const user = await requirePermission("agents.manage");
    const t = await getTranslations("agents");
    const parsed = schedules.sessionScheduleInputSchema.safeParse(input);
    if (!parsed.success) return { error: t("repoSchedules.errors.invalid") };
    const repo = await getAgentRepo(user.id, parsed.data.repoId);
    if (!repo) return { error: t("errors.repoNotFound") };
    const saved = await schedules.saveSessionSchedule(parsed.data, user.id);
    if ("refusal" in saved)
        return {
            error:
                saved.refusal === "tooMany"
                    ? t("repoSchedules.errors.tooMany", { max: schedules.SESSION_SCHEDULES_PER_REPO })
                    : t("repoSchedules.errors.notFound")
        };
    return { schedule: saved.view };
}

export async function setSessionScheduleEnabledAction(input: unknown): Promise<{ error?: string }> {
    const user = await requirePermission("agents.manage");
    const t = await getTranslations("agents");
    const parsed = scheduleRefSchema.extend({ enabled: z.boolean() }).safeParse(input);
    if (!parsed.success) return { error: t("repoSchedules.errors.invalid") };
    const repo = await getAgentRepo(user.id, parsed.data.repoId);
    if (!repo) return { error: t("errors.repoNotFound") };
    const done = await schedules.setSessionScheduleEnabled(repo.id, parsed.data.id, parsed.data.enabled);
    return done ? {} : { error: t("repoSchedules.errors.notFound") };
}

export async function deleteSessionScheduleAction(input: unknown): Promise<{ error?: string }> {
    const user = await requirePermission("agents.manage");
    const t = await getTranslations("agents");
    const parsed = scheduleRefSchema.safeParse(input);
    if (!parsed.success) return { error: t("repoSchedules.errors.invalid") };
    const repo = await getAgentRepo(user.id, parsed.data.repoId);
    if (!repo) return { error: t("errors.repoNotFound") };
    return (await schedules.deleteSessionSchedule(repo.id, parsed.data.id)) ? {} : { error: t("repoSchedules.errors.notFound") };
}
