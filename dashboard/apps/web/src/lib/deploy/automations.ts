/**
 * A deploy project's automations: when something happens, do these things.
 *
 * A rule has one trigger - a cron schedule read in a time zone, a call to the
 * rule's own webhook, or an event the project already reports (a deploy
 * finishing, a domain going down or coming back) - and an ordered list of
 * actions on the project's services: redeploy, restart, run a command inside
 * the running container, or notify the people the project answers to.
 *
 * Actions run one after another and the first that fails stops the rest, which
 * are recorded as skipped: "migrate, then restart" must not restart onto a
 * migration that did not happen.
 *
 * A rule acts with the reach of the person who made it. Every run that nobody
 * pressed a button for - a schedule, an event, a webhook - checks first that
 * that person may still deploy every service it touches, so taking somebody off
 * a project also stops what they left running on it.
 *
 * Schedules are claimed by a compare-and-swap on `nextRunAt` and events by one on
 * `lastRunAt`, so two Polaris processes never start the same firing twice.
 */

import { prisma } from "@polaris/db";
import * as core from "@polaris/core";
import { runInService, type ServiceCommandFailure } from "./service-cron";
import { userHasPermission } from "@polaris/auth";
import { appBaseUrl } from "@/lib/domain-service";
import * as deployService from "@/lib/deploy-service";
import { notify } from "@/lib/notifications/dispatch";
import { wordsFor } from "@/lib/notifications/notice-words";
import { createHash, randomBytes, timingSafeEqual } from "node:crypto";
import {
    accessCan,
    accessInEnvironment,
    projectAccess,
    type ProjectAccess
} from "@/lib/deploy-project-access";

/** How many runs of one rule are kept; older ones go as new ones arrive. */
const KEPT_RUNS = 50;

/** The end of a command's output kept per step. The end is where the reason is. */
export const AUTOMATION_OUTPUT_LIMIT = 8 * 1024;

/** A run still marked running after this long is taken to have died with its
 *  process, and no longer holds the next firing back. */
const STALE_RUN_MS = 3 * 60 * 60 * 1000;

export type AutomationRunTrigger = "schedule" | "webhook" | "event" | "manual";

/** Why a run did nothing at all, when it did nothing. */
export type AutomationRunNote = "creator" | "busy" | "empty" | null;

/** Why one action did not succeed, as a code the screen and the notice word. */
export type AutomationStepReason = "gone" | "failed" | ServiceCommandFailure;

export const AUTOMATION_STEP_REASONS: readonly AutomationStepReason[] = [
    "gone",
    "failed",
    "notRunning",
    "unreachable",
    "timedOut",
    "exited",
    "notStarted"
];

/** One action of a run, as it went. */
export interface AutomationStep {
    readonly type: core.DeployAutomationActionType;
    readonly applicationId: string | null;
    readonly status: "succeeded" | "failed" | "timed_out" | "skipped";
    /** Why it did not succeed. */
    readonly reason: AutomationStepReason | null;
    /** A command's exit code and the end of what it printed. */
    readonly exitCode?: number | null;
    readonly output?: string;
    /** The deploy a redeploy started. */
    readonly deploymentId?: string;
}

export interface DeployAutomationView {
    readonly id: string;
    readonly name: string;
    readonly enabled: boolean;
    readonly trigger: core.DeployAutomationTrigger;
    readonly schedule: string | null;
    readonly scheduleText: string | null;
    readonly timezone: string;
    readonly event: core.DeployAutomationEvent | null;
    readonly eventApplicationId: string | null;
    readonly actions: core.DeployAutomationAction[];
    readonly hasWebhook: boolean;
    readonly nextRunAt: string | null;
    readonly lastRunAt: string | null;
    readonly lastStatus: string | null;
}

export interface DeployAutomationRunView {
    readonly id: string;
    readonly trigger: string;
    readonly status: string;
    readonly note: AutomationRunNote;
    readonly steps: AutomationStep[];
    readonly startedAt: string;
    readonly finishedAt: string | null;
}

/** A service a rule can act on, with where it lives. */
export interface AutomationServiceOption {
    readonly id: string;
    readonly name: string;
    readonly environmentId: string;
    readonly environmentName: string;
}

type AutomationRow = {
    id: string;
    name: string;
    enabled: boolean;
    trigger: string;
    schedule: string | null;
    timezone: string;
    event: string | null;
    eventApplicationId: string | null;
    webhookTokenHash: string | null;
    actions: string;
    nextRunAt: Date | null;
    lastRunAt: Date | null;
    lastStatus: string | null;
};

function isTrigger(value: string): value is core.DeployAutomationTrigger {
    return (core.DEPLOY_AUTOMATION_TRIGGERS as readonly string[]).includes(value);
}

function isEvent(value: string | null): value is core.DeployAutomationEvent {
    return value !== null && (core.DEPLOY_AUTOMATION_EVENTS as readonly string[]).includes(value);
}

function describeSchedule(schedule: string | null): string | null {
    if (!schedule) return null;
    try {
        return core.describeCron(schedule);
    } catch {
        return null;
    }
}

function toView(row: AutomationRow): DeployAutomationView {
    return {
        id: row.id,
        name: row.name,
        enabled: row.enabled,
        trigger: isTrigger(row.trigger) ? row.trigger : "schedule",
        schedule: row.schedule,
        scheduleText: describeSchedule(row.schedule),
        timezone: row.timezone,
        event: isEvent(row.event) ? row.event : null,
        eventApplicationId: row.eventApplicationId,
        actions: core.readAutomationActions(row.actions),
        hasWebhook: row.webhookTokenHash !== null,
        nextRunAt: row.nextRunAt?.toISOString() ?? null,
        lastRunAt: row.lastRunAt?.toISOString() ?? null,
        lastStatus: row.lastStatus
    };
}

/** The stored log, read back. A log older than this shape reads as no steps. */
export function readRunLog(stored: string): { note: AutomationRunNote; steps: AutomationStep[] } {
    try {
        const raw = JSON.parse(stored) as { note?: unknown; steps?: unknown };
        const note =
            raw.note === "creator" || raw.note === "busy" || raw.note === "empty" ? raw.note : null;
        const steps = Array.isArray(raw.steps) ? (raw.steps as AutomationStep[]) : [];
        return {
            note,
            steps: steps.map((step) => ({
                ...step,
                reason: AUTOMATION_STEP_REASONS.includes(step.reason as AutomationStepReason)
                    ? step.reason
                    : null
            }))
        };
    } catch {
        return { note: null, steps: [] };
    }
}

function writeRunLog(note: AutomationRunNote, steps: readonly AutomationStep[]): string {
    return JSON.stringify({ note, steps });
}

/** A fresh webhook secret, and the hash that is all that is kept of it. */
function mintToken(): { token: string; hash: string } {
    const token = randomBytes(32).toString("base64url");
    return { token, hash: hashOf(token) };
}

function hashOf(token: string): string {
    return createHash("sha256").update(token).digest("hex");
}

/** The address a rule's webhook is called at. */
export async function webhookUrl(automationId: string, token: string): Promise<string> {
    const base = (await appBaseUrl()).replace(/\/+$/, "");
    return `${base}/api/deploy/automations/${automationId}/${token}`;
}

/** When a schedule next fires from now, or null when it is off or never does. */
function nextFiring(
    trigger: string,
    schedule: string | null,
    timezone: string,
    enabled: boolean,
    after = new Date()
): Date | null {
    if (!enabled || trigger !== "schedule" || !schedule) return null;
    return core.nextCronRun(core.parseCron(schedule), after, timezone);
}

/** A project's rules. The caller has authorized the project. */
export async function listAutomations(projectId: string): Promise<DeployAutomationView[]> {
    const rows = await prisma.deployAutomation.findMany({
        where: { projectId },
        orderBy: { createdAt: "asc" },
        take: core.DEPLOY_AUTOMATION_LIMIT
    });
    return rows.map(toView);
}

/** The services a rule may name: the project's, in the environments the reader
 *  reaches (all of them when `environmentIds` is null). */
export async function automationServices(
    projectId: string,
    environmentIds: readonly string[] | null
): Promise<AutomationServiceOption[]> {
    const rows = await prisma.application.findMany({
        where: {
            binnedAt: null,
            environment: { projectId },
            ...(environmentIds ? { environmentId: { in: [...environmentIds] } } : {})
        },
        select: {
            id: true,
            name: true,
            environmentId: true,
            environment: { select: { name: true } }
        },
        orderBy: { name: "asc" },
        take: 500
    });
    return rows.map((row) => ({
        id: row.id,
        name: row.name,
        environmentId: row.environmentId,
        environmentName: row.environment.name
    }));
}

/** Every service a rule names, by its actions and by the event it follows. */
function namedServices(input: {
    actions: readonly core.DeployAutomationAction[];
    eventApplicationId?: string | null;
}): string[] {
    const ids = new Set<string>();
    for (const action of input.actions)
        if ("applicationId" in action) ids.add(action.applicationId);
    if (input.eventApplicationId) ids.add(input.eventApplicationId);
    return [...ids];
}

/** What a rule's actions ask of whoever runs them, beyond deploying. */
export function needsConsole(actions: readonly core.DeployAutomationAction[]): boolean {
    return actions.some((action) => action.type === "command");
}

/** Why a change to a rule was refused, as a code the screen words itself. */
export type AutomationErrorCode = "notFound" | "foreignService" | "limit" | "reach";

export class AutomationError extends Error {
    constructor(readonly code: AutomationErrorCode) {
        super(code);
    }
}

/**
 * Create a rule, or change one of this project's. Answers the rule, and the
 * webhook address when one was minted - the only time its secret is shown.
 *
 * `environmentIds` is the saver's reach: a rule may only name services there.
 */
export async function saveAutomation(
    input: core.DeployAutomationInput,
    userId: string,
    environmentIds: readonly string[] | null
): Promise<{ automation: DeployAutomationView; webhookUrl: string | null }> {
    const services = namedServices(input);
    if (services.length > 0) {
        const found = await prisma.application.findMany({
            where: {
                id: { in: services },
                binnedAt: null,
                environment: { projectId: input.projectId },
                ...(environmentIds ? { environmentId: { in: [...environmentIds] } } : {})
            },
            select: { id: true }
        });
        if (found.length !== services.length) throw new AutomationError("foreignService");
    }

    const existing = input.id
        ? await prisma.deployAutomation.findFirst({
              where: { id: input.id, projectId: input.projectId },
              select: { id: true, webhookTokenHash: true }
          })
        : null;
    if (input.id && !existing) throw new AutomationError("notFound");
    if (!existing) {
        const count = await prisma.deployAutomation.count({
            where: { projectId: input.projectId }
        });
        if (count >= core.DEPLOY_AUTOMATION_LIMIT) throw new AutomationError("limit");
    }

    // A webhook keeps its address while it stays a webhook; becoming one mints
    // an address, and ceasing to be one retires it.
    let minted: { token: string; hash: string } | null = null;
    let webhookTokenHash: string | null = null;
    if (input.trigger === "webhook") {
        if (existing?.webhookTokenHash) webhookTokenHash = existing.webhookTokenHash;
        else {
            minted = mintToken();
            webhookTokenHash = minted.hash;
        }
    }

    const schedule = input.trigger === "schedule" ? (input.schedule ?? null) : null;
    const data = {
        name: input.name,
        enabled: input.enabled,
        trigger: input.trigger,
        schedule,
        timezone: input.timezone,
        event: input.trigger === "event" ? (input.event ?? null) : null,
        eventApplicationId: input.trigger === "event" ? (input.eventApplicationId ?? null) : null,
        webhookTokenHash,
        actions: JSON.stringify(input.actions),
        nextRunAt: nextFiring(input.trigger, schedule, input.timezone, input.enabled),
        // Whoever saves a rule is who it acts as from now on: changing what it
        // does is taking responsibility for what it does.
        createdById: userId
    };
    const row = existing
        ? await prisma.deployAutomation.update({ where: { id: existing.id }, data })
        : await prisma.deployAutomation.create({ data: { ...data, projectId: input.projectId } });
    return {
        automation: toView(row),
        webhookUrl: minted ? await webhookUrl(row.id, minted.token) : null
    };
}

/** Switch a rule on or off, keeping everything else. */
export async function setAutomationEnabled(
    projectId: string,
    automationId: string,
    enabled: boolean
): Promise<DeployAutomationView> {
    const row = await prisma.deployAutomation.findFirst({ where: { id: automationId, projectId } });
    if (!row) throw new AutomationError("notFound");
    let nextRunAt: Date | null = null;
    try {
        nextRunAt = nextFiring(row.trigger, row.schedule, row.timezone, enabled);
    } catch {
        nextRunAt = null;
    }
    return toView(
        await prisma.deployAutomation.update({
            where: { id: row.id },
            data: { enabled, nextRunAt }
        })
    );
}

/** Give a webhook rule a new address; the old one stops working at once. */
export async function rotateAutomationWebhook(
    projectId: string,
    automationId: string
): Promise<string> {
    const row = await prisma.deployAutomation.findFirst({
        where: { id: automationId, projectId, trigger: "webhook" },
        select: { id: true }
    });
    if (!row) throw new AutomationError("notFound");
    const minted = mintToken();
    await prisma.deployAutomation.update({
        where: { id: row.id },
        data: { webhookTokenHash: minted.hash }
    });
    return webhookUrl(row.id, minted.token);
}

/** Remove one of this project's rules and its run history. */
export async function deleteAutomation(projectId: string, automationId: string): Promise<void> {
    const removed = await prisma.deployAutomation.deleteMany({
        where: { id: automationId, projectId }
    });
    if (removed.count === 0) throw new AutomationError("notFound");
}

/** A rule's recent runs, newest first. */
export async function listAutomationRuns(
    projectId: string,
    automationId: string
): Promise<DeployAutomationRunView[]> {
    const rows = await prisma.deployAutomationRun.findMany({
        where: { automationId, automation: { projectId } },
        orderBy: { startedAt: "desc" },
        take: 30
    });
    return rows.map((row) => ({
        id: row.id,
        trigger: row.trigger,
        status: row.status,
        ...readRunLog(row.log),
        startedAt: row.startedAt.toISOString(),
        finishedAt: row.finishedAt?.toISOString() ?? null
    }));
}

/** The services an automation would touch and whether it runs commands. */
function reachOf(stored: { actions: string; eventApplicationId: string | null }) {
    const actions = core.readAutomationActions(stored.actions);
    return {
        services: namedServices({ actions, eventApplicationId: stored.eventApplicationId }),
        console: needsConsole(actions)
    };
}

/**
 * Whether the person a rule acts as may still do everything it does: an account
 * that is neither banned nor disabled, holding the right to deploy at all, with
 * access to the project that runs (and, for a command, opens a console on) every
 * service the rule names.
 */
export async function creatorMayRun(automation: {
    projectId: string;
    createdById: string | null;
    actions: string;
    eventApplicationId: string | null;
}): Promise<boolean> {
    if (!automation.createdById) return false;
    const user = await prisma.user.findUnique({
        where: { id: automation.createdById },
        select: { id: true, isAdmin: true, bannedAt: true, disabledAt: true }
    });
    if (!user || user.bannedAt || user.disabledAt) return false;
    if (!user.isAdmin && !(await userHasPermission(user.id, "deploy.manage"))) return false;
    const access = await projectAccess(automation.projectId, user.id);
    return access !== null && (await accessReaches(access, automation));
}

/** Whether a project access may do everything a rule does: deploy, open a
 *  console when it runs commands, in the environments of every service it names. */
export async function accessReaches(
    access: ProjectAccess,
    automation: { actions: string; eventApplicationId: string | null }
): Promise<boolean> {
    if (!accessCan(access, "deploy.run")) return false;
    const reach = reachOf(automation);
    if (reach.console && !accessCan(access, "console.use")) return false;
    if (reach.services.length === 0 || access.environmentIds === null) return true;
    const apps = await prisma.application.findMany({
        where: { id: { in: reach.services } },
        select: { environmentId: true }
    });
    return apps.every((app) => accessInEnvironment(access, app.environmentId));
}

/** Run one of this project's rules now, whatever its trigger. Answers the run. */
export async function runAutomationNow(
    access: ProjectAccess,
    automationId: string,
    actorId: string
): Promise<string> {
    const row = await prisma.deployAutomation.findFirst({
        where: { id: automationId, projectId: access.projectId },
        select: { id: true, actions: true, eventApplicationId: true }
    });
    if (!row) throw new AutomationError("notFound");
    // Pressing Run does the actions as the person pressing it, so it asks of
    // them what a schedule asks of the rule's maker.
    if (!(await accessReaches(access, row))) throw new AutomationError("reach");
    await prisma.deployAutomation.update({
        where: { id: row.id },
        data: { lastRunAt: new Date() }
    });
    return startRun(row.id, "manual", actorId);
}

/** Whether a run of this rule is still going, so another is not started beside it. */
async function busy(automationId: string, now: Date): Promise<boolean> {
    const running = await prisma.deployAutomationRun.findFirst({
        where: {
            automationId,
            status: "running",
            startedAt: { gt: new Date(now.getTime() - STALE_RUN_MS) }
        },
        select: { id: true }
    });
    return running !== null;
}

/** Record a run that did nothing, and why. */
async function recordSkipped(
    automationId: string,
    trigger: AutomationRunTrigger,
    note: AutomationRunNote,
    now: Date
): Promise<void> {
    await prisma.deployAutomationRun.create({
        data: {
            automationId,
            trigger,
            status: "skipped",
            log: writeRunLog(note, []),
            startedAt: now,
            finishedAt: now
        }
    });
    await pruneRuns(automationId);
}

/**
 * The scheduler's minute: start every schedule rule that has come due. Each is
 * claimed before it is started, by moving `nextRunAt` on only where it still
 * holds the value this pass read.
 */
export async function tickDeployAutomations(
    now = new Date()
): Promise<{ started: number; skipped: number }> {
    let started = 0;
    let skipped = 0;
    const due = await prisma.deployAutomation.findMany({
        where: {
            enabled: true,
            trigger: "schedule",
            nextRunAt: { lte: now },
            project: { binnedAt: null }
        },
        select: { id: true, schedule: true, timezone: true, nextRunAt: true },
        take: 200
    });
    for (const rule of due) {
        let next: Date | null = null;
        try {
            next = nextFiring("schedule", rule.schedule, rule.timezone, true, now);
        } catch {
            // A schedule that no longer parses is switched off rather than read
            // and refused every minute.
            await prisma.deployAutomation.update({
                where: { id: rule.id },
                data: { enabled: false, nextRunAt: null }
            });
            continue;
        }
        const claimed = await prisma.deployAutomation.updateMany({
            where: { id: rule.id, nextRunAt: rule.nextRunAt },
            data: { nextRunAt: next, lastRunAt: now }
        });
        if (claimed.count === 0) continue;
        if (await busy(rule.id, now)) {
            await recordSkipped(rule.id, "schedule", "busy", now);
            skipped += 1;
            continue;
        }
        await startRun(rule.id, "schedule", null);
        started += 1;
    }
    return { started, skipped };
}

/**
 * Something happened on a project: start every rule that follows it and is not
 * cooling off. Never throws - it runs inside a deploy's completion and the
 * health poller, and neither may fail because an automation could not start.
 */
export async function raiseAutomationEvent(input: {
    projectId: string;
    event: core.DeployAutomationEvent;
    applicationId: string | null;
}): Promise<number> {
    try {
        const now = new Date();
        const rules = await prisma.deployAutomation.findMany({
            where: {
                projectId: input.projectId,
                enabled: true,
                trigger: "event",
                event: input.event
            },
            select: {
                id: true,
                enabled: true,
                trigger: true,
                event: true,
                eventApplicationId: true,
                lastRunAt: true
            },
            take: core.DEPLOY_AUTOMATION_LIMIT
        });
        let started = 0;
        for (const rule of rules) {
            if (!core.automationHears(rule, input, now)) continue;
            // The cool-off is claimed, not only read: two processes hearing the
            // same event both see it expired, and only one moves it on.
            const claimed = await prisma.deployAutomation.updateMany({
                where: { id: rule.id, lastRunAt: rule.lastRunAt },
                data: { lastRunAt: now }
            });
            if (claimed.count === 0) continue;
            await startRun(rule.id, "event", null);
            started += 1;
        }
        return started;
    } catch (error) {
        console.error("polaris: a project automation could not be started:", error);
        return 0;
    }
}

/**
 * An event that is not about one project (a UPS's power events): started in
 * every project that has a rule following it. Never throws, like the above.
 */
export async function raiseAutomationEventEverywhere(event: core.DeployAutomationEvent): Promise<number> {
    try {
        const projects = await prisma.deployAutomation.findMany({
            where: { enabled: true, trigger: "event", event },
            select: { projectId: true },
            distinct: ["projectId"],
            take: 500
        });
        let started = 0;
        for (const { projectId } of projects) {
            started += await raiseAutomationEvent({ projectId, event, applicationId: null });
        }
        return started;
    } catch (error) {
        console.error("polaris: an automation could not be started:", error);
        return 0;
    }
}

/**
 * The rule a webhook address names, or null. The secret is compared in constant
 * time against its hash, and an unknown id and a wrong secret are the same null.
 */
export async function automationForWebhook(
    id: string,
    token: string
): Promise<{ id: string; enabled: boolean } | null> {
    if (!/^[0-9a-f-]{36}$/i.test(id) || !/^[A-Za-z0-9_-]{20,128}$/.test(token)) return null;
    const row = await prisma.deployAutomation.findUnique({
        where: { id },
        select: { id: true, enabled: true, trigger: true, webhookTokenHash: true }
    });
    if (!row || row.trigger !== "webhook" || !row.webhookTokenHash) return null;
    const presented = Buffer.from(hashOf(token), "hex");
    const stored = Buffer.from(row.webhookTokenHash, "hex");
    if (presented.length !== stored.length || !timingSafeEqual(presented, stored)) return null;
    return { id: row.id, enabled: row.enabled };
}

/**
 * Start a webhook rule. Refused - and recorded as refused, so the owner can see
 * why the calls stopped working - once the person it acts as may no longer
 * deploy what it touches.
 */
export async function fireAutomationWebhook(
    automationId: string
): Promise<{ runId: string } | { refused: "disabled" | "creator" | "busy" }> {
    const row = await prisma.deployAutomation.findUnique({
        where: { id: automationId },
        select: {
            id: true,
            enabled: true,
            projectId: true,
            createdById: true,
            actions: true,
            eventApplicationId: true,
            project: { select: { binnedAt: true } }
        }
    });
    if (!row || !row.enabled || row.project.binnedAt) return { refused: "disabled" };
    const now = new Date();
    if (!(await creatorMayRun(row))) {
        await recordSkipped(row.id, "webhook", "creator", now);
        return { refused: "creator" };
    }
    if (await busy(row.id, now)) {
        await recordSkipped(row.id, "webhook", "busy", now);
        return { refused: "busy" };
    }
    await prisma.deployAutomation.update({ where: { id: row.id }, data: { lastRunAt: now } });
    return { runId: await startRun(row.id, "webhook", null) };
}

/** Record a run and start it in the background. Answers its id. */
async function startRun(
    automationId: string,
    trigger: AutomationRunTrigger,
    actorId: string | null
): Promise<string> {
    const run = await prisma.deployAutomationRun.create({
        data: { automationId, trigger, status: "running", log: writeRunLog(null, []) }
    });
    void executeRun(run.id, actorId).catch((error: unknown) => {
        console.error("polaris: a project automation could not be run:", error);
    });
    return run.id;
}

/** The pieces one action needs from the run around it. */
export interface ActionContext {
    readonly ownerId: string;
    /** Who the action is done as: whoever pressed Run, else the rule's maker. */
    readonly actorId: string | null;
    readonly project: { id: string; name: string; orgId: string | null };
    readonly automation: { id: string; name: string };
}

/** Do one action. Never throws: a failure is a step that says why. */
export async function runAction(
    action: core.DeployAutomationAction,
    context: ActionContext
): Promise<AutomationStep> {
    const applicationId = "applicationId" in action ? action.applicationId : null;
    const step = { type: action.type, applicationId };
    try {
        if (applicationId) {
            const inProject = await prisma.application.findFirst({
                where: {
                    id: applicationId,
                    binnedAt: null,
                    environment: { projectId: context.project.id }
                },
                select: { id: true }
            });
            if (!inProject) return { ...step, status: "failed", reason: "gone" };
        }
        switch (action.type) {
            case "redeploy": {
                const deploymentId = await deployService.deployApplication(
                    action.applicationId,
                    context.ownerId,
                    context.actorId,
                    { trigger: "automation", audit: { automationId: context.automation.id } }
                );
                return { ...step, status: "succeeded", reason: null, deploymentId };
            }
            case "restart":
                await deployService.restartApplication(action.applicationId, context.ownerId);
                return { ...step, status: "succeeded", reason: null };
            case "command": {
                const app = await prisma.application.findUnique({
                    where: { id: action.applicationId },
                    include: {
                        target: true,
                        environment: { select: { project: { select: { slug: true } } } }
                    }
                });
                if (!app) return { ...step, status: "failed", reason: "gone" };
                const outcome = await runInService(
                    app,
                    context.ownerId,
                    action.command,
                    action.timeoutSeconds
                );
                return {
                    ...step,
                    status: outcome.status,
                    reason: outcome.reason,
                    exitCode: outcome.exitCode,
                    output: outcome.output.slice(-AUTOMATION_OUTPUT_LIMIT)
                };
            }
            case "notify": {
                for (const userId of await recipients(context)) {
                    await notify({
                        userId,
                        event: "deploy.automation.notice",
                        title: `${context.project.name} / ${context.automation.name}`,
                        body: action.message,
                        href: automationsHref(context.project.id),
                        shelf: { orgId: context.project.orgId },
                        metadata: { automationId: context.automation.id }
                    });
                }
                return { ...step, status: "succeeded", reason: null };
            }
        }
    } catch (caught) {
        console.error(
            `polaris: automation ${context.automation.id} could not ${action.type}:`,
            caught
        );
        return { ...step, status: "failed", reason: "failed" };
    }
}

function automationsHref(projectId: string): string {
    return `/apps/deploy/${projectId}/settings/automations`;
}

/** Who hears from a rule: the project's owner, and the rule's maker. */
async function recipients(context: ActionContext): Promise<string[]> {
    const people = new Set([context.ownerId]);
    if (context.actorId) people.add(context.actorId);
    return [...people];
}

/** Run a recorded run's actions in order, stopping at the first that fails. */
async function executeRun(runId: string, manualActorId: string | null): Promise<void> {
    const run = await prisma.deployAutomationRun.findUnique({
        where: { id: runId },
        include: {
            automation: {
                include: {
                    project: { select: { id: true, name: true, ownerId: true, orgId: true } }
                }
            }
        }
    });
    if (!run) return;
    const { automation } = run;
    const project = automation.project;
    const actions = core.readAutomationActions(automation.actions);

    let note: AutomationRunNote = null;
    const steps: AutomationStep[] = [];
    if (actions.length === 0) note = "empty";
    else if (
        run.trigger !== "manual" &&
        !(await creatorMayRun({ ...automation, projectId: project.id }))
    )
        note = "creator";

    if (note === null) {
        const context: ActionContext = {
            ownerId: project.ownerId,
            actorId: run.trigger === "manual" ? manualActorId : automation.createdById,
            project: { id: project.id, name: project.name, orgId: project.orgId },
            automation: { id: automation.id, name: automation.name }
        };
        let stopped = false;
        for (const action of actions) {
            if (stopped) {
                steps.push({
                    type: action.type,
                    applicationId: "applicationId" in action ? action.applicationId : null,
                    status: "skipped",
                    reason: null
                });
                continue;
            }
            const step = await runAction(action, context);
            steps.push(step);
            if (step.status !== "succeeded") stopped = true;
            // Written as it goes, so somebody watching the run sees each step land.
            await prisma.deployAutomationRun.update({
                where: { id: runId },
                data: { log: writeRunLog(null, steps) }
            });
        }
    }

    const failedStep = steps.find(
        (step) => step.status === "failed" || step.status === "timed_out"
    );
    const status = note !== null || failedStep ? "failed" : "succeeded";
    await prisma.deployAutomationRun.update({
        where: { id: runId },
        data: { status, log: writeRunLog(note, steps), finishedAt: new Date() }
    });
    await prisma.deployAutomation.update({
        where: { id: automation.id },
        data: { lastStatus: status }
    });
    await pruneRuns(automation.id);

    // A manual run is being watched; anything else that failed is worth saying,
    // once: a maker who lost their access is said the first time, not on every
    // firing until somebody saves the rule again.
    const repeated = note === "creator" && (await refusedBefore(automation.id, runId));
    if (status === "failed" && run.trigger !== "manual" && !repeated) {
        const people = new Set([project.ownerId]);
        if (automation.createdById) people.add(automation.createdById);
        for (const userId of people) {
            const t = await wordsFor(userId, "notices");
            const reason = failedStep?.reason ?? null;
            const reasons = reason ? await wordsFor(userId, "deploySettings") : null;
            await notify({
                userId,
                event: "deploy.automation.failed",
                title: t("automations.failedTitle", {
                    name: `${project.name} / ${automation.name}`
                }),
                body:
                    note === "creator"
                        ? t("automations.creatorBody")
                        : reason && reasons
                          ? reasons(`automations.reasons.${reason}`)
                          : t("automations.failedBody"),
                href: automationsHref(project.id),
                shelf: { orgId: project.orgId },
                actionRequired: true,
                metadata: { automationId: automation.id, runId }
            }).catch(() => undefined);
        }
    }
}

/** Whether the run before this one was already refused for its maker's reach. */
async function refusedBefore(automationId: string, runId: string): Promise<boolean> {
    const previous = await prisma.deployAutomationRun.findFirst({
        where: { automationId, id: { not: runId } },
        orderBy: { startedAt: "desc" },
        select: { log: true }
    });
    return previous !== null && readRunLog(previous.log).note === "creator";
}

/** Keep the newest runs of a rule and drop the rest. */
async function pruneRuns(automationId: string): Promise<void> {
    const stale = await prisma.deployAutomationRun.findMany({
        where: { automationId },
        orderBy: { startedAt: "desc" },
        skip: KEPT_RUNS,
        select: { id: true }
    });
    if (stale.length > 0)
        await prisma.deployAutomationRun.deleteMany({
            where: { id: { in: stale.map((row) => row.id) } }
        });
}
