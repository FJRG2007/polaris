/**
 * Orchestration over MCP: what a coordinator session plans with and what a
 * worker session reports through.
 *
 * Two narrow scopes rather than `agents.manage`. A coordinator holds
 * `agents.coordinate` only while it coordinates an active run, and every tool
 * here acts on that run alone - it adds tasks, which start as sessions under the
 * run's bounds and the account's ceilings, but it never picks a repository, a
 * machine or a credential. A worker holds `agents.report` only while it is
 * dispatched on a task, and can say nothing about any other task.
 */

import { z } from "zod";
import * as core from "@polaris/core";
import * as orchestration from "@/lib/agents/orchestration-service";
import { McpRefusal, type McpCaller, type McpTool } from "../protocol";

const runId = z
    .string()
    .uuid()
    .optional()
    .describe("The run. Leave it out from a coordinator session: its own run is used.");

async function coordinatedRun(caller: McpCaller, id: string | undefined) {
    const run = await orchestration.runForCoordinator({
        userId: caller.userId,
        sessionId: caller.sessionId ?? undefined,
        runId: id
    });
    if (!run) throw new McpRefusal("No active run that this caller coordinates.");
    return run;
}

/** A refusal from the service, passed on in its own words. */
async function refusing<T>(work: () => Promise<T>): Promise<T> {
    try {
        return await work();
    } catch (error) {
        if (error instanceof orchestration.OrchestrationRefusal) throw new McpRefusal(error.message);
        throw error;
    }
}

const createInput = z.object({
    runId,
    title: z.string().trim().min(1).max(80).describe("What the task is, in a few words."),
    spec: z.string().trim().min(1).max(20_000).describe("Everything the worker needs to do it."),
    dependsOn: z
        .array(z.string().uuid())
        .max(20)
        .default([])
        .describe("Ids of tasks in this run that must complete first."),
    agent: core.agentCliIdSchema.optional().describe("The agent to run it on. Default: the run's."),
    compareAgents: z
        .array(core.agentCliIdSchema)
        .max(8)
        .optional()
        .describe(
            "Two or more agents to run the same task on side by side; a person compares the results on the run's page and keeps one. Overrides agent."
        ),
    gate: z
        .string()
        .trim()
        .max(500)
        .optional()
        .describe("A question a person must approve on the run's page before the task starts.")
});

const createTaskTool: McpTool<z.infer<typeof createInput>> = {
    name: "orchestration_task_create",
    // i18n-ignore shown by the calling client, which has no locale to ask for
    title: "Create an orchestration task",
    description:
        // i18n-ignore read by the calling model, not shown to a person
        "Add a task to the run you coordinate. It becomes its own agent session on its own branch and starts by itself once every task it depends on has completed.",
    input: createInput,
    category: "development",
    scope: "agents.coordinate",
    readOnly: false,
    destructive: false,
    async run(input, caller) {
        const run = await coordinatedRun(caller, input.runId);
        if (input.compareAgents && input.compareAgents.length > 1) {
            const ids = await refusing(() =>
                orchestration.fanOut(
                    run.id,
                    {
                        title: input.title,
                        spec: input.spec,
                        dependsOn: input.dependsOn,
                        gateQuestion: input.gate || null
                    },
                    input.compareAgents!
                )
            );
            return { text: `Created ${ids.length} variants: ${ids.join(", ")}.`, structured: { ids } };
        }
        const [id] = await refusing(() =>
            orchestration.addTasks(run.id, [
                {
                    title: input.title,
                    spec: input.spec,
                    dependsOn: input.dependsOn,
                    cli: input.agent ?? null,
                    gateQuestion: input.gate || null
                }
            ])
        );
        return { text: `Created task ${id}.`, structured: { id } };
    }
};

const listInput = z.object({ runId });

const listTasksTool: McpTool<z.infer<typeof listInput>> = {
    name: "orchestration_tasks",
    // i18n-ignore shown by the calling client, which has no locale to ask for
    title: "List orchestration tasks",
    description:
        // i18n-ignore read by the calling model, not shown to a person
        "Every task in the run you coordinate, with its status (pending, ready, dispatched, completed, failed, blocked), what it depends on, and what its worker reported.",
    input: listInput,
    category: "development",
    scope: "agents.coordinate",
    readOnly: true,
    async run(input, caller) {
        const run = await coordinatedRun(caller, input.runId);
        const tasks = await orchestration.runTasks(run.id);
        const lines = tasks.map(
            (task) =>
                `${task.id}  ${task.title}  [${task.status}${task.blockedBy ? `: ${task.blockedBy}` : ""}]${task.dependsOn.length ? `  after ${task.dependsOn.join(", ")}` : ""}${task.result ? `\n    ${task.result.slice(0, 500)}` : ""}`
        );
        return {
            text: lines.length ? lines.join("\n") : "No tasks yet.",
            structured: {
                tasks: tasks.map((task) => ({
                    id: task.id,
                    title: task.title,
                    status: task.status,
                    blockedBy: task.blockedBy,
                    dependsOn: task.dependsOn,
                    sessionId: task.sessionId,
                    outcome: task.outcome,
                    result: task.result
                }))
            }
        };
    }
};

const inboxInput = z.object({ runId });

const inboxTool: McpTool<z.infer<typeof inboxInput>> = {
    name: "orchestration_inbox",
    // i18n-ignore shown by the calling client, which has no locale to ask for
    title: "Read the orchestration inbox",
    description:
        // i18n-ignore read by the calling model, not shown to a person
        "What workers reported since you last looked: worker_done, question and escalation messages, oldest first. Reading marks them read.",
    input: inboxInput,
    category: "development",
    scope: "agents.coordinate",
    readOnly: false,
    destructive: false,
    async run(input, caller) {
        const run = await coordinatedRun(caller, input.runId);
        const rows = await orchestration.readInbox(run.id);
        return {
            text: rows.length
                ? rows
                      .map((row) => `${row.id}  ${row.kind}  task ${row.taskId ?? "-"}\n    ${row.body}`)
                      .join("\n")
                : "Nothing new.",
            structured: { messages: rows }
        };
    }
};

const answerInput = z.object({
    runId,
    messageId: z.string().uuid().describe("The question's id, from orchestration_inbox."),
    answer: z.string().trim().min(1).max(20_000)
});

const answerTool: McpTool<z.infer<typeof answerInput>> = {
    name: "orchestration_answer",
    // i18n-ignore shown by the calling client, which has no locale to ask for
    title: "Answer a worker",
    description:
        // i18n-ignore read by the calling model, not shown to a person
        "Answer a worker's question or escalation. The answer goes into that worker's prompt.",
    input: answerInput,
    category: "development",
    scope: "agents.coordinate",
    readOnly: false,
    destructive: false,
    async run(input, caller) {
        const run = await coordinatedRun(caller, input.runId);
        await refusing(() => orchestration.answer(run.id, input.messageId, input.answer));
        return { text: "Answered." };
    }
};

const messageInput = z.object({
    runId,
    taskId: z.string().uuid(),
    text: z.string().trim().min(1).max(20_000)
});

const messageTool: McpTool<z.infer<typeof messageInput>> = {
    name: "orchestration_message",
    // i18n-ignore shown by the calling client, which has no locale to ask for
    title: "Message a worker",
    description:
        // i18n-ignore read by the calling model, not shown to a person
        "Send the worker on a task of your run a follow-up. It goes into the worker's prompt as written.",
    input: messageInput,
    category: "development",
    scope: "agents.coordinate",
    readOnly: false,
    destructive: false,
    async run(input, caller) {
        const run = await coordinatedRun(caller, input.runId);
        await refusing(() => orchestration.messageWorker(run.id, input.taskId, input.text));
        return { text: "Sent." };
    }
};

const reportInput = z.object({
    taskId: z.string().uuid().describe("Your task's id, from the start of your prompt."),
    kind: z.enum(["worker_done", "question", "escalation"]),
    outcome: z
        .enum(["succeeded", "failed"])
        .optional()
        .describe("Required with worker_done."),
    body: z
        .string()
        .trim()
        .min(1)
        .max(20_000)
        .describe("What you did, found and left; or the question.")
});

const reportTool: McpTool<z.infer<typeof reportInput>> = {
    name: "orchestration_report",
    // i18n-ignore shown by the calling client, which has no locale to ask for
    title: "Report on an orchestration task",
    description:
        // i18n-ignore read by the calling model, not shown to a person
        "Tell the coordinator you finished your task (worker_done, once, with an outcome), need a decision (question), or found something a person must see (escalation).",
    input: reportInput,
    category: "development",
    scope: "agents.report",
    readOnly: false,
    destructive: false,
    async run(input, caller) {
        if (!caller.sessionId) {
            throw new McpRefusal("Only the session working on a task can report on it.");
        }
        if (input.kind === "worker_done" && !input.outcome) {
            throw new McpRefusal("worker_done needs an outcome: succeeded or failed.");
        }
        await refusing(() =>
            orchestration.report(
                caller.sessionId!,
                input.taskId,
                input.kind,
                input.body,
                input.outcome ?? null
            )
        );
        return { text: "Reported." };
    }
};

export const ORCHESTRATION_TOOLS = [
    createTaskTool,
    listTasksTool,
    inboxTool,
    answerTool,
    messageTool,
    reportTool
] as unknown as McpTool<never>[];
