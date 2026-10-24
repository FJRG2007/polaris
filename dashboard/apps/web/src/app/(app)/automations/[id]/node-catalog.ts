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
    calendarEventStarting: { name: "calendar.event-starting", outcomes: [] }
} as const satisfies Record<string, { name: string; outcomes: readonly never[] }>;
export type PresetKey = keyof typeof EVENT_PRESETS;

const plain = (type: string): CatalogItem => ({ value: type, type });
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
    calendar: ["calendarEventStarting"]
};

/** Each app's steps, in the order its group lists them. */
const APP_STEPS: Readonly<Partial<Record<core.AppEventApp, readonly string[]>>> = {
    "game-servers": ["game-servers.action.power", "game-servers.action.command"],
    deploy: ["core.redeploy"]
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
 * (inserting on a connection); `apps` are the installed apps that bring nodes
 * or send events.
 */
export function catalogGroups(options: {
    readonly triggers: boolean;
    readonly apps: readonly string[];
}): CatalogGroup[] {
    const places = options.apps.includes(PLACES_APP);
    const groups: CatalogGroup[] = [];
    if (options.triggers) {
        groups.push(
            { id: "basics", items: ["core.manual", "core.schedule", "core.webhook"].map(plain) },
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
        { id: "data", items: ["core.set", "core.answer"].map(plain) },
        {
            id: "send",
            items: ["core.notify", "core.message", "core.chat", "core.http"].map(plain)
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

/** The node type and its starting settings for a picked value; null when it names nothing known. */
export function pickedNode(value: string): { type: string; config?: unknown } | null {
    const [type, key] = value.split("#", 2) as [string, string | undefined];
    if (key === undefined) return { type };
    const config = Object.hasOwn(EVENT_PRESETS, key) ? EVENT_PRESETS[key as PresetKey] : null;
    return type === "core.onEvent" && config ? { type, config: { ...config, outcomes: [] } } : null;
}

/** Whether a picked type starts an automation. */
export function isTriggerType(type: string): boolean {
    return core.nodeRole(type) === "trigger";
}
