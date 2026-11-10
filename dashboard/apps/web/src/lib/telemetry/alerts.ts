/**
 * A project's alert rules, Sentry's "issue alerts": when one of its issues is
 * new, happens too often, or comes back after being resolved, tell somebody.
 *
 * Evaluated at ingest, after the event is stored and off the path that answers
 * the client: `captureEvent` hands over what it just learned (was the issue
 * new, did it regress) and does not wait. The rules are read once per project
 * per half minute rather than per event, so a crash loop costs no query here
 * for the projects that have none; the only per-event query is the bounded
 * "how many in the window" a frequency rule needs, and it reads at most one row
 * past the threshold.
 *
 * A rule fires at most once per issue per its throttle. The fire is written
 * before anybody is notified, so it is both the history the project's Alerts
 * screen lists and the record the next event's throttle reads.
 */

import { prisma } from "@polaris/db";
import { translate } from "@/lib/i18n/translate";
import * as q from "@/lib/telemetry/issue-query";
import {
    ALERT_EVENTS,
    ALERT_TRIGGERS,
    MAX_NOTIFIED,
    MAX_RULES,
    type AlertRuleInput,
    type AlertTrigger
} from "@/lib/telemetry/alert-schema";
import { grantHolders } from "@/lib/access/grants";
import { notify } from "@/lib/notifications/dispatch";
import { getUserLocale } from "@/lib/i18n/locale-service";

/** How long a project's rules are reused before they are read again. */
const RULES_TTL_MS = 30_000;

/** A rule as the engine reads it. */
export interface AlertRule {
    readonly id: string;
    readonly projectId: string;
    readonly name: string;
    readonly enabled: boolean;
    readonly trigger: AlertTrigger;
    readonly threshold: number;
    readonly windowMinutes: number;
    readonly levels: readonly string[];
    readonly environment: string | null;
    readonly recipients: readonly string[];
    readonly notifyMembers: boolean;
    readonly throttleMinutes: number;
}

/** A rule as the screen shows it. */
export interface AlertRuleView extends AlertRule {
    readonly people: readonly { id: string; name: string }[];
    readonly lastFiredAt: string | null;
}

/** One firing, as the history lists it. */
export interface AlertFireRow {
    readonly id: string;
    readonly ruleId: string;
    readonly ruleName: string;
    readonly issueId: string;
    readonly issueTitle: string;
    readonly trigger: AlertTrigger;
    readonly notified: number;
    readonly at: string;
}

/** What an event just did to its issue, as `captureEvent` learned it. */
export interface AlertSignal {
    readonly projectId: string;
    readonly issueId: string;
    readonly title: string;
    /** The event opened the issue. */
    readonly isNew: boolean;
    /** The event reopened an issue somebody had resolved. */
    readonly regressed: boolean;
    readonly level: string;
    readonly environment: string | null;
}

function stringList(raw: string): string[] {
    try {
        const parsed: unknown = JSON.parse(raw);
        return Array.isArray(parsed) ? parsed.filter((item): item is string => typeof item === "string") : [];
    } catch {
        return [];
    }
}

function triggerOf(value: string): AlertTrigger {
    return (ALERT_TRIGGERS as readonly string[]).includes(value) ? (value as AlertTrigger) : "new";
}

const RULE_SELECT = {
    id: true,
    projectId: true,
    name: true,
    enabled: true,
    trigger: true,
    threshold: true,
    windowMinutes: true,
    levels: true,
    environment: true,
    recipients: true,
    notifyMembers: true,
    throttleMinutes: true
} as const;

function ruleOf(row: {
    id: string;
    projectId: string;
    name: string;
    enabled: boolean;
    trigger: string;
    threshold: number;
    windowMinutes: number;
    levels: string;
    environment: string | null;
    recipients: string;
    notifyMembers: boolean;
    throttleMinutes: number;
}): AlertRule {
    return {
        ...row,
        trigger: triggerOf(row.trigger),
        levels: stringList(row.levels),
        recipients: stringList(row.recipients)
    };
}

// ---------------------------------------------------------------------------
// The rules, as the screen edits them
// ---------------------------------------------------------------------------

/** Read again on the next event, in this process, once a rule changed. */
const cached = new Map<string, { readonly at: number; readonly rules: readonly AlertRule[] }>();

export function forgetRules(projectId?: string): void {
    if (projectId) cached.delete(projectId);
    else cached.clear();
}

/** A project's rules, oldest first, with the people they name. */
export async function listRules(projectId: string): Promise<AlertRuleView[]> {
    const rows = await prisma.telemetryAlertRule.findMany({
        where: { projectId },
        orderBy: [{ createdAt: "asc" }, { id: "asc" }],
        take: MAX_RULES,
        select: { ...RULE_SELECT, lastFiredAt: true }
    });
    const rules = rows.map((row) => ({ ...ruleOf(row), lastFiredAt: row.lastFiredAt?.toISOString() ?? null }));
    const ids = [...new Set(rules.flatMap((rule) => rule.recipients))];
    const people =
        ids.length === 0
            ? []
            : await prisma.user.findMany({ where: { id: { in: ids } }, select: { id: true, name: true } });
    const names = new Map(people.map((person) => [person.id, person.name ?? ""]));
    return rules.map((rule) => ({
        ...rule,
        // Somebody deleted since drops out of the rule rather than showing as a blank.
        people: rule.recipients.filter((id) => names.has(id)).map((id) => ({ id, name: names.get(id) ?? "" }))
    }));
}

export class AlertLimitError extends Error {
    constructor() {
        super("Too many alert rules");
        this.name = "AlertLimitError";
    }
}

/** Create a rule, or change one of this project's. False when the rule is not
 *  this project's (or no longer exists). */
export async function saveRule(
    projectId: string,
    ruleId: string | null | undefined,
    rule: AlertRuleInput,
    actorId: string
): Promise<boolean> {
    const data = {
        name: rule.name,
        enabled: rule.enabled,
        trigger: rule.trigger,
        threshold: rule.threshold,
        windowMinutes: rule.windowMinutes,
        levels: JSON.stringify(rule.levels),
        environment: rule.environment,
        recipients: JSON.stringify(rule.recipients),
        notifyMembers: rule.notifyMembers,
        throttleMinutes: rule.throttleMinutes
    };
    forgetRules(projectId);
    if (ruleId) {
        const { count } = await prisma.telemetryAlertRule.updateMany({ where: { id: ruleId, projectId }, data });
        return count > 0;
    }
    const existing = await prisma.telemetryAlertRule.count({ where: { projectId } });
    if (existing >= MAX_RULES) throw new AlertLimitError();
    await prisma.telemetryAlertRule.create({ data: { ...data, projectId, createdById: actorId } });
    return true;
}

export async function setRuleEnabled(projectId: string, ruleId: string, enabled: boolean): Promise<boolean> {
    forgetRules(projectId);
    const { count } = await prisma.telemetryAlertRule.updateMany({ where: { id: ruleId, projectId }, data: { enabled } });
    return count > 0;
}

export async function deleteRule(projectId: string, ruleId: string): Promise<boolean> {
    forgetRules(projectId);
    const { count } = await prisma.telemetryAlertRule.deleteMany({ where: { id: ruleId, projectId } });
    return count > 0;
}

/** One page of the project's alert history, newest first. */
export async function listFires(projectId: string, cursor?: string | null): Promise<{ items: AlertFireRow[]; next: string | null }> {
    const rows = await prisma.telemetryAlertFire.findMany({
        where: { projectId },
        orderBy: [{ at: "desc" }, { id: "desc" }],
        ...q.pageArgs(cursor, q.PAGE_SIZE),
        select: {
            id: true,
            ruleId: true,
            issueId: true,
            trigger: true,
            notified: true,
            at: true,
            rule: { select: { name: true } },
            issue: { select: { title: true } }
        }
    });
    const page = q.pageOf(rows, q.PAGE_SIZE);
    return {
        next: page.next,
        items: page.items.map((row) => ({
            id: row.id,
            ruleId: row.ruleId,
            ruleName: row.rule.name,
            issueId: row.issueId,
            issueTitle: row.issue.title,
            trigger: triggerOf(row.trigger),
            notified: row.notified,
            at: row.at.toISOString()
        }))
    };
}

// ---------------------------------------------------------------------------
// Evaluating them
// ---------------------------------------------------------------------------

async function rulesFor(projectId: string, now: number): Promise<readonly AlertRule[]> {
    const hit = cached.get(projectId);
    if (hit && now - hit.at < RULES_TTL_MS) return hit.rules;
    const rows = await prisma.telemetryAlertRule.findMany({
        where: { projectId, enabled: true },
        take: MAX_RULES,
        select: RULE_SELECT
    });
    const rules = rows.map(ruleOf);
    cached.set(projectId, { at: now, rules });
    return rules;
}

/** Whether a rule's filters let this event through. Empty filters let anything through. */
export function passesFilters(rule: Pick<AlertRule, "levels" | "environment">, signal: Pick<AlertSignal, "level" | "environment">): boolean {
    if (rule.levels.length > 0 && !rule.levels.includes(signal.level)) return false;
    if (rule.environment && rule.environment !== signal.environment) return false;
    return true;
}

/** Whether what happened is what the rule's trigger asks about, before any count. */
export function triggerApplies(rule: Pick<AlertRule, "trigger">, signal: Pick<AlertSignal, "isNew" | "regressed">): boolean {
    if (rule.trigger === "new") return signal.isNew;
    if (rule.trigger === "regression") return signal.regressed;
    return true;
}

/** Firings in flight in this process, so two events of one crash loop arriving
 *  together do not both slip past the throttle. */
const inFlight = new Set<string>();

/**
 * Run a project's rules against what one event did. Never throws; answers how
 * many rules fired, for tests and logs.
 */
export async function evaluateAlerts(signal: AlertSignal, now: Date = new Date()): Promise<number> {
    try {
        const rules = await rulesFor(signal.projectId, now.getTime());
        let fired = 0;
        for (const rule of rules) {
            if (!rule.enabled || !triggerApplies(rule, signal) || !passesFilters(rule, signal)) continue;
            const key = `${rule.id}:${signal.issueId}`;
            if (inFlight.has(key)) continue;
            inFlight.add(key);
            try {
                if (await shouldFire(rule, signal, now)) {
                    await fire(rule, signal, now);
                    fired += 1;
                }
            } finally {
                inFlight.delete(key);
            }
        }
        return fired;
    } catch (error) {
        console.error("polaris: could not evaluate telemetry alerts:", error);
        return 0;
    }
}

async function shouldFire(rule: AlertRule, signal: AlertSignal, now: Date): Promise<boolean> {
    if (rule.trigger === "frequency") {
        const since = new Date(now.getTime() - rule.windowMinutes * 60_000);
        // One row past the threshold answers "more than N" without counting a
        // crash loop's every event.
        const seen = await prisma.telemetryEvent.findMany({
            where: {
                issueId: signal.issueId,
                at: { gte: since },
                ...(rule.environment ? { environment: rule.environment } : {}),
                ...(rule.levels.length > 0 ? { level: { in: [...rule.levels] } } : {})
            },
            select: { id: true },
            take: rule.threshold + 1
        });
        if (seen.length <= rule.threshold) return false;
    }
    const recent = await prisma.telemetryAlertFire.findFirst({
        where: {
            ruleId: rule.id,
            issueId: signal.issueId,
            at: { gte: new Date(now.getTime() - rule.throttleMinutes * 60_000) }
        },
        select: { id: true }
    });
    return !recent;
}

/** Who hears about a firing: the people the rule names who can still open the
 *  project, and with `notifyMembers` everybody who can. */
export async function recipientsFor(rule: AlertRule): Promise<string[]> {
    const project = await prisma.telemetryProject.findUnique({
        where: { id: rule.projectId },
        select: { ownerId: true }
    });
    if (!project) return [];
    const holders = await grantHolders("telemetry.project", rule.projectId, "view", MAX_NOTIFIED);
    const members = new Set([project.ownerId, ...holders]);
    const named = rule.recipients.filter((id) => !members.has(id));
    const admins =
        named.length === 0
            ? []
            : (
                  await prisma.user.findMany({
                      where: { id: { in: named }, isAdmin: true },
                      select: { id: true }
                  })
              ).map((row) => row.id);
    const allowed = new Set([...members, ...admins]);
    const chosen = [
        ...rule.recipients.filter((id) => allowed.has(id)),
        ...(rule.notifyMembers ? members : [])
    ];
    return [...new Set(chosen)].slice(0, MAX_NOTIFIED);
}

const TITLE_KEYS = {
    new: "telemetry.notify.alertNew",
    frequency: "telemetry.notify.alertFrequency",
    regression: "telemetry.notify.alertRegression"
} as const;

async function fire(rule: AlertRule, signal: AlertSignal, now: Date): Promise<void> {
    const record = await prisma.telemetryAlertFire.create({
        data: { projectId: rule.projectId, ruleId: rule.id, issueId: signal.issueId, trigger: rule.trigger, at: now },
        select: { id: true }
    });
    const people = await recipientsFor(rule);
    const project = await prisma.telemetryProject.findUnique({
        where: { id: rule.projectId },
        select: { orgId: true }
    });
    const href = `/telemetry/${encodeURIComponent(rule.projectId)}/issues/${encodeURIComponent(signal.issueId)}`;
    let notified = 0;
    for (const userId of people) {
        try {
            const locale = await getUserLocale(userId);
            await notify({
                userId,
                event: ALERT_EVENTS[rule.trigger],
                title: translate(locale, TITLE_KEYS[rule.trigger], {
                    rule: rule.name,
                    count: rule.threshold,
                    minutes: rule.windowMinutes
                }),
                body: signal.title.slice(0, 200),
                href,
                dedupKey: null,
                shelf: { orgId: project?.orgId ?? null }
            });
            notified += 1;
        } catch (error) {
            console.error("polaris: could not send a telemetry alert:", error);
        }
    }
    await Promise.all([
        prisma.telemetryAlertFire.update({ where: { id: record.id }, data: { notified } }),
        prisma.telemetryAlertRule.updateMany({ where: { id: rule.id }, data: { lastFiredAt: now } })
    ]);
}
