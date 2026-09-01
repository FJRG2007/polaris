/**
 * Agent sessions, as tools an agent can call.
 *
 * This is the half that makes remote control mean something. An agent already
 * working can look at what else is running, hand a piece of work it should not do
 * itself to a session of its own, and send a running one the answer to the
 * question it asked. A person can do the same from a phone through any MCP
 * client, which is the same thing arriving by a different door.
 *
 * Deliberately not offered: reading a session's raw terminal. It is a picture
 * rather than a transcript - a full-screen program repaints - and handing a model
 * a screenful of redraw would spend its context on nothing. What a session is
 * doing is in its events, which is what `agent_session_get` returns.
 */

import { z } from "zod";
import { prisma } from "@polaris/db";
import { after } from "next/server";
import * as core from "@polaris/core";
import { McpRefusal, type McpTool } from "../protocol";
import * as runtime from "@/lib/agents/session-runtime";
import * as sessions from "@/lib/agents/session-service";

const listInput = z.object({
    live: z.boolean().default(true).describe("Only sessions that have not ended.")
});

const listSessionsTool: McpTool<z.infer<typeof listInput>> = {
    name: "agent_sessions_list",
    description:
        "The coding-agent sessions this key can reach, and what each is doing. A session marked as needing somebody is blocked on a question.",
    input: listInput,
    scope: "agents.read",
    readOnly: true,
    async run(input, caller) {
        const rows = await sessions.listSessions(caller.userId, { live: input.live });
        if (rows.length === 0) return { text: "No sessions.", structured: { sessions: [] } };
        return {
            text: rows
                .map(
                    (row) =>
                        `${row.id}  ${row.title}  [${core.AGENT_SESSION_STATE_LABELS[row.state]}]  ${row.repoFullName}`
                )
                .join("\n"),
            structured: {
                sessions: rows.map((row) => ({
                    id: row.id,
                    title: row.title,
                    state: row.state,
                    repo: row.repoFullName,
                    branch: row.branch,
                    doing: row.detail
                }))
            }
        };
    }
};

const getInput = z.object({ sessionId: z.string().uuid() });

const getSessionTool: McpTool<z.infer<typeof getInput>> = {
    name: "agent_session_get",
    description:
        "What one session has been asked, what it has done, and whether it is waiting on anybody.",
    input: getInput,
    scope: "agents.read",
    readOnly: true,
    async run(input, caller) {
        const session = await sessions.getSession(input.sessionId, caller.userId);
        if (!session) throw new McpRefusal("No session with that id that this key can reach.");
        const [events, messages] = await Promise.all([
            sessions.sessionEvents(session.id, 40),
            sessions.sessionMessages(session.id, 20)
        ]);
        const body = [
            `${session.title} - ${core.AGENT_SESSION_STATE_LABELS[session.state]}`,
            `${session.repoFullName} on ${session.branch}`,
            session.detail ? `Last: ${session.detail}` : "",
            session.error ? `Error: ${session.error}` : "",
            "",
            ...messages.map((message) => `${message.role}: ${message.body}`),
            "",
            ...events.slice(-20).map((event) => `- ${event.kind} ${event.detail}`)
        ]
            .filter((line) => line !== "")
            .join("\n");
        return { text: body, structured: { session, events, messages } };
    }
};

const promptInput = z.object({
    sessionId: z.string().uuid(),
    text: z
        .string()
        .trim()
        .min(1)
        .max(20_000)
        .describe("What to say to it. Goes into its prompt as typed.")
});

const promptSessionTool: McpTool<z.infer<typeof promptInput>> = {
    name: "agent_session_prompt",
    description:
        "Send a running session the next thing, or the answer to what it asked. It goes into the agent's own prompt, so write it as you would say it.",
    input: promptInput,
    scope: "agents.manage",
    readOnly: false,
    async run(input, caller) {
        const session = await sessions.getSession(input.sessionId, caller.userId);
        if (!session) throw new McpRefusal("No session with that id that this key can reach.");
        if (core.isSessionOver(session.state)) throw new McpRefusal("That session has ended.");
        await sessions.addSessionMessage(session.id, "user", input.text, caller.userId);
        await runtime.promptSession(session.id, input.text);
        return { text: "Sent." };
    }
};

const startInput = z.object({
    repo: z.string().trim().min(3).max(140).describe('The repository, as "owner/name".'),
    title: z.string().trim().min(1).max(80).describe("What the session is for, in a few words."),
    prompt: z.string().trim().min(1).max(20_000).describe("What to ask it to do."),
    agent: core.agentCliIdSchema.default("claude"),
    baseRef: z
        .string()
        .trim()
        .max(200)
        .default("")
        .describe("Branch to start from. Empty takes the repository's default.")
});

const startSessionTool: McpTool<z.infer<typeof startInput>> = {
    name: "agent_session_start",
    description:
        "Put a coding agent on a piece of work in its own branch. Use this to hand off something separable from what you are doing - not to split the work you were asked to do yourself.",
    input: startInput,
    scope: "agents.manage",
    readOnly: false,
    async run(input, caller) {
        const repo = await prisma.agentRepo.findFirst({
            where: { ownerId: caller.userId, repoFullName: input.repo, enabled: true },
            select: { id: true }
        });
        if (!repo)
            throw new McpRefusal(
                `${input.repo} is not a repository the Agents app reaches for this key.`
            );

        const { session, token } = await sessions.createSession({
            repoId: repo.id,
            startedById: caller.userId,
            title: input.title,
            cli: input.agent,
            command: null,
            // Not the agent's to choose. A session started over MCP runs in a
            // container, where the default already applies; letting a tool call
            // ask for more would be an agent widening its own permissions.
            unattended: null,
            // Whichever resolves. Choosing between somebody's subscriptions is
            // not a thing to hand a model.
            accountId: null,
            // Always on the Polaris box. A session started by a model is not the
            // moment to be choosing somebody's server for them.
            place: "local",
            hostId: null,
            baseRef: input.baseRef,
            taskId: null,
            enigma: null
        });
        await runtime.startSession(session, token);
        await sessions.addSessionMessage(session.id, "user", input.prompt, caller.userId);
        // After the answer, not before it: the container is still cloning and
        // installing, and a model held for that would spend its turn waiting on
        // apt-get. The delivery waits for the agent's terminal and records what
        // happened on the session either way.
        after(() => runtime.deliverFirstPrompt(session.id, input.prompt));
        return {
            text: `Started ${session.id} on ${session.branch}. It gets the prompt as soon as it is up; check on it with agent_session_get.`,
            structured: { id: session.id, branch: session.branch }
        };
    }
};

export const SESSION_TOOLS = [
    listSessionsTool,
    getSessionTool,
    promptSessionTool,
    startSessionTool
] as unknown as McpTool<never>[];
