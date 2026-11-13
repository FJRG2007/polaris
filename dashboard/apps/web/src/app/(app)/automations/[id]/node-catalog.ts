/**
 * What the node picker offers, in groups a reader recognises: where a thing
 * comes from (Polaris itself, other automations, Places) for triggers, and
 * what it is for (logic, timing, data, sending) for steps.
 *
 * Every entry is a node the engine already runs. A preset is one of those
 * nodes with its settings filled in - "the NAS went offline" is the On event
 * trigger listening to the event the NAS watcher sends - so picking it needs
 * no event name typed by hand. Pure, so the tests can walk it.
 */

import * as core from "@polaris/core";

/** The app id Places contributes its nodes under. */
export const PLACES_APP = "home";

export type CatalogGroupId =
    | "basics"
    | "polaris"
    | "automations"
    | "places"
    | core.AppEventApp
    | "logic"
    | "timing"
    | "data"
    | "send";

export interface CatalogItem {
    /** What the picker hands back: the node type, or `<type>#<preset>`. */
    readonly value: string;
    readonly type: string;
    /** Set on a preset: its key under `picker.presets`. */
    readonly preset?: PresetKey;
    /** Set on a schedule preset: its key under `picker.schedules`. */
    readonly schedule?: SchedulePresetKey;
}

export interface CatalogGroup {
    readonly id: CatalogGroupId;
    readonly items: readonly CatalogItem[];
}

/** The events Polaris itself sends, by their key under `picker.presets`. */
export const EVENT_PRESETS = {
    publicIpChanged: { name: "network.public-ip-changed", outcomes: [] },
    nasOffline: { name: "nas.offline", outcomes: [] },
    nasDiskUnhealthy: { name: "nas.disk-unhealthy", outcomes: [] },
    nasDiskTemperature: { name: "nas.disk-temperature", outcomes: [] },
    nasPoolUsage: { name: "nas.pool-usage", outcomes: [] },
    nasPoolUnprotected: { name: "nas.pool-unprotected", outcomes: [] },
    nasBackupFailed: { name: "nas.backup-failed", outcomes: [] },
    nasBackupOverdue: { name: "nas.backup-overdue", outcomes: [] },
    automationFinished: { name: core.AUTOMATION_FINISHED_EVENT, outcomes: [] },
    gameServerStarted: { name: "game-server.started", outcomes: [] },
    gameServerStopped: { name: "game-server.stopped", outcomes: [] },
    gameServerCrashed: { name: "game-server.crashed", outcomes: [] },
    playerJoined: { name: "game-server.player-joined", outcomes: [] },
    deploySucceeded: { name: "deploy.succeeded", outcomes: [] },
    deployFailed: { name: "deploy.failed", outcomes: [] },
    taskCreated: { name: "task.created", outcomes: [] },
    taskCompleted: { name: "task.completed", outcomes: [] },
    chatMessage: { name: "chat.message", outcomes: [] },
    mailReceived: { name: "mail.received", outcomes: [] },
    driveFileUploaded: { name: "drive.file-uploaded", outcomes: [] },
    calendarEventStarting: { name: "calendar.event-starting", outcomes: [] },
    codeMentioned: { name: "code.mentioned", outcomes: [] },
    codeIssueOpened: { name: "code.issue-opened", outcomes: [] },
    codeIssueLabeled: { name: "code.issue-labeled", outcomes: [] },
    codePullRequestOpened: { name: "code.pull-request-opened", outcomes: [] },
    codePullRequestUpdated: { name: "code.pull-request-updated", outcomes: [] },
    codePullRequestMerged: { name: "code.pull-request-merged", outcomes: [] },
    codeReviewRequested: { name: "code.review-requested", outcomes: [] },
    codeReviewSubmitted: { name: "code.review-submitted", outcomes: [] },
    codeChecksFailed: { name: "code.checks-failed", outcomes: [] }
} as const satisfies Record<string, { name: string; outcomes: readonly never[] }>;
export type PresetKey = keyof typeof EVENT_PRESETS;

/**
 * Schedules a reader asks for by name ("every day at eight"), each the
 * schedule trigger with its kind already chosen, so the picker shows them
 * instead of leaving them behind a field inside "On a schedule".
 */
export const SCHEDULE_PRESETS = {
    daily: { kind: "daily", times: ["08:00"], days: [] },
    weekdays: { kind: "daily", times: ["08:00"], days: [1, 2, 3, 4, 5] },
    monthly: { kind: "monthly", days: [1], times: ["08:00"] },
    yearly: { kind: "yearly", dates: [{ month: 1, day: 1 }], times: ["08:00"] },
    once: { kind: "once", at: "" },
    every: { kind: "every", amount: 15, unit: "minutes" }
} as const;
export type SchedulePresetKey = keyof typeof SCHEDULE_PRESETS;

const plain = (type: string): CatalogItem => ({ value: type, type });
const schedule = (key: SchedulePresetKey): CatalogItem => ({
    value: `core.schedule#${key}`,
    type: "core.schedule",
    schedule: key
});
const preset = (key: PresetKey): CatalogItem => ({
    value: `core.onEvent#${key}`,
    type: "core.onEvent",
    preset: key
});

/** Each app's events, in the order its group lists them. */
const APP_EVENT_PRESETS: Readonly<Record<core.AppEventApp, readonly PresetKey[]>> = {
    "game-servers": ["gameServerStarted", "gameServerStopped", "gameServerCrashed", "playerJoined"],
    deploy: ["deploySucceeded", "deployFailed"],
    chat: ["chatMessage"],
    tasks: ["taskCreated", "taskCompleted"],
    mail: ["mailReceived"],
    drive: ["driveFileUploaded"],
    calendar: ["calendarEventStarting"],
    code: [
        "codePullRequestOpened",
        "codePullRequestUpdated",
        "codePullRequestMerged",
        "codeReviewRequested",
        "codeReviewSubmitted",
        "codeChecksFailed",
        "codeIssueOpened",
        "codeIssueLabeled",
        "codeMentioned"
    ]
};

/** Each app's steps, in the order its group lists them. */
const APP_STEPS: Readonly<Partial<Record<core.AppEventApp, readonly string[]>>> = {
    "game-servers": ["game-servers.action.power", "game-servers.action.command"],
    deploy: ["core.redeploy"],
    code: ["core.agentWork"]
};

const PLACES_TRIGGERS = ["time", "interval", "change", "stays", "threshold", "sun"].map(
    (kind) => `${PLACES_APP}.trigger.${kind}`
);
const PLACES_STEPS = [
    `${PLACES_APP}.condition.check`,
    ...["device", "wait", "notify", "run", "privacy"].map((kind) => `${PLACES_APP}.action.${kind}`)
];

/**
 * The groups the picker shows. `triggers` is false where only a step fits
 * (inserting on a connection), `steps` false where only a trigger does (the
 * list's triggers); `apps` are the installed apps that bring nodes or send events.
 */
export function catalogGroups(options: {
    readonly triggers: boolean;
    readonly steps?: boolean;
    readonly apps: readonly string[];
}): CatalogGroup[] {
    const places = options.apps.includes(PLACES_APP);
    const groups: CatalogGroup[] = [];
    if (options.triggers) {
        groups.push(
            {
                id: "basics",
                items: [
                    plain("core.manual"),
                    plain("core.schedule"),
                    ...(Object.keys(SCHEDULE_PRESETS) as SchedulePresetKey[]).map(schedule),
                    plain("core.webhook")
                ]
            },
            {
                id: "polaris",
                items: [
                    plain("core.connectivity"),
                    plain("core.threshold"),
                    preset("publicIpChanged"),
                    preset("nasOffline"),
                    preset("nasDiskUnhealthy"),
                    preset("nasDiskTemperature"),
                    preset("nasPoolUsage"),
                    preset("nasPoolUnprotected"),
                    preset("nasBackupFailed"),
                    preset("nasBackupOverdue")
                ]
            },
            {
                id: "automations",
                items: [
                    preset("automationFinished"),
                    plain("core.failed"),
                    plain("core.onEvent"),
                    plain("core.called")
                ]
            }
        );
        if (places) groups.push({ id: "places", items: PLACES_TRIGGERS.map(plain) });
        // An app's events only where the app is here to send them.
        for (const app of core.APP_EVENT_APPS)
            if (options.apps.includes(app))
                groups.push({ id: app, items: APP_EVENT_PRESETS[app].map(preset) });
    }
    if (options.steps === false) return mergeSame(groups);
    groups.push(
        {
            id: "logic",
            items: [
                "core.if",
                "core.switch",
                "core.parallel",
                "core.join",
                "core.forEach",
                "core.repeat",
                "core.try",
                "core.stop"
            ].map(plain)
        },
        { id: "timing", items: ["core.wait", "core.waitEvent", "core.waitCondition"].map(plain) },
        { id: "data", items: ["core.set", "core.code", "core.askAgent", "core.answer"].map(plain) },
        {
            id: "send",
            items: ["core.notify", "core.alert", "core.message", "core.chat", "core.http"].map(plain)
        },
        // Steps that reach other automations; merged into the triggers' group of that name.
        { id: "automations", items: ["core.run", "core.announce"].map(plain) }
    );
    if (places) groups.push({ id: "places", items: PLACES_STEPS.map(plain) });
    // An app's steps only where the app is here to do them; merged into its events' group.
    for (const app of core.APP_EVENT_APPS) {
        const steps = APP_STEPS[app];
        if (steps && options.apps.includes(app)) groups.push({ id: app, items: steps.map(plain) });
    }
    return mergeSame(groups);
}

/** Two groups of one id (Places triggers and steps) shown as one. */
function mergeSame(groups: CatalogGroup[]): CatalogGroup[] {
    const out: CatalogGroup[] = [];
    for (const group of groups) {
        const seen = out.find((entry) => entry.id === group.id);
        if (seen) out[out.indexOf(seen)] = { id: group.id, items: [...seen.items, ...group.items] };
        else out.push(group);
    }
    return out;
}

/**
 * The node type and its starting settings for a picked value; null when it names nothing known.
 * A "once" schedule starts at the next whole hour of `now` on this device's
 * clock, so it is not already in the past when it lands on the canvas.
 */
export function pickedNode(
    value: string,
    now: Date = new Date()
): { type: string; config?: unknown } | null {
    const [type, key] = value.split("#", 2) as [string, string | undefined];
    if (key === undefined) return { type };
    if (type === "core.schedule") {
        if (!Object.hasOwn(SCHEDULE_PRESETS, key)) return null;
        const preset = SCHEDULE_PRESETS[key as SchedulePresetKey];
        return {
            type,
            config: preset.kind === "once" ? { kind: "once", at: nextWholeHour(now) } : structuredClone(preset)
        };
    }
    const config = Object.hasOwn(EVENT_PRESETS, key) ? EVENT_PRESETS[key as PresetKey] : null;
    return type === "core.onEvent" && config ? { type, config: { ...config, outcomes: [] } } : null;
}

/** `YYYY-MM-DDTHH:00` of the hour after `now`, on this device's clock. */
function nextWholeHour(now: Date): string {
    const at = new Date(now.getTime() + 3_600_000);
    const pad = (value: number) => String(value).padStart(2, "0");
    return `${at.getFullYear()}-${pad(at.getMonth() + 1)}-${pad(at.getDate())}T${pad(at.getHours())}:00`;
}

/** Whether a picked type starts an automation. */
export function isTriggerType(type: string): boolean {
    return core.nodeRole(type) === "trigger";
}
