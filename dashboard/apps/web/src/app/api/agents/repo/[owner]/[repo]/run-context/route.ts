/**
 * What a run is told about the repository it is about to work in.
 *
 * The first call a run makes, and the one that decides everything after it: which
 * model, how hard it thinks, whether it may push, whether it may run a shell, and
 * which provider key it is handed.
 *
 * The runtime treats an unreachable control plane as "use your defaults", so a
 * refusal here has to be a status code it understands rather than a bare 500:
 *
 *   - 401 when the caller cannot be identified as a run at all.
 *   - 402 when this repository is not enabled, which stops the run rather than
 *     letting it proceed on defaults.
 *   - 404 when the caller is a run for a different repository than the path names.
 *
 * All three are definitive. Only a 5xx leaves the run's own state genuinely
 * unknown, and the runtime handles that by degrading rather than by guessing at
 * permissions.
 */

import { prisma } from "@polaris/db";
import { authenticateRun } from "@/lib/agents/agent-auth";
import { issueRunToken, markRunStarted } from "@/lib/agents/agent-run-service";
import { buildRunContext } from "@/lib/agents/agent-run-context";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function GET(
    request: Request,
    { params }: { params: Promise<{ owner: string; repo: string }> }
): Promise<Response> {
    const { owner, repo } = await params;
    const repoFullName = `${owner}/${repo}`;

    const caller = await authenticateRun(request.headers);
    if (!caller) return Response.json({ error: "not a recognised run" }, { status: 401 });

    // A run may only be told about the repository it belongs to. The path is the
    // caller's claim; the run row is the fact.
    if (caller.repoFullName.toLowerCase() !== repoFullName.toLowerCase()) {
        return Response.json({ error: "this run is not for that repository" }, { status: 404 });
    }

    const row = await prisma.agentRepo.findUnique({
        where: { id: caller.repoId },
        select: { enabled: true, model: true, effort: true, push: true, shell: true }
    });
    if (!row?.enabled) {
        return Response.json({ reason: "commercial", error: "agent runs are not enabled for this repository" }, { status: 402 });
    }

    // The run row holds the mode and the model it was dispatched with; the
    // repository holds everything else. Reading the mode from the run is what
    // keeps a settings change mid-flight from redirecting a run already going.
    const run = await prisma.agentRun.findUnique({
        where: { id: caller.runId },
        select: { mode: true, model: true, trigger: true }
    });

    const instructions = await instructionsFor(caller.repoId, run?.trigger ?? null, run?.mode ?? null);

    // Asking for its context is the first thing a run does, so it is also the
    // moment the run stopped being queued. A workflow that never boots therefore
    // stays visibly queued rather than claiming to have started.
    //
    // Recording GitHub's own run id here is what lets the `workflow_run` webhook
    // close this row out later: that webhook knows GitHub's id and nothing else,
    // so a run that never records it can only ever be closed by the stale sweep.
    await markRunStarted(caller.runId, caller.githubRunId ? { githubRunId: caller.githubRunId } : {});

    const context = await buildRunContext({
        // Issued here rather than read back off the request. The caller may have
        // authenticated with an OIDC assertion, which is not a credential this
        // instance can accept on later calls, so the run collects a real one in
        // the reply.
        runToken: await issueRunToken(caller.runId),
        model: run?.model ?? row.model,
        effort: row.effort,
        push: row.push,
        shell: row.shell,
        instructions,
        mode: run?.mode ?? null
    });

    return Response.json(context, { headers: { "cache-control": "no-store" } });
}

/**
 * The operator's standing guidance for this run.
 *
 * Taken from the automations on the repository rather than from a free-form field
 * so it is the same text the operator sees against the rule that fired. Only
 * enabled automations contribute; an operator who turned a rule off does not
 * expect its wording to keep reaching the agent.
 */
async function instructionsFor(repoId: string, trigger: string | null, mode: string | null): Promise<string> {
    const rows = await prisma.agentAutomation.findMany({
        where: {
            repoId,
            enabled: true,
            // Scoped to the rule that actually fired. Without this a ci.failed
            // rule s prose reaches a manual run and a pr.opened rule s reaches a
            // mention, which is not what the operator wrote it against.
            ...(trigger ? { trigger } : {}),
            ...(mode ? { mode } : {})
        },
        select: { instructions: true },
        orderBy: { createdAt: "asc" }
    });
    return rows
        .map((row) => row.instructions.trim())
        .filter(Boolean)
        .join("\n\n");
}
