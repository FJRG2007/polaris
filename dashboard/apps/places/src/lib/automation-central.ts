/**
 * Places in the central automations engine: the node types it contributes,
 * and the bridge that lets its own trigger rules decide central firings.
 *
 * Triggers are not re-implemented. A central automation's Places triggers are
 * handed to the Places engine as one more automation (`centralRecords`), so a
 * held "for at least", a set's first or all, a reading crossing a line and the
 * sun fire exactly as they always did; the firing then starts a central run
 * (`fireCentral`). Conditions and steps run through the same functions the
 * Places engine uses for its own runs.
 *
 * Every node acts as the automation's run-as account, its rights asked again
 * on every run: the right to keep automations here for a condition, the right
 * to operate the devices for a step - never more than they could do by hand.
 *
 * Server-only.
 */

import { placesTFor } from "./i18n";
import { prisma } from "@polaris/db";
import { homeInstall } from "./access";
import * as auto from "./automation-kinds";
import * as nodes from "./automation-nodes";
import { host, type AppHostTypes } from "@polaris/app-host";
import { automationEngine, mayOperate } from "./automation-runtime";
import { MAX_DEPTH, RECHECK_MS, type AutomationRecord } from "./automation-engine";

type ServerNode = Awaited<
    ReturnType<NonNullable<AppHostTypes["AppExtension"]["automationNodes"]>>
>[number];

const { StepError, StepRefusal } = host.automations;
const { notify } = host.notificationsDispatch;

/** The wait key a Places "wait until" step rechecks under; woken on every device change. */
export const RECHECK_KEY = "recheck:home";

/** Prefix of a moved automation's `legacyRef`. */
export const LEGACY_PREFIX = "place:";

const NO_CONDITIONS = { match: "all" as const, groups: [] };

/**
 * The central automations with Places triggers on this install, as the Places
 * engine reads automations: one record each, carrying only its triggers.
 */
export async function centralRecords(installedAppId: string): Promise<AutomationRecord[]> {
    const rows = await host.automations.appTriggers(nodes.NODE_APP);
    if (rows.length === 0) return [];
    const byAutomation = new Map<string, typeof rows>();
    for (const row of rows) byAutomation.set(row.automationId, [...(byAutomation.get(row.automationId) ?? []), row]);
    const placeIds = new Set(
        rows.flatMap((row) => {
            const id = (row.config as { placeId?: unknown } | null)?.placeId;
            return typeof id === "string" ? [id] : [];
        })
    );
    const places = await prisma.place.findMany({
        where: { id: { in: [...placeIds] }, installedAppId },
        select: { id: true, latitude: true, longitude: true }
    });
    const placeById = new Map(places.map((place) => [place.id, place]));
    const out: AutomationRecord[] = [];
    for (const [automationId, triggers] of byAutomation) {
        const first = triggers[0]!;
        if (!first.runAsId) continue;
        const parsed = triggers.flatMap((row) => {
            const trigger = nodes.triggerOfNode(row.nodeId, row.config);
            const place = placeById.get((row.config as { placeId?: string }).placeId ?? "");
            return trigger && place ? [{ trigger, place }] : [];
        });
        if (parsed.length === 0) continue;
        // Every Places trigger of one automation names a place; the first one's is where its
        // clock and sun are read, which is the one place the converter writes.
        const place = parsed[0]!.place;
        out.push({
            id: `central:${automationId}`,
            installedAppId,
            placeId: place.id,
            ownerId: first.runAsId,
            name: first.name,
            enabled: true,
            definition: {
                timeZone: first.timeZone,
                triggers: parsed.map((entry) => entry.trigger),
                conditions: NO_CONDITIONS,
                actions: []
            } as unknown as auto.AutomationDefinition,
            armedAt: first.armedAt,
            location:
                place.latitude !== null && place.longitude !== null
                    ? { latitude: place.latitude, longitude: place.longitude }
                    : null,
            central: {
                automationId,
                legacyId: first.legacyRef?.startsWith(LEGACY_PREFIX)
                    ? first.legacyRef.slice(LEGACY_PREFIX.length)
                    : null
            }
        });
    }
    return out;
}

/**
 * A Places trigger of a central automation fired. A firing the old engine
 * already ran before the move (the same 07:00) is not run a second time.
 */
export async function fireCentral(
    automation: AutomationRecord,
    firingKey: string,
    cause: auto.RunCause,
    depth: number
): Promise<boolean> {
    const central = automation.central;
    if (!central) return false;
    if (central.legacyId) {
        const before = await prisma.placeAutomationRun.findFirst({
            where: { automationId: central.legacyId, firingKey },
            select: { id: true }
        });
        if (before) return false;
    }
    return host.automations.fireAppTrigger({
        automationId: central.automationId,
        nodeId: cause.triggerId,
        firingKey,
        cause: { ...cause },
        depth
    });
}

/** The Places automation a node runs as part of: its place, owner and zone. */
async function recordFor(
    placeId: string,
    io: { actor: { id: string }; automationId: string; timeZone: string },
    name: string,
    conditions: auto.AutomationDefinition["conditions"] = NO_CONDITIONS
): Promise<AutomationRecord> {
    const install = await homeInstall();
    const place = install
        ? await prisma.place.findFirst({
              where: { id: placeId, installedAppId: install.id },
              select: { id: true, latitude: true, longitude: true }
          })
        : null;
    if (!install || !place) throw new StepError("placeGone");
    const record: AutomationRecord = {
        id: `central:${io.automationId}`,
        installedAppId: install.id,
        placeId: place.id,
        ownerId: io.actor.id,
        name,
        enabled: true,
        definition: {
            timeZone: io.timeZone,
            triggers: [],
            conditions,
            actions: []
        } as unknown as auto.AutomationDefinition,
        armedAt: new Date(0),
        location:
            place.latitude !== null && place.longitude !== null
                ? { latitude: place.latitude, longitude: place.longitude }
                : null,
        central: { automationId: io.automationId, legacyId: null }
    };
    return automationEngine().placed(record);
}

/** The run's cause as the Places engine wrote it, for "Triggered by". */
function causeOf(trigger: Record<string, unknown>): auto.RunCause {
    return { at: new Date().toISOString(), ...trigger } as unknown as auto.RunCause;
}

async function requireRight(actorId: string, right: "run" | "control"): Promise<void> {
    if (!(await mayOperate(actorId, right))) throw new StepRefusal("placesOwner");
}

const TRIGGER_META = { role: "trigger", ports: [], idempotent: true } as const;

function triggerNode(kind: nodes.TriggerNodeKind): ServerNode {
    return {
        type: nodes.triggerNodeType(kind),
        meta: TRIGGER_META as never,
        config: nodes.triggerNodeConfig(kind)
    };
}

const conditionNode: ServerNode<nodes.ConditionNodeConfig> = {
    type: nodes.CONDITION_NODE_TYPE,
    meta: { role: "condition", ports: ["then", "else"], idempotent: true } as never,
    config: nodes.conditionNodeConfig,
    run: async (config, context, io) => {
        await requireRight(io.actor.id, "run");
        const record = await recordFor(config.placeId, io, context.automation.name, {
            match: config.match,
            groups: config.groups
        });
        const holds = await automationEngine().conditionsHold(
            record,
            new Date(),
            causeOf(context.trigger)
        );
        io.recordInput({ placeId: config.placeId, groups: config.groups.length });
        // Nothing wired to "else": the run ends skipped, as a Places run whose conditions failed.
        if (!holds && !io.leads("else")) return { stop: { as: "skipped", reason: "conditions" } };
        return { output: { holds }, port: holds ? "then" : "else" };
    }
};

type DeviceConfig = Omit<Extract<auto.Step, { kind: "device" }>, "id"> & { placeId: string };
type WaitConfig = Omit<Extract<auto.Step, { kind: "wait" }>, "id"> & { placeId: string };
type NotifyConfig = Omit<Extract<auto.Step, { kind: "notify" }>, "id"> & { placeId: string };
type RunConfig = Omit<Extract<auto.Step, { kind: "run" }>, "id"> & { placeId: string };

const deviceNode: ServerNode<DeviceConfig> = {
    type: nodes.stepNodeType("device"),
    meta: { role: "action", ports: [], idempotent: false } as never,
    config: nodes.stepNodeConfig("device") as never,
    run: async (config, context, io) => {
        await requireRight(io.actor.id, "control");
        const record = await recordFor(config.placeId, io, context.automation.name);
        const step = auto.resolveTargets(
            { ...config, id: "device" } as Extract<auto.Step, { kind: "device" }>,
            await placeScope(record)
        );
        io.recordInput({ do: step.do, devices: auto.deviceTargets(step) });
        const outcome = await automationEngine().actFor(record, io.depth, step);
        if (outcome.outcome === "refused") throw new StepRefusal(outcome.code ?? "placesOwner");
        if (outcome.outcome !== "ok")
            throw new StepError(outcome.code ?? "placesDeviceRefused", {
                ...(outcome.said ? { said: outcome.said } : {})
            });
        return { output: { done: step.do, devices: auto.deviceTargets(step) } };
    }
};

/** A record's rooms and floors, read into devices (a step names them by room). */
async function placeScope(record: AutomationRecord): Promise<auto.TargetScope> {
    const [devices, rooms] = await Promise.all([
        prisma.placeDevice.findMany({
            where: { installedAppId: record.installedAppId, placeId: record.placeId, roomId: { not: null } },
            select: { id: true, kind: true, controllable: true, roomId: true },
            take: 1000
        }),
        prisma.placeRoom.findMany({
            where: { installedAppId: record.installedAppId, placeId: record.placeId },
            select: { id: true, floorId: true },
            take: 500
        })
    ]);
    return { devices, rooms: rooms.map((room) => ({ id: room.id, floorId: room.floorId ?? "" })) };
}

const waitNode: ServerNode<WaitConfig> = {
    type: nodes.stepNodeType("wait"),
    meta: { role: "action", ports: [], idempotent: true } as never,
    config: nodes.stepNodeConfig("wait") as never,
    run: async (config, context, io) => {
        await requireRight(io.actor.id, "run");
        const record = await recordFor(config.placeId, io, context.automation.name);
        const step = auto.resolveTargets(
            { ...config, id: "wait" } as Extract<auto.Step, { kind: "wait" }>,
            await placeScope(record)
        );
        const reached = await automationEngine().waitReached(record, step);
        if (reached === null) throw new StepError("deviceGone");
        const now = Date.now();
        const deadline = io.since.getTime() + step.timeoutMinutes * 60_000;
        io.recordInput({ is: step.is, until: new Date(deadline).toISOString() });
        if (reached) return { output: { reached: true, timedOut: false } };
        if (now < deadline)
            return {
                wait: { until: new Date(Math.min(deadline, now + RECHECK_MS)), recheck: RECHECK_KEY }
            };
        // Stop: the run ends stopped there, as a Places run did; nothing after it is done.
        return step.onTimeout === "stop"
            ? { stop: { as: "succeeded", reason: "timedOut" } }
            : { output: { reached: false, timedOut: true } };
    }
};

const notifyNode: ServerNode<NotifyConfig> = {
    type: nodes.stepNodeType("notify"),
    meta: { role: "action", ports: [], idempotent: false } as never,
    config: nodes.stepNodeConfig("notify") as never,
    run: async (config, context, io) => {
        await requireRight(io.actor.id, "run");
        const t = await placesTFor(io.actor.id);
        await notify({
            userId: io.actor.id,
            event: "places.automation",
            title: t("automations.notice.title", { name: context.automation.name }),
            body: config.message,
            href: `/automations/${io.automationId}`,
            metadata: { automationId: io.automationId, runId: io.runId }
        });
        return { output: { sent: true } };
    }
};

const runNode: ServerNode<RunConfig> = {
    type: nodes.stepNodeType("run"),
    meta: { role: "action", ports: [], idempotent: true } as never,
    config: nodes.stepNodeConfig("run") as never,
    run: async (config, context, io) => {
        await requireRight(io.actor.id, "run");
        if (io.depth + 1 > MAX_DEPTH) throw new StepRefusal("loop");
        // A moved step still names the Places automation it ran; that one's
        // central twin is the one meant.
        const install = await homeInstall();
        const named = install
            ? await prisma.placeAutomation.findFirst({
                  where: { id: config.automationId, installedAppId: install.id },
                  select: { id: true }
              })
            : null;
        if (!named) throw new StepRefusal("callForbidden");
        const target = await host.automations.automationForLegacy(`${LEGACY_PREFIX}${named.id}`);
        if (!target) return { output: { started: false } };
        const started = await host.automations.fireAppTrigger({
            automationId: target,
            firingKey: `chain:${io.idempotencyKey}`,
            cause: {
                kind: "automation",
                byAutomationId: io.automationId,
                byName: context.automation.name,
                at: new Date().toISOString()
            },
            depth: io.depth + 1
        });
        // Switched off, or held back by its own limit: skipped, the run goes on.
        return { output: { started } };
    }
};

/** Every node type Places contributes. */
export function placesAutomationNodes(): ServerNode[] {
    return [
        ...nodes.TRIGGER_NODE_KINDS.map(triggerNode),
        conditionNode as ServerNode,
        deviceNode as ServerNode,
        waitNode as ServerNode,
        notifyNode as ServerNode,
        runNode as ServerNode
    ];
}
