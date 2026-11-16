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
import * as core from "@polaris/core";
import { McpRefusal, type McpTool } from "../protocol";
import * as runtime from "@/lib/agents/session-runtime";
import * as sessions from "@/lib/agents/session-service";
import { promptRefusal, startAgentSession } from "@/lib/agents/session-api";

const listInput = z.object({
    live: z.boolean().default(true).describe("Only sessions that have not ended.")
});

const listSessionsTool: McpTool<z.infer<typeof listInput>> = {
    name: "agent_sessions_list",
    // i18n-ignore shown by the calling client, which has no locale to ask for
    title: "List agent sessions",
    description:
        // i18n-ignore read by the calling model, not shown to a person
        "The coding-agent sessions this key can reach, and what each is doing. A session marked as needing somebody is blocked on a question.",
    input: listInput,
    category: "development",
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
    // i18n-ignore shown by the calling client, which has no locale to ask for
    title: "Read an agent session",
    description:
        // i18n-ignore read by the calling model, not shown to a person
        "What one session has been asked, what it has done, and whether it is waiting on anybody.",
    input: getInput,
    category: "development",
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
    // i18n-ignore shown by the calling client, which has no locale to ask for
    title: "Prompt an agent session",
    description:
        // i18n-ignore read by the calling model, not shown to a person
        "Send a running session the next thing, or the answer to what it asked. It goes into the agent's own prompt, so write it as you would say it.",
    input: promptInput,
    category: "development",
    scope: "agents.manage",
    readOnly: false,
    destructive: false,
    async run(input, caller) {
        const session = await sessions.getSession(input.sessionId, caller.userId);
        if (!session) throw new McpRefusal("No session with that id that this key can reach.");
        if (session.id === caller.sessionId)
            throw new McpRefusal("That is this session. Send it to another one.");
        const refused = promptRefusal(session);
        if (refused) throw new McpRefusal(refused);
        const sender = caller.sessionId
            ? await sessions.getSession(caller.sessionId, caller.userId)
            : null;
        const text = sender ? fromSession(sender, input.text) : input.text;
        await sessions.addSessionMessage(session.id, "user", text, caller.userId);
        await runtime.promptSession(session.id, text);
        return { text: "Sent." };
    }
};

/**
 * A message one agent sends another, as the receiving agent reads it.
 *
 * Says who sent it and how to answer, because the receiver has no other way to
 * know the prompt came from an agent rather than from its person, or where a
 * reply should go: an answer is just another `agent_session_prompt`, back.
 */
export function fromSession(sender: { id: string; title: string }, text: string): string {
    return `[Message from the agent session "${sender.title}" (${sender.id}). To reply, call agent_session_prompt with sessionId ${sender.id}.]\n\n${text}`;
}

const startInput = z.object({
    repo: z
        .string()
        .trim()
        .max(140)
        .default("")
        .describe(
            'The repository, as "owner/name". Empty starts it where the calling session works: the same repository, or the same workspace directory.'
        ),
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
    // i18n-ignore shown by the calling client, which has no locale to ask for
    title: "Start an agent session",
    description:
        // i18n-ignore read by the calling model, not shown to a person
        "Put another coding agent on a piece of work, in its own branch or beside you in the same workspace. Use this to hand off something separable from what you are doing - not to split the work you were asked to do yourself.",
    input: startInput,
    category: "development",
    scope: "agents.manage",
    readOnly: false,
    destructive: false,
    async run(input, caller) {
        let started: Awaited<ReturnType<typeof startAgentSession>>;
        try {
            started = await startAgentSession(caller, input);
        } catch (error) {
            if (error instanceof sessions.SessionRefusal) throw new McpRefusal(error.message);
            throw error;
        }
        const { session, queuedAt } = started;
        if (queuedAt !== null) {
            return {
                text: `Queued ${session.id} on ${session.branch}: every slot is taken, and it is number ${queuedAt} in line. It starts by itself when one frees, and gets the prompt then.`,
                structured: { id: session.id, branch: session.branch, queuedAt }
            };
        }
        return {
            text: `Started ${session.id} on ${session.branch}. It gets the prompt as soon as it is up; check on it with agent_session_get.`,
            structured: { id: session.id, branch: session.branch, queuedAt: null }
        };
    }
};

export const SESSION_TOOLS = [
    listSessionsTool,
    getSessionTool,
    promptSessionTool,
    startSessionTool
] as unknown as McpTool<never>[];
