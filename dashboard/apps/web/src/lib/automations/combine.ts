/**
 * Trigger combinators: "all of these within a window" and "at least N of
 * these". A member firing is remembered on the automation's `__when` trigger
 * row instead of starting a run; once enough members have fired inside the
 * window, one run starts with every member's data and the memory is cleared,
 * so each combination starts one run.
 *
 * Every caller runs under the intake lease (the outbox pass and the schedule
 * clock both do), so two firings never update the memory at once. The run is
 * started before the memory is cleared and its firing key comes from the
 * completing member's, so a pass that dies in between starts nothing twice.
 */

import { prisma } from "@polaris/db";
import * as core from "@polaris/core";
import { loadGraph, startRun, type Firing, type StartedRun } from "./engine";

/** The trigger row that holds a combinator's memory. Never armed by a node. */
export const WHEN_NODE = "__when";

/** Triggers that always start a run on their own: pressing "Run now" and being called are decisions, not events. */
const DIRECT = new Set(["core.manual", "core.called"]);

interface Member {
    readonly at: string;
    readonly key: string;
    readonly cause: Record<string, unknown>;
}

/** The members still inside the window, with this firing added. Pure, for the tests. */
export function rememberMember(
    members: Record<string, Member>,
    nodeId: string,
    member: Member,
    memberIds: readonly string[],
    windowSeconds: number,
    now: Date
): Record<string, Member> {
    const since = now.getTime() - windowSeconds * 1000;
    const kept: Record<string, Member> = {};
    for (const [id, entry] of Object.entries(members))
        if (memberIds.includes(id) && Date.parse(entry.at) >= since) kept[id] = entry;
    kept[nodeId] = member;
    return kept;
}

/** Start a run for a trigger firing, or remember it when the automation combines its triggers. */
export async function fireTrigger(firing: Firing): Promise<StartedRun | null> {
    const graph = await loadGraph(firing.versionId);
    const fired = graph?.nodes.find((node) => node.id === firing.triggerNodeId);
    if (!graph || !fired || graph.when.kind === "any" || DIRECT.has(fired.type) || firing.test)
        return startRun(firing);
    const memberIds = core
        .triggerNodes(graph)
        .filter((node) => node.enabled !== false && !DIRECT.has(node.type))
        .map((node) => node.id);
    const row = await prisma.automationTrigger.findUnique({
        where: { automationId_nodeId: { automationId: firing.automationId, nodeId: WHEN_NODE } },
        select: { state: true, versionId: true }
    });
    const stored =
        row?.versionId === firing.versionId
            ? ((row.state as { members?: Record<string, Member> } | null)?.members ?? {})
            : {};
    const now = new Date();
    const members = rememberMember(
        stored,
        firing.triggerNodeId,
        { at: now.toISOString(), key: firing.firingKey, cause: firing.cause },
        memberIds,
        graph.when.windowSeconds,
        now
    );
    const needs = core.combineNeeds(graph.when, memberIds.length);
    let run: StartedRun | null = null;
    if (Object.keys(members).length >= needs) {
        run = await startRun({
            ...firing,
            firingKey: `when:${firing.firingKey}`,
            cause: {
                ...firing.cause,
                members: Object.fromEntries(
                    Object.entries(members).map(([id, entry]) => [id, entry.cause])
                )
            },
            depth: Math.max(firing.depth, 0)
        });
    }
    const state = { members: run ? {} : members };
    await prisma.automationTrigger.upsert({
        where: { automationId_nodeId: { automationId: firing.automationId, nodeId: WHEN_NODE } },
        create: {
            automationId: firing.automationId,
            nodeId: WHEN_NODE,
            versionId: firing.versionId,
            eventType: "core.when",
            subjectKey: null,
            state: state as object
        },
        update: { versionId: firing.versionId, state: state as object }
    });
    return run;
}
