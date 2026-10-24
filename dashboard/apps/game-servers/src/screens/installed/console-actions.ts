"use server";

/**
 * The console's own actions, for every game rather than one.
 *
 * The console is a single screen with two languages underneath it, and what it can
 * do besides send a line - keep a command, drop one - is the same on both. Its own
 * module because it is its own concern, and because the panel that renders it does
 * not know which game it is looking at.
 *
 * Gated on `games.console`, the same grant sending a line needs: a kept command is
 * a button that runs one, so being able to add one is the same power. Writes are
 * recorded, because a list of commands a server is run with is part of how that
 * server was administered.
 */

import { z } from "zod";
import { gameWords, issueText, messageText } from "../game-words";
import { randomUUID } from "node:crypto";
import {
    addConsoleSchedule,
    deleteConsoleCommand,
    readConsoleCommands,
    readConsoleSchedulesOf,
    removeConsoleSchedule,
    saveConsoleCommand
} from "../../lib/console-command-service";
import {
    CUSTOM_VARIABLE_TYPES,
    MAX_CUSTOM_VARIABLES,
    MAX_VARIABLE_LABEL,
    MAX_VARIABLE_VALUE,
    commandVariables,
    customVariablesProblem,
    normalizeCustomVariable,
    runTargetSchema,
    valuesSchema,
    type CustomVariableType
} from "../../lib/console-vars";
import {
    repeatProblem,
    startAfter,
    startInSchema,
    startProblem,
    type ConsoleSchedule,
    type ScheduleRepeat
} from "../../lib/console-schedule";
import { keptCommandSteps, keptRunProblem, runKeptCommand } from "../../lib/console-run-service";
import {
    MAX_SAVED_LABEL,
    MAX_SAVED_SEQUENCE,
    hasPauses,
    normalizeCommandText,
    normalizeSavedCommand,
    savedCommandProblem,
    type SavedCommand
} from "../../lib/console-commands";
import { MAX_CONSOLE_LINE, type QueueStep } from "../../lib/console-queue";
import { repeatPlanSchema, type ConsoleRepeatView, type RepeatPlan } from "../../lib/console-repeat";
import { listRepeats, stopRepeat } from "../../lib/console-repeat-jobs";
import { startConsoleRepeat } from "../../lib/console-repeat-service";
import { gameMessage } from "../../lib/game-message";
import { host } from "@polaris/app-host";

const { recordAudit } = host.auditService;
const { rateLimit } = host.rateLimitService;
const { requireGameServer } = host.appsInstallAccess;

const saveSchema = z.object({
    installedAppId: z.string().uuid(),
    /** Absent for a new one; present when an existing one is being rewritten. */
    id: z.string().uuid().optional(),
    label: z.string().trim().max(MAX_SAVED_LABEL).optional(),
    /** One line, or a sequence of them; every line trimmed and the empty ones
     *  dropped before it is checked. The raw text may carry the blank lines it
     *  loses, hence the looser ceiling on what is read. */
    command: z
        .string()
        .max(MAX_SAVED_SEQUENCE * 2)
        .transform(normalizeCommandText)
        .superRefine((command, context) => {
            const problem = savedCommandProblem(command);
            if (problem) context.addIssue({ code: z.ZodIssueCode.custom, message: problem });
        }),
    variables: z
        .array(
            z.object({
                name: z.string().max(40),
                label: z
                    .string()
                    .max(MAX_VARIABLE_LABEL * 2)
                    .optional(),
                type: z.enum(
                    CUSTOM_VARIABLE_TYPES as [CustomVariableType, ...CustomVariableType[]]
                ),
                initial: z
                    .string()
                    .max(MAX_VARIABLE_VALUE * 4)
                    .optional()
            })
        )
        .max(MAX_CUSTOM_VARIABLES)
        .optional()
});

export type SaveConsoleCommandInput = z.infer<typeof saveSchema>;

/** What this server keeps. Empty rather than an error for somebody who may not
 *  see it: the console draws with or without them. */
export async function listConsoleCommandsAction(
    installedAppId: string
): Promise<{ commands: SavedCommand[] }> {
    const parsed = z.string().uuid().safeParse(installedAppId);
    if (!parsed.success) return { commands: [] };
    try {
        await requireGameServer("games.console", parsed.data);
        return { commands: await readConsoleCommands(parsed.data) };
    } catch {
        return { commands: [] };
    }
}

export async function saveConsoleCommandAction(
    input: SaveConsoleCommandInput
): Promise<{ commands?: SavedCommand[]; error?: string }> {
    const parsed = saveSchema.safeParse(input);
    if (!parsed.success)
        return {
            error:
                (await issueText(parsed.error.issues[0]?.message)) ??
                (await gameWords("games"))("errors.checkTheCommandAndTry")
        };
    const variables = (parsed.data.variables ?? []).map(normalizeCustomVariable);
    const problem = customVariablesProblem(parsed.data.command, variables);
    if (problem) return { error: await messageText(problem) };
    const entry = normalizeSavedCommand({
        id: parsed.data.id ?? randomUUID(),
        label: parsed.data.label ?? null,
        command: parsed.data.command,
        variables
    });
    if (!entry) return { error: (await gameWords("games"))("errors.thatCommandCannotBeKept") };
    try {
        const { user } = await requireGameServer("games.console", parsed.data.installedAppId);
        const commands = await saveConsoleCommand(parsed.data.installedAppId, entry);
        await recordAudit({
            actorId: user.id,
            action: "games.console.save",
            targetType: "installedApp",
            targetId: parsed.data.installedAppId,
            metadata: {
                label: entry.label,
                command: entry.command,
                variables: (entry.variables ?? []).map((declared) => declared.name)
            }
        });
        return { commands };
    } catch (caught) {
        return {
            error:
                caught instanceof Error
                    ? await messageText(caught.message)
                    : (await gameWords("games"))("errors.thatCommandCouldNotBe")
        };
    }
}

export async function deleteConsoleCommandAction(
    installedAppId: string,
    id: string
): Promise<{ commands?: SavedCommand[]; error?: string }> {
    const parsed = z
        .object({ installedAppId: z.string().uuid(), id: z.string().min(1).max(64) })
        .safeParse({
            installedAppId,
            id
        });
    if (!parsed.success)
        return { error: (await gameWords("games"))("errors.thatCommandCouldNotBe2") };
    try {
        const { user } = await requireGameServer("games.console", parsed.data.installedAppId);
        const commands = await deleteConsoleCommand(parsed.data.installedAppId, parsed.data.id);
        await recordAudit({
            actorId: user.id,
            action: "games.console.forget",
            targetType: "installedApp",
            targetId: parsed.data.installedAppId,
            metadata: { id: parsed.data.id }
        });
        return { commands };
    } catch (caught) {
        return {
            error:
                caught instanceof Error
                    ? await messageText(caught.message)
                    : (await gameWords("games"))("errors.thatCommandCouldNotBe2")
        };
    }
}

const runSchema = z.object({
    installedAppId: z.string().uuid(),
    id: z.string().min(1).max(64),
    /** Checked against the command's own declared variables once it is read. */
    values: z.record(z.string(), z.unknown()).default({}),
    target: runTargetSchema.nullable().default(null)
});

export type RunKeptCommandInput = z.input<typeof runSchema>;

/** One reply per line the run sent. */
export interface KeptReply {
    readonly line: string;
    readonly output: string;
    readonly failed: boolean;
}

/** The kept command, its values checked against what it declares, and the
 *  standing to run it - shared by running now and scheduling. */
async function keptRun(input: RunKeptCommandInput) {
    const words = await gameWords("games");
    const parsed = runSchema.safeParse(input);
    if (!parsed.success) {
        return {
            error:
                (await issueText(parsed.error.issues[0]?.message)) ??
                words("errors.checkTheCommandAndTry")
        } as const;
    }
    const { user, access } = await requireGameServer("games.console", parsed.data.installedAppId);
    const entry = (await readConsoleCommands(parsed.data.installedAppId)).find(
        (kept) => kept.id === parsed.data.id
    );
    if (!entry) return { error: words("errors.thatCommandCouldNotBe2") } as const;
    const variables = entry.variables ?? [];
    // Asked for: the declared ones and the ones the command declares itself,
    // each left empty taking its default.
    const asked = commandVariables(entry.command, variables).custom;
    const values = valuesSchema(asked).safeParse(parsed.data.values);
    if (!values.success) {
        const issue = values.error.issues[0];
        const name = typeof issue?.path[0] === "string" ? issue.path[0] : "";
        const label = asked.find((declared) => declared.name === name)?.label ?? name;
        const why = (await issueText(issue?.message)) ?? words("errors.checkTheCommandAndTry");
        return { error: label ? `${label}: ${why}` : why } as const;
    }
    const run = {
        command: entry.command,
        variables,
        values: values.data,
        target: parsed.data.target
    };
    const problem = keptRunProblem(access, run);
    if (problem) return { error: await messageText(problem) } as const;
    return { user, access, entry, run } as const;
}

/** Run a kept command that carries variables, with the values the person gave. */
export async function runKeptCommandAction(
    input: RunKeptCommandInput
): Promise<{ replies?: KeptReply[]; error?: string }> {
    try {
        const resolved = await keptRun(input);
        if ("error" in resolved) return { error: resolved.error };
        const replies = await runKeptCommand(resolved.user.id, resolved.access, resolved.run);
        return {
            replies: await Promise.all(
                replies.map(async (reply) => ({
                    ...reply,
                    output: await messageText(reply.output)
                }))
            )
        };
    } catch (caught) {
        return {
            error:
                caught instanceof Error
                    ? await messageText(caught.message)
                    : (await gameWords("games"))("errors.thatCommandCouldNotBe")
        };
    }
}

/**
 * A kept sequence, its variables filled in by the server, handed back for the
 * console to run: each command then goes through the console's own send, with
 * its permission and audit line, and its pauses are kept where they can be
 * watched and stopped. Sends nothing itself.
 */
export async function keptStepsAction(
    input: RunKeptCommandInput
): Promise<{ steps?: QueueStep[]; error?: string }> {
    try {
        const resolved = await keptRun(input);
        if ("error" in resolved) return { error: resolved.error };
        return { steps: await keptCommandSteps(resolved.access, resolved.run) };
    } catch (caught) {
        return {
            error:
                caught instanceof Error
                    ? await messageText(caught.message)
                    : (await gameWords("games"))("errors.thatCommandCouldNotBe")
        };
    }
}

const repeatSchema = z.discriminatedUnion("kind", [
    z.object({ kind: z.literal("once") }).strict(),
    z.object({ kind: z.literal("every"), minutes: z.number().int() }).strict(),
    z
        .object({ kind: z.literal("times"), minutes: z.number().int(), times: z.number().int() })
        .strict()
]);

const scheduleSchema = z.object({
    /** When it first runs, ISO; absent for now. */
    firstAt: z.string().datetime({ offset: true }).optional(),
    /** Or how long from now, counted on this clock rather than the browser's;
     *  takes the place of `firstAt` when both come. */
    startIn: startInSchema.optional(),
    repeat: repeatSchema
});

export type ScheduleKeptCommandInput = RunKeptCommandInput & z.input<typeof scheduleSchema>;

/** Schedule a kept command, its values fixed now, to be run by the minute sweep. */
export async function scheduleKeptCommandAction(
    input: ScheduleKeptCommandInput
): Promise<{ schedules?: ConsoleSchedule[]; error?: string }> {
    const words = await gameWords("games");
    const when = scheduleSchema.safeParse({
        firstAt: input.firstAt,
        startIn: input.startIn,
        repeat: input.repeat
    });
    if (!when.success) {
        return {
            error:
                (await issueText(when.error.issues[0]?.message)) ??
                words("errors.checkTheCommandAndTry")
        };
    }
    const repeat: ScheduleRepeat = when.data.repeat;
    const now = new Date();
    const firstAt = when.data.startIn
        ? startAfter(when.data.startIn, now)
        : when.data.firstAt
          ? new Date(when.data.firstAt)
          : now;
    const problem = repeatProblem(repeat) ?? startProblem(firstAt, now);
    if (problem) return { error: await messageText(problem) };
    try {
        const resolved = await keptRun(input);
        if ("error" in resolved) return { error: resolved.error };
        // The sweep runs a schedule in one go; a pause is only kept by the console.
        if (hasPauses(resolved.entry.command)) {
            return { error: await messageText(gameMessage("games", "lib.pausesOnlyLive")) };
        }
        const schedule: ConsoleSchedule = {
            id: randomUUID(),
            commandId: resolved.entry.id,
            label: resolved.entry.label,
            ...resolved.run,
            repeat,
            nextAt: new Date(Math.max(firstAt.getTime(), now.getTime())).toISOString(),
            done: 0,
            skipped: 0,
            last: null,
            createdBy: resolved.user.id
        };
        const schedules = await addConsoleSchedule(resolved.access.install.id, schedule);
        await recordAudit({
            actorId: resolved.user.id,
            action: "games.console.schedule",
            targetType: "installedApp",
            targetId: resolved.access.install.id,
            metadata: { command: schedule.command, repeat, firstAt: schedule.nextAt }
        });
        return { schedules };
    } catch (caught) {
        return {
            error:
                caught instanceof Error
                    ? await messageText(caught.message)
                    : words("errors.thatCommandCouldNotBe")
        };
    }
}

/** This server's scheduled commands. Empty for somebody who may not see them. */
export async function listConsoleSchedulesAction(
    installedAppId: string
): Promise<{ schedules: ConsoleSchedule[] }> {
    const parsed = z.string().uuid().safeParse(installedAppId);
    if (!parsed.success) return { schedules: [] };
    try {
        await requireGameServer("games.console", parsed.data);
        return { schedules: await readConsoleSchedulesOf(parsed.data) };
    } catch {
        return { schedules: [] };
    }
}

/** Stop a schedule, or clear one that has finished. */
export async function removeConsoleScheduleAction(
    installedAppId: string,
    id: string
): Promise<{ schedules?: ConsoleSchedule[]; error?: string }> {
    const words = await gameWords("games");
    const parsed = z
        .object({ installedAppId: z.string().uuid(), id: z.string().uuid() })
        .safeParse({ installedAppId, id });
    if (!parsed.success) return { error: words("errors.thatCommandCouldNotBe2") };
    try {
        const { user } = await requireGameServer("games.console", parsed.data.installedAppId);
        const schedules = await removeConsoleSchedule(parsed.data.installedAppId, parsed.data.id);
        await recordAudit({
            actorId: user.id,
            action: "games.console.unschedule",
            targetType: "installedApp",
            targetId: parsed.data.installedAppId,
            metadata: { id: parsed.data.id }
        });
        return { schedules };
    } catch (caught) {
        return {
            error:
                caught instanceof Error
                    ? await messageText(caught.message)
                    : words("errors.thatCommandCouldNotBe2")
        };
    }
}

// ------------------------------------------------------------------ repeats

/** Repeats one person may start in a minute, on top of the per-server cap. */
const REPEAT_STARTS_PER_MINUTE = 10;

const repeatLineSchema = z.object({
    installedAppId: z.string().uuid(),
    line: z.string().trim().min(1).max(MAX_CONSOLE_LINE),
    repeat: repeatPlanSchema
});

export type RepeatConsoleLineInput = z.input<typeof repeatLineSchema>;
export type RepeatKeptCommandInput = RunKeptCommandInput & { repeat: RepeatPlan };

/** The carried refusal for a person starting repeats faster than anybody would
 *  by hand, or null. */
async function tooFast(userId: string): Promise<string | null> {
    const allowed = await rateLimit(
        `games-console-repeat:${userId}`,
        REPEAT_STARTS_PER_MINUTE,
        60_000
    ).catch(() => ({ ok: true }));
    return allowed.ok ? null : gameMessage("games", "consoleRepeat.errors.slowDown");
}

async function repeatAudit(
    userId: string,
    installedAppId: string,
    command: string,
    repeat: RepeatPlan
): Promise<void> {
    await recordAudit({
        actorId: userId,
        action: "games.console.repeat",
        targetType: "installedApp",
        targetId: installedAppId,
        metadata: { command, times: repeat.times, every: repeat.every, unit: repeat.unit }
    });
}

/** Run a line typed in the console several times, with a gap between runs. It
 *  runs here, on the server: closing the page does not stop it. */
export async function repeatConsoleLineAction(
    input: RepeatConsoleLineInput
): Promise<{ repeats?: ConsoleRepeatView[]; error?: string }> {
    const words = await gameWords("games");
    const parsed = repeatLineSchema.safeParse(input);
    if (!parsed.success) {
        return {
            error:
                (await issueText(parsed.error.issues[0]?.message)) ??
                words("errors.checkTheCommandAndTry")
        };
    }
    try {
        const { user, access } = await requireGameServer(
            "games.console",
            parsed.data.installedAppId
        );
        const slow = await tooFast(user.id);
        if (slow) return { error: await messageText(slow) };
        const line = parsed.data.line;
        await startConsoleRepeat({
            actor: user,
            server: access,
            label: line,
            command: line,
            plan: parsed.data.repeat,
            steps: async () => [{ kind: "command", line }]
        });
        await repeatAudit(user.id, access.install.id, line, parsed.data.repeat);
        return { repeats: listRepeats(access.install.id) };
    } catch (caught) {
        return {
            error:
                caught instanceof Error
                    ? await messageText(caught.message)
                    : words("errors.thatCommandCouldNotBe")
        };
    }
}

/** Run a kept command several times. Its values are fixed now; who "every
 *  player online" is, is worked out again on every run. */
export async function repeatKeptCommandAction(
    input: RepeatKeptCommandInput
): Promise<{ repeats?: ConsoleRepeatView[]; error?: string }> {
    const words = await gameWords("games");
    const repeat = repeatPlanSchema.safeParse(input.repeat);
    if (!repeat.success) {
        return {
            error:
                (await issueText(repeat.error.issues[0]?.message)) ??
                words("errors.checkTheCommandAndTry")
        };
    }
    try {
        const resolved = await keptRun(input);
        if ("error" in resolved) return { error: resolved.error };
        const { user, access, entry, run } = resolved;
        const slow = await tooFast(user.id);
        if (slow) return { error: await messageText(slow) };
        await startConsoleRepeat({
            actor: user,
            server: access,
            label: entry.label,
            command: entry.command,
            plan: repeat.data,
            steps: () => keptCommandSteps(access, run)
        });
        await repeatAudit(user.id, access.install.id, entry.command, repeat.data);
        return { repeats: listRepeats(access.install.id) };
    } catch (caught) {
        return {
            error:
                caught instanceof Error
                    ? await messageText(caught.message)
                    : words("errors.thatCommandCouldNotBe")
        };
    }
}

/** The repeats on this server, whoever started them. Empty for somebody who may
 *  not use its console. */
export async function listConsoleRepeatsAction(
    installedAppId: string
): Promise<{ repeats: ConsoleRepeatView[] }> {
    const parsed = z.string().uuid().safeParse(installedAppId);
    if (!parsed.success) return { repeats: [] };
    try {
        await requireGameServer("games.console", parsed.data);
        return { repeats: listRepeats(parsed.data) };
    } catch {
        return { repeats: [] };
    }
}

/** Stop a repeat, whoever started it: anybody with this server's console. */
export async function stopConsoleRepeatAction(
    installedAppId: string,
    id: string
): Promise<{ repeats?: ConsoleRepeatView[]; error?: string }> {
    const words = await gameWords("games");
    const parsed = z
        .object({ installedAppId: z.string().uuid(), id: z.string().uuid() })
        .safeParse({ installedAppId, id });
    if (!parsed.success) return { error: words("consoleRepeat.stopFailed") };
    try {
        const { user } = await requireGameServer("games.console", parsed.data.installedAppId);
        if (stopRepeat(parsed.data.installedAppId, parsed.data.id)) {
            await recordAudit({
                actorId: user.id,
                action: "games.console.repeat.stop",
                targetType: "installedApp",
                targetId: parsed.data.installedAppId,
                metadata: { id: parsed.data.id }
            });
        }
        // Already over is what was asked for: the list says how it ended.
        return { repeats: listRepeats(parsed.data.installedAppId) };
    } catch (caught) {
        return {
            error:
                caught instanceof Error
                    ? await messageText(caught.message)
                    : words("consoleRepeat.stopFailed")
        };
    }
}
