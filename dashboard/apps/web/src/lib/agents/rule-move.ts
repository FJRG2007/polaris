/**
 * Moving the agent rules of connected repositories into Automations: a data
 * step, never a migration, run at boot and right after a repository seeds its
 * defaults, so an install moves after its next Update with nobody doing
 * anything.
 *
 * Each rule becomes a published automation: the repository event it listened
 * for, its label / branch / author narrowing as a condition, and an agent step
 * with its mode, instructions and target. Idempotent: the automation is keyed
 * by `legacyRef` ("agent:<id>", unique), so a pass that crashed after creating
 * it finds it again and only marks the row. Nothing is deleted; from the moment
 * `movedToId` is set the webhook stops starting work for the rule
 * (`agentRepoByFullName` leaves it out) and the automation does instead.
 *
 * Server-only.
 */

import { prisma } from "@polaris/db";
import * as core from "@polaris/core";

export const AGENT_RULE_PREFIX = "agent:";

/** Rows per query; a pass keeps going until none are left. */
const BATCH = 50;

export interface MovableRule {
    readonly id: string;
    readonly trigger: string;
    readonly condition: string;
    readonly mode: string | null;
    readonly instructions: string;
    readonly enabled: boolean;
    readonly target: string;
    readonly repo: { readonly id: string; readonly ownerId: string; readonly repoFullName: string };
}

const MOVABLE = {
    id: true,
    trigger: true,
    condition: true,
    mode: true,
    instructions: true,
    enabled: true,
    target: true,
    repo: { select: { id: true, ownerId: true, repoFullName: true } }
} as const;

const EVENT_OF = Object.fromEntries(
    Object.entries(core.CODE_EVENT_TRIGGERS).map(([name, trigger]) => [trigger, name])
) as Partial<Record<string, core.CodeEventName>>;

function listOf(value: unknown): string[] {
    return Array.isArray(value)
        ? value
              .filter((entry): entry is string => typeof entry === "string" && entry.trim() !== "")
              .slice(0, 20)
              .map((entry) => entry.slice(0, 500))
        : [];
}

/** The rule's narrowing, read as the webhook reads it: an empty list narrows nothing. */
export function ruleCondition(raw: string): {
    labels: string[];
    branches: string[];
    authors: string[];
} {
    try {
        const parsed: unknown = JSON.parse(raw);
        if (!parsed || typeof parsed !== "object") return { labels: [], branches: [], authors: [] };
        const row = parsed as Record<string, unknown>;
        return {
            labels: listOf(row.labels),
            branches: listOf(row.branches),
            authors: listOf(row.authors)
        };
    } catch {
        return { labels: [], branches: [], authors: [] };
    }
}

/** Any one of the values, as the webhook's `matches` takes any label of a list. */
function anyOf(left: string, op: "eq" | "contains", values: readonly string[]) {
    return {
        kind: "group" as const,
        join: "any" as const,
        items: values.map((right) => ({ kind: "compare" as const, left, op, right }))
    };
}

/** The rule as an automation graph, or null for a trigger no event stands for. */
export function agentRuleGraph(rule: MovableRule): core.AutomationGraph | null {
    const event = EVENT_OF[rule.trigger];
    if (!event) return null;
    const mode = (core.AGENT_RUN_MODES as readonly string[]).includes(rule.mode ?? "")
        ? rule.mode
        : null;
    // A mention rule never narrowed: the webhook answered every mention, and
    // only looked at the rule for where the answer goes.
    const narrowing =
        event === "code.mentioned"
            ? { labels: [], branches: [], authors: [] }
            : ruleCondition(rule.condition);
    const items = [
        // Every repository of the owner sends this event; this rule was one.
        {
            kind: "compare" as const,
            left: "{{trigger.payload.repoId}}",
            op: "eq" as const,
            right: rule.repo.id
        },
        ...(narrowing.labels.length > 0
            ? [anyOf("{{trigger.payload.labels}}", "contains", narrowing.labels)]
            : []),
        ...(narrowing.branches.length > 0
            ? [anyOf("{{trigger.payload.branch}}", "eq", narrowing.branches)]
            : []),
        ...(narrowing.authors.length > 0
            ? [anyOf("{{trigger.payload.actor}}", "eq", narrowing.authors)]
            : [])
    ];
    const parsed = core.automationGraphSchema.safeParse({
        schema: 1,
        timeZone: "UTC",
        nodes: [
            {
                id: "event",
                type: "core.onEvent",
                position: { x: 0, y: 0 },
                config: { name: event }
            },
            {
                id: "match",
                type: "core.if",
                position: { x: 0, y: 160 },
                config: { condition: { kind: "group", join: "all", items } }
            },
            {
                id: "agent",
                type: "core.agentWork",
                position: { x: 0, y: 320 },
                config: {
                    repoId: rule.repo.id,
                    mode,
                    instructions: rule.instructions.slice(0, core.AUTOMATION_LIMITS.textLength * 4),
                    target: rule.target === "session" ? "session" : "run"
                }
            }
        ],
        edges: [
            { from: { node: "event", port: "next" }, to: { node: "match" } },
            { from: { node: "match", port: "then" }, to: { node: "agent" } }
        ]
    });
    if (!parsed.success || core.graphProblems(parsed.data, { forPublish: true }).length > 0)
        return null;
    return parsed.data;
}

/** What the automation is called: the repository and what it answers. */
export function agentRuleName(rule: MovableRule): string {
    const label = core.AGENT_TRIGGER_LABELS[rule.trigger as core.AgentTrigger] ?? rule.trigger;
    return `${rule.repo.repoFullName}: ${label}`.slice(0, 200);
}

/** Rules that could not be moved, said once per process rather than every pass. */
const reported = new Set<string>();

async function moveRule(rule: MovableRule): Promise<string | null> {
    const graph = agentRuleGraph(rule);
    if (!graph) {
        if (!reported.has(rule.id)) {
            reported.add(rule.id);
            console.error(
                `agents: rule ${rule.id} (${rule.trigger}) stays on the repository: it has no event to listen for`
            );
        }
        return null;
    }
    try {
        const { importAutomation } = await import("@/lib/automations/app-bridge");
        const automationId = await importAutomation({
            legacyRef: `${AGENT_RULE_PREFIX}${rule.id}`,
            name: agentRuleName(rule),
            enabled: rule.enabled,
            ownerId: rule.repo.ownerId,
            origin: null,
            originRef: null,
            // Two pull requests opened at once are two reviews, as before.
            mode: "parallel",
            graph
        });
        await prisma.agentAutomation.updateMany({
            where: { id: rule.id, movedToId: null },
            data: { movedToId: automationId }
        });
        return automationId;
    } catch (error) {
        console.error(`agents: rule ${rule.id} could not be moved to Automations yet:`, error);
        return null;
    }
}

/**
 * Move every rule not moved yet, or only one repository's. Returns how many
 * moved. Never throws: a rule that cannot go yet keeps working from the
 * webhook and is tried again on the next pass.
 */
export async function moveAgentRules(repoId?: string): Promise<number> {
    let moved = 0;
    let after: string | null = null;
    for (;;) {
        const rows: MovableRule[] = await prisma.agentAutomation.findMany({
            where: {
                movedToId: null,
                ...(repoId ? { repoId } : {}),
                ...(after ? { id: { gt: after } } : {})
            },
            orderBy: { id: "asc" },
            take: BATCH,
            select: MOVABLE
        });
        for (const row of rows) if (await moveRule(row)) moved += 1;
        if (rows.length < BATCH) return moved;
        after = rows.at(-1)!.id;
    }
}
