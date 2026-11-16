/**
 * The coordinator's verbs: spawn a worker, send it a message, list its
 * children with their derived status, claim a pull request for one, and read
 * one's preview address.
 *
 * Ported from AO's orchestrator CLI (`backend/internal/skillassets/using-ao`:
 * `ao spawn`, `ao send`, `ao session ls`, `ao session claim-pr`, `ao preview`)
 * (Apache-2.0), as MCP tools on the session's own Polaris server rather than a
 * CLI, because that server is already in every session's configuration.
 *
 * Every tool needs `agents.coordinate`, which a session holds only while it
 * coordinates an active run, and acts only on that run's children: a session
 * dispatched for one of its tasks, started for the same person. Anything else
 * is refused in the same words as a session that does not exist, so a
 * coordinator cannot probe for other sessions. Spawning and sending have a
 * budget of their own on top of every call's (`call-guard`), short of what a
 * planning loop gone wrong would spend.
 */

import { z } from "zod";
import * as core from "@polaris/core";
import { fromSession } from "./sessions";
import { appBaseUrl } from "@/lib/domain-service";
import { rateLimit } from "@/lib/rate-limit-service";
import * as review from "@/lib/agents/session-review";
import * as runtime from "@/lib/agents/session-runtime";
import * as sessions from "@/lib/agents/session-service";
import { promptRefusal } from "@/lib/agents/session-api";
import { roleModelSchema } from "@/lib/agents/agent-roles";
import { sessionPreviewPorts } from "@/lib/agents/session-preview";
import * as orchestration from "@/lib/agents/orchestration-service";
import { McpRefusal, type McpCaller, type McpTool } from "../protocol";

/** Spawns one coordinator may make a minute, and messages it may send. */
export const SPAWNS_PER_MINUTE = 6;
export const SENDS_PER_MINUTE = 20;

const NOT_A_CHILD = "No worker with that id in the run you coordinate.";

async function coordinatedRun(caller: McpCaller): Promise<{ id: string; ownerId: string }> {
    // A coordinator is a session; a person's key names runs through the
    // orchestration_* tools, which take a run id.
    if (!caller.sessionId) throw new McpRefusal("Only a run's coordinator session can use this.");
    const run = await orchestration.runForCoordinator({ userId: caller.userId, sessionId: caller.sessionId });
    if (!run || run.ownerId !== caller.userId) throw new McpRefusal("No active run that this session coordinates.");
    return run;
}

async function child(caller: McpCaller, sessionId: string) {
    const run = await coordinatedRun(caller);
    const found = await orchestration.childSession(run, sessionId);
    if (!found) throw new McpRefusal(NOT_A_CHILD);
    const session = await sessions.getSession(found.sessionId, run.ownerId);
    if (!session) throw new McpRefusal(NOT_A_CHILD);
    return { run, session };
}

async function spend(bucket: string, limit: number): Promise<void> {
    const throttle = await rateLimit(bucket, limit, 60_000);
    if (!throttle.ok) {
        const wait = Math.max(1, Math.ceil(throttle.retryAfterMs / 1000));
        throw new McpRefusal(`Too many in a minute. Try again in ${wait} s.`);
    }
}

const sessionId = z.string().uuid().describe("The worker's session id, from coordinator_children.");

// --- spawn -----------------------------------------------------------------

const spawnInput = z
    .object({
        clientKey: z
            .string()
            .trim()
            .regex(/^[A-Za-z0-9._:-]{1,100}$/, "Letters, digits and . _ : - only, up to 100")
            .describe(
                "Your own key for this spawn, unique in the run. Calling again with the same key returns the worker the first call made instead of starting another, so retry with the same key after an uncertain result."
            ),
        title: z.string().trim().min(1).max(80).describe("What the worker is for, in a few words."),
        prompt: z.string().trim().min(1).max(20_000).describe("Everything the worker needs to do it."),
        role: z
            .enum(["worker", "reviewer"])
            .default("worker")
            .describe(
                "worker changes code; reviewer reads a pull request and is sent none of its check failures or review comments. Each starts on its repository default unless agent or model says otherwise."
            ),
        agent: core.agentCliIdSchema.optional().describe("The agent to run it on. Default: the repository's for the role."),
        model: roleModelSchema
            .optional()
            .describe("The model as provider/model. Default: the repository's for the role, or the agent's own.")
    })
    .strict();

const spawnOutput = z.object({
    taskId: z.string().uuid(),
    sessionId: z.string().uuid().nullable(),
    status: z.string()
});

const spawnTool: McpTool<z.infer<typeof spawnInput>> = {
    name: "coordinator_spawn",
    // i18n-ignore shown by the calling client, which has no locale to ask for
    title: "Spawn a worker",
    description:
        // i18n-ignore read by the calling model, not shown to a person
        "Start a worker agent on its own branch in the run you coordinate, with the prompt as its task. It starts now when the run has a free slot and waits for one otherwise. Idempotent on clientKey.",
    input: spawnInput,
    category: "development",
    scope: "agents.coordinate",
    readOnly: false,
    destructive: false,
    idempotent: true,
    async run(input, caller) {
        const run = await coordinatedRun(caller);
        await spend(`coordinator-spawn:${caller.sessionId}`, SPAWNS_PER_MINUTE);
        let spawned: Awaited<ReturnType<typeof orchestration.spawnWorker>>;
        try {
            spawned = await orchestration.spawnWorker(run, {
                clientKey: input.clientKey,
                title: input.title,
                prompt: input.prompt,
                role: input.role,
                agent: input.agent ?? null,
                model: input.model || null
            });
        } catch (error) {
            if (error instanceof orchestration.OrchestrationRefusal) throw new McpRefusal(error.message);
            throw error;
        }
        const structured = spawnOutput.parse(spawned);
        return {
            text: structured.sessionId
                ? `Spawned ${structured.sessionId} (task ${structured.taskId}).`
                : `Task ${structured.taskId} is ${structured.status}; it gets a session when the run has a free slot.`,
            structured
        };
    }
};

// --- send ------------------------------------------------------------------

const sendInput = z
    .object({
        sessionId,
        message: z.string().trim().min(1).max(20_000).describe("What to tell it. Goes into its prompt as written.")
    })
    .strict();

const sendOutput = z.object({ sessionId: z.string().uuid(), sent: z.literal(true) });

const sendTool: McpTool<z.infer<typeof sendInput>> = {
    name: "coordinator_send",
    // i18n-ignore shown by the calling client, which has no locale to ask for
    title: "Send to a worker",
    description:
        // i18n-ignore read by the calling model, not shown to a person
        "Send one of your workers a message. A busy worker gets it as its next prompt, not in the middle of its turn.",
    input: sendInput,
    category: "development",
    scope: "agents.coordinate",
    readOnly: false,
    destructive: false,
    async run(input, caller) {
        const { run, session } = await child(caller, input.sessionId);
        const refused = promptRefusal(session);
        if (refused) throw new McpRefusal(refused);
        await spend(`coordinator-send:${caller.sessionId}`, SENDS_PER_MINUTE);
        const sender = await sessions.getSession(caller.sessionId!, run.ownerId);
        const text = sender ? fromSession(sender, input.message) : input.message;
        await sessions.addSessionMessage(session.id, "user", text, run.ownerId);
        await runtime.promptSession(session.id, text);
        return { text: "Sent.", structured: sendOutput.parse({ sessionId: session.id, sent: true }) };
    }
};

// --- children --------------------------------------------------------------

const childrenInput = z.object({}).strict();

const childOutput = z.object({
    taskId: z.string().uuid(),
    title: z.string(),
    role: z.string(),
    taskStatus: z.string(),
    sessionId: z.string().uuid().nullable(),
    agent: z.string().nullable(),
    model: z.string().nullable(),
    branch: z.string().nullable(),
    status: z.string().nullable(),
    pullRequest: z.object({ number: z.number().int(), url: z.string() }).nullable(),
    checks: z.string().nullable(),
    review: z.string().nullable()
});
const childrenOutput = z.object({ children: z.array(childOutput) });

const childrenTool: McpTool<z.infer<typeof childrenInput>> = {
    name: "coordinator_children",
    // i18n-ignore shown by the calling client, which has no locale to ask for
    title: "List your workers",
    description:
        // i18n-ignore read by the calling model, not shown to a person
        "Every worker in the run you coordinate with its derived status (working, needs_input, ci_failed, changes_requested, merge_conflict, mergeable, approved, review_pending, pr_open, draft, merged, idle, no_signal, terminated), its pull request, checks and review.",
    input: childrenInput,
    category: "development",
    scope: "agents.coordinate",
    readOnly: true,
    async run(_input, caller) {
        const run = await coordinatedRun(caller);
        const structured = childrenOutput.parse({ children: await orchestration.runChildren(run.id) });
        const lines = structured.children.map(
            (entry) =>
                `${entry.sessionId ?? "-"}  ${entry.title}  [${entry.status ?? entry.taskStatus}]  ${entry.role}${entry.agent ? ` ${entry.agent}` : ""}${entry.pullRequest ? `  PR #${entry.pullRequest.number}${entry.checks ? ` checks ${entry.checks}` : ""}` : ""}`
        );
        return { text: lines.length ? lines.join("\n") : "No workers yet.", structured };
    }
};

// --- claim a pull request --------------------------------------------------

const claimInput = z
    .object({
        sessionId,
        pullRequest: z.string().trim().min(1).max(300).describe("The pull request number, or its github.com address."),
        takeover: z
            .boolean()
            .default(false)
            .describe("Take it from another live session that holds it. Off refuses instead."),
        review: z
            .boolean()
            .default(false)
            .describe(
                "Claim it to review, not to work on: the worker is sent none of its check failures or review comments, and it is never taken from another session."
            )
    })
    .strict();

const claimOutput = z.object({
    sessionId: z.string().uuid(),
    pullRequest: z.object({ number: z.number().int(), url: z.string() }),
    takenFrom: z.array(z.string().uuid())
});

/** A refusal in words the model can act on. */
const CLAIM_SAID: Record<review.ClaimRefusal, string> = {
    ended: "That worker's session has ended.",
    workspace: "That worker has no repository to hold a pull request in.",
    invalid: "Name the pull request by its number or its github.com address.",
    otherRepo: "That pull request is in another repository.",
    noAuth: "Polaris has no GitHub access to that repository.",
    missing: "There is no such pull request, or it cannot be read.",
    notOpen: "That pull request is not open.",
    taken: "Another live session holds that pull request. Pass takeover to take it."
};

const claimTool: McpTool<z.infer<typeof claimInput>> = {
    name: "coordinator_claim_pr",
    // i18n-ignore shown by the calling client, which has no locale to ask for
    title: "Claim a pull request",
    description:
        // i18n-ignore read by the calling model, not shown to a person
        "Attach an existing open pull request of the same repository to one of your workers. It changes which pull request the worker's status follows; it does not check the branch out.",
    input: claimInput,
    category: "development",
    scope: "agents.coordinate",
    readOnly: false,
    destructive: false,
    idempotent: true,
    async run(input, caller) {
        const { run, session } = await child(caller, input.sessionId);
        // A review claim never takes the pull request from anybody, and its
        // switch goes off first so no feedback slips in between (AO `--review`).
        const before = input.review ? await sessions.setAutoFeedback(session.id, false) : null;
        const result = await review.claimSessionPullRequest(
            session,
            input.pullRequest,
            { takeover: input.review ? false : input.takeover },
            review.claimDeps(run.ownerId)
        );
        if (result.kind === "refused") {
            if (before !== null) await sessions.setAutoFeedback(session.id, before);
            throw new McpRefusal(CLAIM_SAID[result.reason]);
        }
        const structured = claimOutput.parse({
            sessionId: session.id,
            pullRequest: { number: result.pull.number, url: result.pull.url },
            takenFrom: result.takenFrom
        });
        return { text: `Claimed #${result.pull.number} for ${session.id}.`, structured };
    }
};

// --- preview ---------------------------------------------------------------

const previewInput = z.object({ sessionId }).strict();

const previewOutput = z.object({
    sessionId: z.string().uuid(),
    urls: z.array(z.object({ port: z.number().int(), url: z.string() })),
    loopbackOnly: z.array(z.number().int())
});

const previewTool: McpTool<z.infer<typeof previewInput>> = {
    name: "coordinator_preview",
    // i18n-ignore shown by the calling client, which has no locale to ask for
    title: "Preview a worker's app",
    description:
        // i18n-ignore read by the calling model, not shown to a person
        "The addresses one of your workers' running web servers answer on, for a person to open. Only a worker in a Polaris container has them; a server listening on localhost only is listed apart, since it cannot be reached.",
    input: previewInput,
    category: "development",
    scope: "agents.coordinate",
    readOnly: true,
    async run(input, caller) {
        const { session } = await child(caller, input.sessionId);
        const answer = await sessionPreviewPorts(session.id);
        if (answer.kind !== "ports") throw new McpRefusal("That worker has no preview: it is not running in a Polaris container.");
        const base = (await appBaseUrl()).replace(/\/+$/, "");
        const structured = previewOutput.parse({
            sessionId: session.id,
            urls: answer.open.map((port) => ({ port, url: `${base}${answer.base}/${port}/` })),
            loopbackOnly: answer.inside
        });
        const lines = structured.urls.map((entry) => `${entry.port}  ${entry.url}`);
        if (structured.loopbackOnly.length)
            lines.push(`Listening on localhost only (bind to 0.0.0.0 to preview): ${structured.loopbackOnly.join(", ")}`);
        return { text: lines.length ? lines.join("\n") : "Nothing is listening yet.", structured };
    }
};

export const COORDINATOR_TOOLS = [
    spawnTool,
    sendTool,
    childrenTool,
    claimTool,
    previewTool
] as unknown as McpTool<never>[];
