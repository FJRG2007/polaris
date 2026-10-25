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
    calendar: "calendar.use"
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
