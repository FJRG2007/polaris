/**
 * Watch's alarms, as tools an assistant can call: the ones that say when an
 * app, a server or a domain goes over a line or stops answering.
 *
 * Every read and write goes through `watch-service`, the module the Watch
 * screens use, as the account the call acts for, on the permissions those
 * screens ask for - reading takes `deploy.read`, changing takes
 * `deploy.manage`. A key held to one deploy project is refused: an alarm
 * reaches every target its owner has, which is wider than that key.
 *
 * Targets and alarms are named the way the person named them. Only an exact
 * name is acted on; two of one name are named back rather than guessed at.
 */

import { z } from "zod";
import * as core from "@polaris/core";
import * as watch from "@/lib/watch-service";
import { defineMcpSearch, preferMatches } from "../search";
import { alarmInputSchema } from "@/lib/watch/watch-schema";
import { McpRefusal, type McpCaller, type McpTool } from "../protocol";
import {
    ALARM_METRICS,
    ALARM_TARGET_TYPES,
    alarmUnit,
    metricsFor,
    type AlarmTargetType
} from "@/lib/watch/alarm-metrics";

/** The account a call acts for, refused for a key held to one project. */
function ownerOf(caller: McpCaller): string {
    if (caller.projectId)
        throw new McpRefusal(
            "This key is held to one deploy project; Watch alarms reach every app and server of the account."
        );
    return caller.userId;
}

/** One thing an alarm can watch, with the name a person calls it by. */
interface Target {
    readonly type: AlarmTargetType;
    readonly id: string;
    readonly name: string;
}

function targetsOf(found: watch.AlarmTargets): Target[] {
    return [
        ...found.apps.map((app) => ({ type: "application" as const, id: app.id, name: app.name })),
        ...found.hosts.map((host) => ({ type: "host" as const, id: host.id, name: host.name })),
        ...found.domains.map((domain) => ({
            type: "domain" as const,
            id: domain.id,
            name: domain.hostname
        }))
    ];
}

const KIND: Record<AlarmTargetType, string> = {
    application: "app",
    host: "server",
    domain: "domain"
};

/** "CPU over 80 % for 2 checks" - what an alarm watches for, in one line. */
function conditionOf(alarm: watch.AlarmView): string {
    const unit = alarmUnit(alarm.metric, alarm.targetType);
    if (unit === null) return `${alarm.metric} stops answering for ${alarm.forPeriods} checks`;
    const over = alarm.operator === "lt" ? "under" : "over";
    return `${alarm.metric} ${over} ${alarm.threshold} ${unit} for ${alarm.forPeriods} checks`;
}

function describeAlarm(alarm: watch.AlarmView, names: ReadonlyMap<string, string>) {
    return {
        id: alarm.id,
        name: alarm.name,
        target: names.get(alarm.targetId) ?? alarm.targetId,
        targetType: alarm.targetType,
        condition: conditionOf(alarm),
        enabled: alarm.enabled,
        state: alarm.state,
        lastChecked: alarm.lastEvaluatedAt
    };
}

/** The alarm a name or an id means, among the account's own. */
async function alarmNamed(owner: string, wanted: string): Promise<watch.AlarmView> {
    const alarms = await watch.listAlarms(owner);
    const byId = alarms.find((alarm) => alarm.id === wanted);
    if (byId) return byId;
    const pick = core.pickByName(alarms, wanted, (alarm) => alarm.name);
    if (pick.kind === "one") return pick.item;
    throw new McpRefusal(
        core.missedNameText(pick, wanted, "alarm", (alarm) => `${alarm.name} [${alarm.id}]`)
    );
}

// ---------------------------------------------------------------------------
// Reading
// ---------------------------------------------------------------------------

/** How many recent firings a read carries. */
const EVENTS_LISTED = 10;

const listInput = z.object({});

const listTool: McpTool<z.infer<typeof listInput>> = {
    name: "watch_alarms",
    // i18n-ignore shown by the calling client, which has no locale to ask for
    title: "List monitoring alarms",
    description:
        // i18n-ignore read by the calling model, not shown to a person
        "The account's monitoring alarms - CPU, memory, disk, network or reachability of an app, server or domain - with whether each is firing, the last times they fired, and the apps, servers and domains an alarm can watch.",
    input: listInput,
    category: "development",
    scope: "deploy.read",
    readOnly: true,
    async run(_input, caller) {
        const owner = ownerOf(caller);
        const [alarms, events, found] = await Promise.all([
            watch.listAlarms(owner),
            watch.listRecentAlarmEvents(owner, EVENTS_LISTED),
            watch.listAlarmTargets(owner)
        ]);
        const targets = targetsOf(found);
        const names = new Map(targets.map((target) => [target.id, target.name]));
        const rows = alarms.map((alarm) => describeAlarm(alarm, names));
        const lines = rows.map(
            (row) =>
                `${row.name}: ${row.target} - ${row.condition}; ${row.enabled ? row.state : "off"}  [${row.id}]`
        );
        const fired = events.map(
            (event) => `${event.createdAt}  ${event.alarmName}: ${event.kind}`
        );
        return {
            text: [
                lines.length > 0 ? lines.join("\n") : "No alarms yet.",
                fired.length > 0 ? `\nRecently:\n${fired.join("\n")}` : "",
                `\nCan watch: ${
                    targets.map((target) => `${target.name} (${KIND[target.type]})`).join(", ") ||
                    "nothing yet"
                }`
            ].join(""),
            structured: {
                alarms: rows,
                recent: events,
                targets: targets.map((target) => ({
                    ...target,
                    metrics: metricsFor(target.type)
                }))
            }
        };
    }
};

// ---------------------------------------------------------------------------
// Changing
// ---------------------------------------------------------------------------

const createInput = z.object({
    name: z.string().trim().min(1).max(80).describe("What to call the alarm."),
    target: z
        .string()
        .trim()
        .min(1)
        .max(253)
        .describe("The app, server or domain to watch: its name, hostname or id."),
    targetType: z
        .enum(ALARM_TARGET_TYPES)
        .optional()
        .describe("Only needed when an app, a server and a domain share the name."),
    metric: z
        .enum(ALARM_METRICS)
        .describe(
            "What to watch. Apps: cpu, memory, disk, network_in, network_out, service (is it up). Servers: cpu, memory, disk, network_in, network_out. Domains: http (does it answer)."
        ),
    operator: z
        .enum(["gt", "lt"])
        .default("gt")
        .describe("Fire when the reading goes over (gt) or under (lt) the threshold."),
    threshold: z
        .number()
        .min(0)
        .max(100000)
        .optional()
        .describe(
            "The line, in the metric's unit: % for cpu and memory (and a server's disk), GB for an app's disk, MB/s for network. Not used for service or http."
        ),
    forPeriods: z
        .number()
        .int()
        .min(1)
        .max(10)
        .default(2)
        .describe("How many checks in a row it must hold before the alarm fires.")
});

const createTool: McpTool<z.infer<typeof createInput>> = {
    name: "watch_alarm_create",
    // i18n-ignore shown by the calling client, which has no locale to ask for
    title: "Create a monitoring alarm",
    description:
        // i18n-ignore read by the calling model, not shown to a person
        "Create an alarm that notifies this account when an app, server or domain goes over or under a line, or stops answering.",
    input: createInput,
    category: "development",
    scope: "deploy.manage",
    readOnly: false,
    destructive: false,
    async run(input, caller) {
        const owner = ownerOf(caller);
        const targets = targetsOf(await watch.listAlarmTargets(owner)).filter(
            (target) => !input.targetType || target.type === input.targetType
        );
        const target =
            targets.find((candidate) => candidate.id === input.target) ??
            (() => {
                const pick = core.pickByName(targets, input.target, (candidate) => candidate.name);
                if (pick.kind === "one") return pick.item;
                throw new McpRefusal(
                    core.missedNameText(
                        pick,
                        input.target,
                        "app, server or domain",
                        (candidate) => `${candidate.name} (${KIND[candidate.type]})`
                    )
                );
            })();
        const parsed = alarmInputSchema.safeParse({
            name: input.name,
            targetType: target.type,
            targetId: target.id,
            metric: input.metric,
            operator: input.operator,
            threshold: input.threshold,
            forPeriods: input.forPeriods
        });
        if (!parsed.success) {
            throw new McpRefusal(
                `${parsed.error.issues[0]?.message ?? "Check the alarm"}. ${target.name} is a ${
                    KIND[target.type]
                }, which can watch: ${metricsFor(target.type).join(", ")}.`
            );
        }
        const id = await watch.createAlarm(owner, parsed.data);
        return {
            text: `Created "${input.name}" on ${target.name} (${id}).`,
            structured: { id }
        };
    }
};

const changeInput = z.object({
    alarm: z.string().trim().min(1).max(200).describe("The alarm, by its name or id."),
    action: z
        .enum(["enable", "disable", "delete"])
        .describe("Turn it on, turn it off, or delete it.")
});

const changeTool: McpTool<z.infer<typeof changeInput>> = {
    name: "watch_alarm_change",
    // i18n-ignore shown by the calling client, which has no locale to ask for
    title: "Turn a monitoring alarm on, off or delete it",
    description:
        // i18n-ignore read by the calling model, not shown to a person
        "Turn one of the account's monitoring alarms on or off, or delete it. Turning one back on starts it from a clean slate.",
    input: changeInput,
    category: "development",
    scope: "deploy.manage",
    readOnly: false,
    destructive: true,
    async run(input, caller) {
        const owner = ownerOf(caller);
        const alarm = await alarmNamed(owner, input.alarm);
        if (input.action === "delete") await watch.deleteAlarm(owner, alarm.id);
        else await watch.setAlarmEnabled(owner, alarm.id, input.action === "enable");
        const done = { enable: "On", disable: "Off", delete: "Deleted" }[input.action];
        return { text: `${done}: "${alarm.name}".`, structured: { id: alarm.id } };
    }
};

/** The account's alarms, for `polaris_search`. */
export const WATCH_SEARCH = defineMcpSearch({
    id: "watch.alarms",
    app: "watch",
    category: "development",
    scope: "deploy.read",
    async search(query, caller, limit) {
        if (caller.projectId) return [];
        const alarms = await watch.listAlarms(caller.userId);
        return preferMatches(alarms, query, [{ text: (alarm) => alarm.name }], limit).map(
            (alarm) => ({
                id: alarm.id,
                name: alarm.name,
                kind: "monitoring alarm",
                keywords: [alarm.metric],
                next: [
                    { tool: "watch_alarms", args: {} },
                    { tool: "watch_alarm_change", args: { alarm: alarm.id } }
                ]
            })
        );
    }
});

export const WATCH_TOOLS = [listTool, createTool, changeTool] as unknown as McpTool<never>[];
