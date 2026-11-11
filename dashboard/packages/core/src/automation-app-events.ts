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
export const APP_EVENT_APPS = [
    "game-servers",
    "deploy",
    "chat",
    "tasks",
    "mail",
    "drive",
    "calendar",
    "code"
] as const;
export type AppEventApp = (typeof APP_EVENT_APPS)[number];

const gameServer = z.object({ installId: id, name: label, game: z.string().max(64) }).strict();
const gameServerCrashed = gameServer
    .extend({ restarts: z.number().int().min(0), cause: z.string().max(300).nullable() })
    .strict();
const playerJoined = gameServer.extend({ player: z.string().min(1).max(64) }).strict();
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

const mailReceived = z
    .object({
        messageId: id,
        accountId: id,
        mailbox: z.string().max(320),
        from: z.string().max(320),
        fromName: label,
        subject: z.string().max(500),
        snippet: z.string().max(500)
    })
    .strict();
const driveUpload = z
    .object({
        connectionId: id,
        path: z.string().min(1).max(1024),
        name: z.string().min(1).max(255),
        size: z.number().int().min(0),
        uploaderId: id
    })
    .strict();
const calendarEvent = z
    .object({
        eventId: id,
        calendarId: id,
        calendar: label,
        title: z.string().max(500),
        startsAt: z.string().datetime(),
        allDay: z.boolean()
    })
    .strict();

/** Something on a connected GitHub repository: a pull request, an issue, a
 *  mention of the app, a failed check. `body` is what somebody wrote there -
 *  untrusted text, for a step to quote, never to obey. */
const repoEvent = z
    .object({
        repoId: id,
        repo: z.string().min(3).max(200),
        number: z.number().int().positive().nullable(),
        pullRequest: z.boolean(),
        title: z.string().max(500),
        actor: z.string().max(100),
        labels: z.array(z.string().max(100)).max(50),
        branch: z.string().max(255).nullable(),
        body: z.string().max(4000)
    })
    .strict();

export const APP_EVENTS = {
    "game-server.started": { app: "game-servers", payload: gameServer },
    "game-server.stopped": { app: "game-servers", payload: gameServer },
    "game-server.crashed": { app: "game-servers", payload: gameServerCrashed },
    "game-server.player-joined": { app: "game-servers", payload: playerJoined },
    "deploy.succeeded": { app: "deploy", payload: deploy },
    "deploy.failed": { app: "deploy", payload: deploy },
    "task.created": { app: "tasks", payload: task },
    "task.completed": { app: "tasks", payload: task },
    "chat.message": { app: "chat", payload: chatMessage },
    "mail.received": { app: "mail", payload: mailReceived },
    "drive.file-uploaded": { app: "drive", payload: driveUpload },
    "calendar.event-starting": { app: "calendar", payload: calendarEvent },
    "code.mentioned": { app: "code", payload: repoEvent },
    "code.issue-opened": { app: "code", payload: repoEvent },
    "code.issue-labeled": { app: "code", payload: repoEvent },
    "code.pull-request-opened": { app: "code", payload: repoEvent },
    "code.pull-request-updated": { app: "code", payload: repoEvent },
    "code.pull-request-merged": { app: "code", payload: repoEvent },
    "code.review-requested": { app: "code", payload: repoEvent },
    "code.review-submitted": { app: "code", payload: repoEvent },
    "code.checks-failed": { app: "code", payload: repoEvent }
} as const satisfies Record<string, { app: AppEventApp; payload: z.ZodTypeAny }>;

export type AppEventName = keyof typeof APP_EVENTS;

/** The repository trigger each `code.*` event is (AGENT_TRIGGERS), both ways. */
export const CODE_EVENT_TRIGGERS = {
    "code.mentioned": "mention",
    "code.issue-opened": "issue.opened",
    "code.issue-labeled": "issue.labeled",
    "code.pull-request-opened": "pr.opened",
    "code.pull-request-updated": "pr.updated",
    "code.pull-request-merged": "pr.merged",
    "code.review-requested": "pr.review_requested",
    "code.review-submitted": "pr.review_submitted",
    "code.checks-failed": "ci.failed"
} as const satisfies Partial<Record<AppEventName, string>>;
export type CodeEventName = keyof typeof CODE_EVENT_TRIGGERS;

export function isCodeEventName(name: string): name is CodeEventName {
    return Object.hasOwn(CODE_EVENT_TRIGGERS, name);
}
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
