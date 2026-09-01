/**
 * What may be asked of a live agent session, from a screen, from the API, or from
 * the session itself reporting in.
 *
 * Three different callers cross this boundary and none of them is trusted the
 * same way. A person in the dashboard starts a session and steers it. A key
 * holder does the same over the API, which is how an agent already running gets
 * to start another one. And the machine a session runs on posts back what its
 * agent is doing, which is text from a program that is reading somebody's
 * repository - the least trusted of the three, and the one with the tightest
 * bounds below.
 */

import { z } from "zod";
import { ENIGMA_SCOPES } from "../enigma.js";
import { AGENT_GATE_MODES } from "../agents.js";
import { CUSTOM_AGENT_CLI, isKnownAgentCli } from "../agent-clis.js";
import { AGENT_SESSION_EVENTS, AGENT_SESSION_PLACES } from "../agent-sessions.js";

export const agentSessionPlaceSchema = z.enum(AGENT_SESSION_PLACES);
export const agentSessionEventKindSchema = z.enum(AGENT_SESSION_EVENTS);

/** The id of a catalogued tool, or `custom` for one the operator named. */
export const agentCliIdSchema = z
    .string()
    .trim()
    .min(1, "Pick an agent")
    .max(40)
    .refine(isKnownAgentCli, "Not an agent Polaris knows");

/**
 * A command an operator supplied themselves.
 *
 * Deliberately permissive about what the command IS - the whole point of the
 * custom entry is that Polaris has not heard of it - and deliberately strict
 * about what it may contain. It is run as an argument vector rather than through
 * a shell, so shell metacharacters would not be interpreted anyway; they are
 * refused regardless, because a command carrying them is far more likely to be
 * somebody expecting a shell than somebody who meant it.
 */
export const customAgentCommandSchema = z
    .string()
    .trim()
    .min(1, "Enter the command that starts the agent")
    .max(200)
    .regex(/^[A-Za-z0-9][A-Za-z0-9 ._@/:=-]*$/, "Only a command and plain arguments");

/**
 * How Enigma is set up for whatever is being saved. Every field optional and
 * nullable on purpose: absent is "leave what was there", null is "inherit".
 */
export const enigmaSettingsSchema = z.object({
    enabled: z.boolean().nullable().default(null),
    scope: z.enum(ENIGMA_SCOPES).nullable().default(null),
    gate: z.enum(AGENT_GATE_MODES).nullable().default(null),
    version: z.string().trim().max(40).nullable().default(null),
    /** Bounded on both sides. These become a command line on a machine, and a
     *  thousand of them would be a thousand processes before the agent starts. */
    config: z
        .record(z.string().trim().min(1).max(60), z.string().trim().max(200))
        .refine((value) => Object.keys(value).length <= 40, "Too many settings")
        .nullable()
        .default(null)
});

/**
 * Starting a session.
 *
 * `repoId` names a repository already registered with the Agents app, which is
 * what carries the GitHub installation the checkout needs - a session does not
 * get to name an arbitrary URL to clone, because the credential that would clone
 * it is the instance's rather than the caller's.
 *
 * `prompt` is optional. A session with one starts working immediately, which is
 * what "assign this task to an agent" means; a session without one comes up idle
 * at its prompt, which is what "open me a Claude on this branch" means. Both are
 * ordinary, so neither is the special case.
 */
export const startAgentSessionSchema = z
    .object({
        /**
         * The repository it works in, or null to open a workspace.
         *
         * Null is somebody asking for an agent on a machine of their own with
         * nothing checked out - no task, no repository, no branch. It is what a
         * person does on their own laptop, and it was the one shape this could
         * not express.
         */
        repoId: z.string().uuid().nullable().default(null),
        title: z.string().trim().min(1, "Give the session a name").max(80),
        cli: agentCliIdSchema,
        command: customAgentCommandSchema.optional(),
        place: agentSessionPlaceSchema.default("local"),
        /** The enrolled server, for `host`. Checked against the place below. */
        hostId: z.string().uuid().nullable().default(null),
        /** What the worktree branches from. Empty takes the repository's default. */
        baseRef: z
            .string()
            .trim()
            .max(200)
            .regex(/^[A-Za-z0-9._\/-]*$/, "Not a branch name")
            .default(""),
        prompt: z.string().trim().max(20_000).default(""),
        /** The task this session is doing, when it was started from one. */
        taskId: z.string().uuid().nullable().default(null),
        /**
         * Whether the agent may run commands without asking.
         *
         * Null means "nobody said", and what that resolves to depends on where
         * the session runs - a container Polaris made is a sandbox, somebody's
         * own server is their machine. See `agentRunsUnattended`.
         */
        unattended: z.boolean().nullable().default(null),
        /**
         * Which stored account signs the agent in.
         *
         * Null takes whatever would resolve - the first of their own that works,
         * then the deployment's - which is what a session started before the
         * picker offered a choice does.
         */
        accountId: z.string().uuid().nullable().default(null),
        /**
         * Sign it in with nothing, and let the machine's own login answer.
         *
         * Not the same as a null `accountId`, which is "whichever of mine
         * resolves". This is "none of them": the machine is signed in already,
         * in the home that outlives the session, and a stored token injected
         * over that is how a credential revoked months ago comes to beat a
         * login that works.
         */
        useMachineLogin: z.boolean().default(false),
        /**
         * Whether it opens on the machine everybody shares rather than on this
         * account's own.
         *
         * Only ever true when an administrator has turned that on, which the
         * server checks - a form cannot talk its way onto a machine holding
         * other people's logins.
         */
        sharedHome: z.boolean().default(false),
        enigma: enigmaSettingsSchema.optional()
    })
    .refine((value) => value.cli !== CUSTOM_AGENT_CLI || Boolean(value.command), {
        message: "Enter the command that starts the agent",
        path: ["command"]
    })
    .refine((value) => value.place !== "host" || Boolean(value.hostId), {
        message: "Pick the server it runs on",
        path: ["hostId"]
    })
    // A branch is a thing a checkout has. Asking for one without a repository is
    // a form filled in wrong rather than a value to quietly drop, and dropping it
    // would be a session that started somewhere the person did not mean.
    .refine((value) => Boolean(value.repoId) || !value.baseRef, {
        message: "A workspace has nothing checked out, so it starts from no branch",
        path: ["baseRef"]
    })
    // Same reasoning, and it matters more: a task is work in a repository, and a
    // session with no checkout cannot do it.
    .refine((value) => Boolean(value.repoId) || !value.taskId, {
        message: "Pick the repository this task's work happens in",
        path: ["repoId"]
    })
    // The shared machine is one of Polaris's own containers. An enrolled server
    // is already somebody's machine with its own home, so asking for both is
    // asking for two different things at once.
    // Picking an account and asking for none of them are two different answers
    // to one question, and a form that sent both would have the server choose.
    .refine((value) => !value.useMachineLogin || !value.accountId, {
        message: "Pick an account or the machine's own login, not both",
        path: ["accountId"]
    })
    .refine((value) => !value.sharedHome || value.place === "local", {
        message: "A server already has a home of its own",
        path: ["sharedHome"]
    });

export type StartAgentSessionInput = z.infer<typeof startAgentSessionSchema>;

/**
 * Sending a session something.
 *
 * The ceiling is the same as a starting prompt because a follow-up is routinely
 * the larger of the two - a stack trace, a diff, the output somebody pasted - and
 * a limit that only the second message hits is a limit that will be discovered at
 * the worst moment.
 */
export const agentSessionPromptSchema = z.object({
    sessionId: z.string().uuid(),
    text: z.string().trim().min(1, "Say something").max(20_000)
});

export type AgentSessionPromptInput = z.infer<typeof agentSessionPromptSchema>;

/**
 * What a machine posts back when its agent did something.
 *
 * The bounds here are the tight ones. `detail` is a line of text from a program
 * running against a repository, so it is truncated rather than rejected - an
 * event that arrived is worth keeping even when its description is a megabyte of
 * somebody's log - and the batch is capped so one machine cannot spend the
 * instance's database on a loop.
 */
export const agentSessionEventSchema = z.object({
    kind: agentSessionEventKindSchema,
    detail: z.string().max(2_000).default(""),
    /** The tool or subagent the event is about, where the event has one. */
    subject: z.string().max(200).default("")
});

export const agentSessionEventBatchSchema = z.object({
    events: z.array(agentSessionEventSchema).min(1).max(50)
});

export type AgentSessionEventInput = z.infer<typeof agentSessionEventSchema>;
