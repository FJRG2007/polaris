/**
 * How Polaris's own apps tell automations that something happened to them: a
 * deploy finished, a game server started, a task was completed.
 *
 * An event goes out only when some automation is listening for it, and names
 * exactly the automations whose runner may see the thing it is about - the same
 * check the app's own screen makes - so a message in a private channel never
 * starts the automation of somebody outside it. Nobody listening costs one
 * indexed read; nothing is written.
 *
 * Never throws into the caller: the deploy, the task or the message already
 * happened, and an automation must not undo it.
 */

import { prisma } from "@polaris/db";
import * as core from "@polaris/core";
import type { RunActor } from "./types";
import { automationRunner } from "./runner";
import { sessionCan, type SessionUser } from "@/lib/session";
import { AUDIENCE_KEY, emitAutomationEvent, kickIntake } from "./outbox";
import { isAppInstalled } from "@/lib/apps/install-presence";

/** Whether the account an automation runs as may know about this one thing. */
export type MayReceive = (runner: RunActor) => Promise<boolean>;

interface AudienceAutomation {
    readonly id: string;
    readonly orgId: string | null;
    readonly userId: string | null;
    readonly runAsId: string | null;
}

/** Whether any automation listens for `name`: a write touching many things asks once. */
export async function anyListening(name: string): Promise<boolean> {
    const found = await prisma.automationTrigger.findFirst({
        where: { eventType: "core.event", subjectKey: name },
        select: { id: true }
    });
    return found !== null;
}

/** The automations listening for `name` whose runner may receive it, read a page at a time. */
export async function audienceFor(name: string, mayReceive: MayReceive): Promise<string[]> {
    const out = new Set<string>();
    const decided = new Map<string, Promise<boolean>>();
    const decide = (automation: AudienceAutomation): Promise<boolean> => {
        const shelf = `${automation.runAsId}:${automation.orgId}:${automation.userId}`;
        let answer = decided.get(shelf);
        if (!answer) {
            answer = automationRunner(automation)
                .then((runner) => (runner ? mayReceive(runner) : false))
                .catch(() => false);
            decided.set(shelf, answer);
        }
        return answer;
    };
    let cursor: string | undefined;
    for (;;) {
        const page = await prisma.automationTrigger.findMany({
            where: { eventType: "core.event", subjectKey: name, automation: { enabled: true } },
            orderBy: { id: "asc" },
            take: core.AUTOMATION_LIMITS.perShelf,
            ...(cursor ? { cursor: { id: cursor }, skip: 1 } : {}),
            select: {
                id: true,
                automation: { select: { id: true, orgId: true, userId: true, runAsId: true } }
            }
        });
        const fresh = page.filter(({ automation }) => !out.has(automation.id));
        const answers = await Promise.all(fresh.map(({ automation }) => decide(automation)));
        fresh.forEach(({ automation }, index) => {
            if (answers[index]) out.add(automation.id);
        });
        const last = page.at(-1);
        if (!last || page.length < core.AUTOMATION_LIMITS.perShelf) break;
        cursor = last.id;
    }
    return [...out];
}

/**
 * Send one app event. `key` makes it once-only: the same thing reported twice
 * (a retried completion path) starts nothing new. Returns whether it was sent.
 */
export async function emitAppEvent<Name extends core.AppEventName>(
    name: Name,
    payload: core.AppEventPayload<Name>,
    options: { readonly key: string; readonly mayReceive: MayReceive }
): Promise<boolean> {
    try {
        const data = core.parseAppEventPayload(name, payload);
        if (!data) {
            console.error(`polaris: the ${name} event did not match its shape and was not sent`);
            return false;
        }
        const audience = await audienceFor(name, options.mayReceive);
        if (audience.length === 0) return false;
        const id = await emitAutomationEvent("core.event", {
            subjectKey: name,
            payload: { name, payload: data, [AUDIENCE_KEY]: audience },
            dedupeKey: `${name}:${options.key}`
        });
        if (id) void kickIntake().catch(() => undefined);
        return id !== null;
    } catch (caught) {
        console.error(`polaris: the ${name} event could not be sent:`, caught);
        return false;
    }
}

/** The permission each built-in app's events need; an installable app also has to be here. */
const APP_PERMISSION: Readonly<Record<core.AppEventApp, core.Permission>> = {
    "game-servers": "deploy.read",
    deploy: "deploy.read",
    chat: "chat.use",
    tasks: "tasks.read",
    mail: "mail.use",
    drive: "drive.read",
    calendar: "calendar.use",
    code: "agents.read"
};
const INSTALLABLE: Partial<Record<core.AppEventApp, string>> = {
    "game-servers": core.GAME_SERVERS_APP_ID,
    calendar: "calendar"
};

/** The apps whose events this account may build automations on. */
export async function eventApps(user: SessionUser): Promise<core.AppEventApp[]> {
    const answers = await Promise.all(
        core.APP_EVENT_APPS.map(async (app) => {
            const install = INSTALLABLE[app];
            if (install && !(await isAppInstalled(install).catch(() => false))) return null;
            return (await sessionCan(user, APP_PERMISSION[app]).catch(() => false)) ? app : null;
        })
    );
    return answers.filter((app): app is core.AppEventApp => app !== null);
}

/** What the trigger menu needs of one event an installed app declares in its manifest. */
export interface AppEventView {
    /** `<app id>.<event>`: the name an "On event" trigger listens for. */
    readonly name: string;
    readonly app: string;
    readonly appName: string;
    readonly label: string;
    /** Its payload fields, offered to later steps as `trigger.payload.<field>`. */
    readonly fields: readonly string[];
}

/**
 * The manifest events this account may build automations on, of the apps
 * installed here: each behind the permission it declares - one of the app's
 * own - so a trigger its runner could never receive is not offered.
 */
export async function appEventViews(
    user: SessionUser,
    installed: (app: string) => Promise<boolean> = isAppInstalled
): Promise<AppEventView[]> {
    const views = await Promise.all(
        core.registeredAppEvents().map(async (event): Promise<AppEventView | null> => {
            if (!event.permission) return null;
            if (!(await installed(event.app).catch(() => false))) return null;
            if (!(await sessionCan(user, event.permission as core.Permission).catch(() => false))) return null;
            return { name: event.name, app: event.app, appName: event.appName, label: event.label, fields: event.fields };
        })
    );
    return views.filter((view): view is AppEventView => view !== null);
}

/** What an app's own bundle says when it emits one of its declared events. */
export interface OwnAppEvent {
    /** The app's id: the event must be one its manifest declared under it. */
    readonly app: string;
    /** `<app id>.<event>`, as the manifest's `events` list names it. */
    readonly name: string;
    readonly payload: Record<string, unknown>;
    /** Once-only key, as for `emitAppEvent`. */
    readonly key: string;
    /** What an automation's runner needs to receive it: one of the app's own permissions. */
    readonly permission: string;
}

/**
 * Send an event an installed app declared in its manifest (`registerAppEvents`)
 * from the app's own code. Refused - logged, never thrown - when the event is
 * not the app's, the payload does not match what the manifest declared, or the
 * permission is not one under the app's id. An automation receives it only
 * while the app is installed and its runner holds `permission`, the same rule
 * the app's own screens apply.
 */
export async function emitOwnAppEvent(event: OwnAppEvent): Promise<boolean> {
    const { app, name, permission } = event;
    if (core.appEventOwner(name) !== app || !name.startsWith(`${app}.`) || Object.hasOwn(core.APP_EVENTS, name)) {
        console.error(`polaris: ${app} emitted ${name}, which is not one of its declared events`);
        return false;
    }
    if (!permission.startsWith(`${app}.`)) {
        console.error(`polaris: ${app} emitted ${name} behind ${permission}, which is not its own permission`);
        return false;
    }
    if (!(await isAppInstalled(app).catch(() => false))) return false;
    return emitAppEvent(name as core.AppEventName, event.payload as core.AppEventPayload<core.AppEventName>, {
        key: event.key,
        mayReceive: async (runner) => {
            const user: SessionUser = { ...runner, email: "", name: "", sessionId: "" };
            return sessionCan(user, permission as core.Permission);
        }
    });
}
