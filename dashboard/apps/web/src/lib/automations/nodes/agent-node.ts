/**
 * Put an agent to work on a connected repository from an automation: a run
 * that answers once, or a session somebody can watch and steer.
 *
 * The repository is the one the event that started the run names
 * (`code.*` events), or the one picked on the step. It runs on the account
 * that connected the repository - its provider keys, its usage ceilings - so
 * the account the automation runs as has to be that one, and still allowed to
 * start agent work (`agents.manage`), on every run.
 */

import { prisma } from "@polaris/db";
import * as core from "@polaris/core";
import { StepError, StepRefusal, type ServerNode } from "../types";

type AgentWorkConfig = ReturnType<(typeof core.CORE_NODE_CONFIGS)["core.agentWork"]["parse"]>;

/** How much of what somebody wrote is passed on; the agent reads the rest itself. */
const MAX_BODY = 4000;

const repoPayload = core.APP_EVENTS["code.mentioned"].payload;

/** The repository event that started the run, when one did. */
function repoEventOf(trigger: Record<string, unknown>) {
    const name = trigger.name;
    if (typeof name !== "string" || !core.isCodeEventName(name)) return null;
    const parsed = repoPayload.safeParse(trigger.payload);
    return parsed.success ? { name, ...parsed.data } : null;
}

/** What the agent is told happened: a sentence, then what somebody wrote, fenced. */
export function describeRepoEvent(event: NonNullable<ReturnType<typeof repoEventOf>>): string {
    const at =
        event.number === null
            ? "the repository"
            : `${event.pullRequest ? "pull request" : "issue"} #${event.number}`;
    const lines = [
        `${core.AGENT_TRIGGER_LABELS[core.CODE_EVENT_TRIGGERS[event.name]]} on ${at} in ${event.repo}.`,
        event.actor ? `By @${event.actor}.` : "",
        event.branch ? `Targets branch ${event.branch}.` : "",
        event.labels.length > 0 ? `Labels: ${event.labels.join(", ")}.` : ""
    ].filter(Boolean);
    const body = event.body.trim();
    if (body) lines.push("", "What it says:", "```", body.slice(0, MAX_BODY), "```");
    return lines.join("\n");
}

export const agentWorkNode: ServerNode<AgentWorkConfig> = {
    type: "core.agentWork",
    meta: core.CORE_NODE_META["core.agentWork"],
    config: core.CORE_NODE_CONFIGS["core.agentWork"],
    run: async (config, context, io) => {
        const [{ actingUser }, { sessionCan }, dispatch, sessions] = await Promise.all([
            import("@/lib/mcp/acting-user"),
            import("@/lib/session"),
            import("@/lib/agents/agent-dispatch"),
            import("@/lib/agents/issue-sessions")
        ]);
        const event = repoEventOf(context.trigger);
        const repoId = config.repoId || event?.repoId || "";
        io.recordInput({ repoId, mode: config.mode, target: config.target });
        if (!repoId) throw new StepError("repoRequired");
        const user = await actingUser(io.actor.id);
        if (!user) throw new StepRefusal("runAsGone");
        if (!(await sessionCan(user, "agents.manage"))) throw new StepRefusal("agentsForbidden");
        const repo = await prisma.agentRepo.findUnique({
            where: { id: repoId },
            select: {
                id: true,
                ownerId: true,
                repoFullName: true,
                execution: true,
                poolId: true,
                model: true,
                installationId: true,
                enabled: true
            }
        });
        if (!repo || repo.ownerId !== user.id) throw new StepError("repoGone");
        if (!repo.enabled) throw new StepError("repoOff");

        // The event this run answers, when it names this repository; a step
        // aimed at another repository is told only what it was asked.
        const about = event && event.repoId === repo.id ? event : null;
        const issueNumber = about && !about.pullRequest ? about.number : null;
        const prNumber = about?.pullRequest ? about.number : null;
        const described = about
            ? describeRepoEvent(about)
            : `An automation asked for work on ${repo.repoFullName}.`;

        if (config.target === "session") {
            const sessionId = await sessions.startIssueSession({
                repo,
                issueNumber,
                prNumber,
                title: about?.title || repo.repoFullName,
                instructions: config.instructions,
                described
            });
            if (!sessionId) throw new StepError("agentRefused");
            return { output: { runId: null, sessionId, repo: repo.repoFullName } };
        }
        const result = await dispatch.dispatchRun({
            repo,
            trigger: about ? core.CODE_EVENT_TRIGGERS[about.name] : "manual",
            prompt: described,
            mode: config.mode,
            instructions: config.instructions,
            issueNumber,
            prNumber,
            startedById: user.id
        });
        if (!result.runId) throw new StepError("agentRefused");
        return { output: { runId: result.runId, sessionId: null, repo: repo.repoFullName } };
    }
};
