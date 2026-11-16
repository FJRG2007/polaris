/**
 * Which Tasks status an agent's item moves to, and whether it may be moved.
 *
 * Pure, so every rule is asserted without a database. The service that reads
 * and writes the rows is `task-items.ts`.
 *
 * The rule for a status a person set (compare-and-set on the last write): a
 * link remembers the status it last wrote, or the one the item had when it was
 * linked. It moves the item only while the item still holds that status. Once
 * the item shows any other, a person moved it, and the link holds for good -
 * it never writes that item again, even back to where the session would put
 * it. Linear's Git automations work the same way in spirit: they move an issue
 * on pull request events and leave the workflow to people otherwise
 * (linear.app/docs/github-integration); here the hand-made change is detected
 * rather than assumed, so a person who moves the card wins every time.
 */

import type { TaskStatusType } from "@polaris/core";
import type { SessionStatus } from "@/lib/agents/session-status";

/**
 * The kind of status a session's derived status puts its item in, or null to
 * leave the item where it is. A session that ended without a merge is null:
 * whether that work is abandoned or done some other way is a person's call.
 */
export function statusTypeFor(status: SessionStatus | null): TaskStatusType | null {
    switch (status) {
        case null:
            return null;
        case "needs_input":
            return "blocked";
        case "merged":
            return "done";
        case "terminated":
        case "exited":
            return null;
        default:
            // Working, idle, quiet, and every pull request stage short of the
            // merge: the work is underway.
            return "active";
    }
}

/** The status a space keeps for a kind: the first of it in the space's order. */
export function pickStatus(
    statuses: readonly { id: string; type: string; order: number }[],
    type: TaskStatusType | null
): string | null {
    if (!type) return null;
    const match = statuses
        .filter((status) => status.type === type)
        .sort((a, b) => a.order - b.order)[0];
    return match?.id ?? null;
}

export type LinkDecision = { kind: "keep" } | { kind: "hold" } | { kind: "move"; statusId: string };

/** What a link does to its item now. */
export function decideLinkMove(
    link: { appliedStatusId: string | null; held: boolean },
    item: { statusId: string | null },
    target: string | null
): LinkDecision {
    if (link.held) return { kind: "keep" };
    if (item.statusId !== link.appliedStatusId) return { kind: "hold" };
    if (!target || target === item.statusId) return { kind: "keep" };
    return { kind: "move", statusId: target };
}

/** A Tasks item a run is started on, as its plan reads it. */
export interface PlanItem {
    readonly id: string;
    readonly reference: string;
    readonly name: string;
    readonly description: string;
}

/** How much of an item's description the coordinator's plan quotes. */
const PLAN_DESCRIPTION_CAP = 600;

/**
 * A coordinator's objective for a run started from Tasks: the person's own
 * words, then every item with the id its worker is spawned for. Read by the
 * model, not shown to a person.
 */
export function planObjective(items: readonly PlanItem[], brief: string): string {
    // A fixed first line: the coordinator session is titled from it, and a
    // title holds one line.
    const lines = ["Work through these Tasks items.", ...(brief.trim() ? ["", brief.trim()] : []), "",
        "The plan is these Tasks items. Give each its own worker with coordinator_spawn and pass the item id as item, so its card on the board follows that worker:"
    ];
    for (const item of items) {
        lines.push(`- ${item.reference} ${item.name} (item ${item.id})`);
        const description = item.description.replace(/\s+/g, " ").trim();
        if (description) lines.push(`  ${description.slice(0, PLAN_DESCRIPTION_CAP)}`);
    }
    return lines.join("\n");
}

/** A worker's prompt for one item: what the item says, then the person's words. */
export function itemBrief(item: PlanItem, brief: string): string {
    return [`${item.reference}: ${item.name}`, item.description.trim(), brief.trim()]
        .filter((part) => part !== "")
        .join("\n\n");
}
