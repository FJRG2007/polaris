/**
 * The events Polaris's own apps send to automations, by name: which app sends
 * each one and the exact shape of what it carries.
 *
 * An "On event" trigger listening to one of these names is fed by the app's
 * service code at the moment the thing happens (lib/automations/app-events.ts
 * in the web app). The schema is the contract both ends hold: the emitter parses
 * its payload with it before sending, and the editor offers its fields as
 * `{{trigger.payload.<field>}}` before any sample exists.
 */

import { z } from "zod";

const id = z.string().min(1).max(64);
const label = z.string().max(200);

/** The apps that send events, by the id their install (or built-in entry) has. */
export const APP_EVENT_APPS = ["game-servers", "deploy", "chat", "tasks"] as const;
export type AppEventApp = (typeof APP_EVENT_APPS)[number];

const gameServer = z.object({ installId: id, name: label, game: z.string().max(64) }).strict();
const deploy = z
    .object({
        deploymentId: id,
        deployableType: z.string().max(32),
        deployableId: id,
        name: label,
        commitSha: z.string().max(64).nullable(),
        trigger: z.string().max(32).nullable(),
        error: z.string().max(300).nullable()
    })
    .strict();
const task = z
    .object({
        taskId: id,
        name: label,
        spaceId: id,
        listId: id,
        actorId: id.nullable()
    })
    .strict();
const chatMessage = z
    .object({
        messageId: id,
        channelId: id,
        authorId: id,
        body: z.string().max(4000),
        threadId: id.nullable()
    })
    .strict();

export const APP_EVENTS = {
    "game-server.started": { app: "game-servers", payload: gameServer },
    "game-server.stopped": { app: "game-servers", payload: gameServer },
    "deploy.succeeded": { app: "deploy", payload: deploy },
    "deploy.failed": { app: "deploy", payload: deploy },
    "task.created": { app: "tasks", payload: task },
    "task.completed": { app: "tasks", payload: task },
    "chat.message": { app: "chat", payload: chatMessage }
} as const satisfies Record<string, { app: AppEventApp; payload: z.ZodTypeAny }>;

export type AppEventName = keyof typeof APP_EVENTS;
export type AppEventPayload<Name extends AppEventName> = z.infer<
    (typeof APP_EVENTS)[Name]["payload"]
>;

export const APP_EVENT_NAMES = Object.keys(APP_EVENTS) as AppEventName[];

export function isAppEventName(name: string): name is AppEventName {
    return Object.hasOwn(APP_EVENTS, name);
}

/** The payload fields an app event carries, for the reference menu; empty for any other name. */
export function appEventFields(name: string): string[] {
    return isAppEventName(name) ? Object.keys(APP_EVENTS[name].payload.shape) : [];
}

/** An app event's payload checked against its shape: the data, or null when it does not match. */
export function parseAppEventPayload(
    name: AppEventName,
    payload: unknown
): Record<string, unknown> | null {
    const parsed = APP_EVENTS[name].payload.safeParse(payload);
    return parsed.success ? (parsed.data as Record<string, unknown>) : null;
}
