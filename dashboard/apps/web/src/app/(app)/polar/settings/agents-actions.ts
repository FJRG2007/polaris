"use server";

/**
 * The Agents section of Polar's settings. Every action establishes the
 * signed-in person and their Polar access, validates its input with the same
 * schema the editor uses, and touches only that person's own agents. Somebody
 * viewing as another account reads, and never writes.
 */

import { z } from "zod";
import { requireUser } from "@/lib/session";
import { polarCodeRepoAgentFiles } from "@/lib/polar/code";
import * as store from "@/lib/polar/agents/store";
import { polarAccessFor } from "@/lib/polar/access";
import { getTranslations } from "@/lib/i18n/request";
import { setAgentDefault } from "@/lib/polar/agents/defaults";
import { agentInputSchema, type AgentView, type AgentWork } from "@/lib/polar/agents/shared";
import { AGENT_FILE_MAX, parseAgentFile, type AgentFile } from "@/lib/polar/agents/agent-files";

type Result<T> = { ok: true; value: T } | { ok: false; error: string };

async function caller(write: boolean): Promise<{ id: string; admin: boolean } | { error: string }> {
    const t = await getTranslations("polar");
    const user = await requireUser();
    const access = await polarAccessFor(user.id);
    if (!access.use) return { error: t("settings.agents.errors.noAccess") };
    if (write && user.viewingAs) return { error: t("settings.agents.errors.viewingAs") };
    return { id: user.id, admin: user.isAdmin && !user.viewingAs };
}

async function answer(result: AgentView | store.AgentRefusal): Promise<Result<AgentView>> {
    if (typeof result !== "string") return { ok: true, value: result };
    const t = await getTranslations("polar");
    const code = result === "invalid" ? "failed" : result;
    return { ok: false, error: t(`settings.agents.errors.${code}`) };
}

export async function listAgentsAction(): Promise<Result<AgentView[]>> {
    const who = await caller(false);
    if ("error" in who) return { ok: false, error: who.error };
    return { ok: true, value: await store.listAgents(who.id) };
}

/** The name a chat started with an agent shows, or null when it is gone. */
export async function agentNameAction(input: unknown): Promise<string | null> {
    const parsed = z.object({ id: z.string().uuid() }).safeParse(input);
    if (!parsed.success) return null;
    const who = await caller(false);
    if ("error" in who) return null;
    return (await store.agentFor(who.id, parsed.data.id))?.name ?? null;
}

const saveSchema = z.object({
    id: z.string().uuid().nullable().default(null),
    agent: agentInputSchema
});

export async function saveAgentAction(input: unknown): Promise<Result<AgentView>> {
    const who = await caller(true);
    if ("error" in who) return { ok: false, error: who.error };
    const parsed = saveSchema.safeParse(input);
    if (!parsed.success) return answer("invalid");
    const { id, agent } = parsed.data;
    return answer(
        id
            ? await store.updateAgent(who.id, id, agent, who.admin)
            : await store.createAgent(who.id, agent, who.admin)
    );
}

/** Agent files pasted or read from a repository (`.polaris/agents`,
 *  `.opencode/agent`, `.claude/agents`), read into agents the editor can save. */
const importSchema = z.object({
    files: z
        .array(z.object({ path: z.string().trim().min(1).max(300), content: z.string().max(AGENT_FILE_MAX) }))
        .min(1)
        .max(20)
});

/** One file read: the agent, or null when it does not read. */
export type ReadAgentFile = { path: string; agent: AgentFile | null };

export async function readAgentFilesAction(input: unknown): Promise<Result<ReadAgentFile[]>> {
    const who = await caller(false);
    if ("error" in who) return { ok: false, error: who.error };
    const parsed = importSchema.safeParse(input);
    if (!parsed.success) {
        const t = await getTranslations("polar");
        return { ok: false, error: t("settings.agents.errors.failed") };
    }
    return { ok: true, value: readFiles(parsed.data.files) };
}

/** The agent files of a connected repository, read the same way. */
export async function repoAgentFilesAction(input: unknown): Promise<Result<ReadAgentFile[]>> {
    const t = await getTranslations("polar");
    const parsed = z.object({ repoId: z.string().uuid() }).safeParse(input);
    if (!parsed.success) return { ok: false, error: t("settings.agents.errors.failed") };
    const user = await requireUser();
    const files = await polarCodeRepoAgentFiles(user, parsed.data.repoId);
    if (!files) return { ok: false, error: t("settings.agents.errors.noAccess") };
    return { ok: true, value: readFiles(files) };
}

function readFiles(files: readonly { path: string; content: string }[]): ReadAgentFile[] {
    return files.map((file) => {
        const read = parseAgentFile(file.path, file.content);
        return { path: file.path, agent: typeof read === "string" ? null : read };
    });
}

export async function deleteAgentAction(input: unknown): Promise<Result<null>> {
    const who = await caller(true);
    if ("error" in who) return { ok: false, error: who.error };
    const parsed = z.object({ id: z.string().uuid() }).safeParse(input);
    if (!parsed.success) {
        const t = await getTranslations("polar");
        return { ok: false, error: t("settings.agents.errors.failed") };
    }
    // Already gone is what was asked for.
    await store.deleteAgent(who.id, parsed.data.id);
    return { ok: true, value: null };
}

/** The account and models of an agent that comes with Polaris (Polar itself,
 *  Claude Code, Codex...), which is edited and never deleted. */
export async function saveAgentDefaultAction(input: unknown): Promise<Result<AgentWork>> {
    const who = await caller(true);
    if ("error" in who) return { ok: false, error: who.error };
    const saved = await setAgentDefault(who.id, input);
    if (saved) return { ok: true, value: saved };
    const t = await getTranslations("polar");
    return { ok: false, error: t("settings.agents.errors.failed") };
}
