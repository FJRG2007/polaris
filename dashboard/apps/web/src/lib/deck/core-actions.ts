/**
 * The actions core offers a deck: chat, your own status, Deploy and its
 * alarms, notifications, and opening a Polaris page.
 *
 * Each one either calls the tool an assistant would (`callTool`), or the same
 * service the screen does, as the person the key belongs to. Places and the
 * other apps contribute theirs through the extension registry.
 *
 * Server-only.
 */

import { z } from "zod";
import { prisma } from "@polaris/db";
import { callTool } from "./tool-call";
import { callDeckActions } from "./call-actions";
import { unreadTotal } from "@/lib/chat/chat-service";
import { translatorFor } from "@/lib/i18n/translate";
import { PRESENCE_CHOICES, type Locale, type Permission } from "@polaris/core";
import { presenceChoiceOf, setPresenceChoice } from "@/lib/presence-service";
import type {
    DeckActionKind,
    DeckArea,
    DeckCaller,
    DeckOptionsSchema,
    DeckRunResult,
    DeckState
} from "./types";

/** The choices a person may set from a key: every one but automatic, which is
 *  what pressing the key again goes back to. */
const PRESSED_CHOICES = PRESENCE_CHOICES.filter((choice) => choice !== "auto");

export interface CoreDeckField {
    readonly name: string;
    readonly type: "text" | "number" | "choice";
    readonly required: boolean;
    readonly min?: number;
    readonly max?: number;
    /** Fixed choices: the values, named from the `api` catalog's `deck.choice.*`. */
    readonly fixed?: readonly string[];
    /** Choices read for this person. */
    readonly read?: (caller: DeckCaller) => Promise<{ value: string; label: string }[]>;
}

export interface CoreDeckAction {
    readonly id: string;
    readonly kind: DeckActionKind;
    readonly area: DeckArea;
    readonly icon: string;
    /** The permission the key must carry; null for something only about the
     *  key's own account, like its status. */
    readonly scope: Permission | null;
    readonly options: DeckOptionsSchema;
    readonly fields: readonly CoreDeckField[];
    readonly path?: string;
    readonly run?: (options: Record<string, unknown>, caller: DeckCaller) => Promise<DeckRunResult>;
    readonly read?: (options: Record<string, unknown>, caller: DeckCaller) => Promise<DeckState>;
    /** What wakes its state: the chat bus, a call's controls moving, or the
     *  stream's own clock. */
    readonly wakes?: "chat" | "call" | "clock";
}

/** A tool's outcome as a run's; `refused` stands in for a refusal the tool did
 *  not word. */
async function viaTool(
    caller: DeckCaller,
    tool: string,
    input: unknown,
    refused: string
): Promise<DeckRunResult> {
    const outcome = await callTool(caller, tool, input);
    return outcome.ok ? { ok: true } : { ok: false, message: outcome.message ?? refused };
}

/** A count as a key draws it: nothing waiting is the quiet tone. */
export function countState(count: number, tone: "warn" | "bad" = "warn"): DeckState {
    return { tone: count > 0 ? tone : "idle", value: count > 99 ? "99+" : String(count) };
}

function presenceState(held: string, wanted: string): DeckState {
    const on = held === wanted;
    return { tone: on ? "warn" : "idle", on };
}

/**
 * A presence key with what pressing it does: it sets its choice, or goes back
 * to automatic when that choice holds - and a key set to another choice that
 * held goes off with it, at once.
 */
export function presenceKey(held: string, wanted: string): DeckState {
    const next = held === wanted ? "auto" : wanted;
    const also = PRESSED_CHOICES.filter(
        (choice) => choice !== wanted && (held === choice) !== (next === choice)
    ).map((choice) => ({
        action: "status.presence",
        options: { choice },
        face: presenceState(next, choice)
    }));
    return {
        ...presenceState(held, wanted),
        press: {
            face: presenceState(next, wanted),
            ...(also.length > 0 ? { also } : {})
        }
    };
}

const conversationList = z.object({
    conversations: z.array(z.object({ id: z.string(), name: z.string().nullish() }).passthrough())
});

/** The conversations a person reaches, for the "send a message" picker. */
async function conversations(caller: DeckCaller) {
    const outcome = await callTool(caller, "chat_conversations", {});
    if (!outcome.ok) return [];
    const parsed = conversationList.safeParse(outcome.structured);
    if (!parsed.success) return [];
    return parsed.data.conversations.map((row) => ({ value: row.id, label: row.name || row.id }));
}

const alarmList = z.object({
    alarms: z.array(z.object({ state: z.string(), enabled: z.boolean() }).passthrough())
});

const deploymentList = z.object({
    deployments: z.array(z.object({ status: z.string() }).passthrough())
});

/** The statuses a deployment row takes that a key names. */
const NAMED_STATUSES = [
    "queued",
    "building",
    "deploying",
    "running",
    "success",
    "failed",
    "cancelled",
    "rolled_back",
    "stopped",
    "removed"
] as const;

function isNamedStatus(status: string): status is (typeof NAMED_STATUSES)[number] {
    return (NAMED_STATUSES as readonly string[]).includes(status);
}

/** A deployment's status as a key draws it: the status in its reader's
 *  language, under a colour for how it went. One nobody here names shows the
 *  colour alone. */
export function deploymentState(status: string, locale: Locale): DeckState {
    const tone =
        status === "running"
            ? "ok"
            : status === "failed"
              ? "bad"
              : status === "queued" || status === "building" || status === "deploying"
                ? "warn"
                : "idle";
    if (!isNamedStatus(status)) return { tone };
    return { tone, detail: translatorFor(locale, "api")(`deck.status.${status}`) };
}

/** A service as Deploy's tools take it: an id, project/service or
 *  project/environment/service. The tool's own schema decides the rest. */
const serviceRef = z.string().trim().min(1).max(200);

/** Core's actions. `refused` is the sentence a refusal falls back to. */
export function coreDeckActions(refused: string): readonly CoreDeckAction[] {
    return [
        {
            id: "chat.send",
            kind: "run",
            area: "chat",
            icon: "send",
            scope: "chat.use",
            options: z.object({
                conversationId: z.string().uuid(),
                body: z.string().trim().min(1).max(2000)
            }),
            fields: [
                { name: "conversationId", type: "choice", required: true, read: conversations },
                { name: "body", type: "text", required: true }
            ],
            run: (options, caller) =>
                viaTool(
                    caller,
                    "chat_send",
                    { conversationId: options.conversationId, body: options.body },
                    refused
                )
        },
        {
            id: "chat.unread",
            kind: "state",
            area: "chat",
            icon: "message-circle",
            scope: "chat.use",
            options: z.object({}),
            fields: [],
            read: async (_options, caller) =>
                countState((await unreadTotal({ id: caller.userId })).messages),
            wakes: "chat"
        },
        {
            id: "chat.open",
            kind: "open",
            area: "chat",
            icon: "message-circle",
            scope: "chat.use",
            options: z.object({}),
            fields: [],
            path: "/chat"
        },
        {
            id: "status.presence",
            kind: "toggle",
            area: "status",
            icon: "moon",
            scope: null,
            options: z.object({ choice: z.enum(["busy", "away", "invisible"]).default("busy") }),
            fields: [{ name: "choice", type: "choice", required: true, fixed: PRESSED_CHOICES }],
            // The preferences screen's own write. Pressed while it holds, it goes
            // back to automatic, which is what a toggle is for.
            run: async (options, caller) => {
                const wanted = String(options.choice);
                const held = await presenceChoiceOf(caller.userId);
                await setPresenceChoice(
                    caller.userId,
                    held.choice === wanted ? "auto" : (wanted as "busy" | "away" | "invisible")
                );
                const now = await presenceChoiceOf(caller.userId);
                return { ok: true, state: presenceKey(now.choice, wanted) };
            },
            read: async (options, caller) =>
                presenceKey((await presenceChoiceOf(caller.userId)).choice, String(options.choice)),
            wakes: "clock"
        },
        {
            id: "watch.alarms",
            kind: "state",
            area: "watch",
            icon: "bell-ring",
            scope: "deploy.read",
            options: z.object({}),
            fields: [],
            read: async (_options, caller) => {
                const outcome = await callTool(caller, "watch_alarms", {});
                if (!outcome.ok) return { tone: "idle" };
                const parsed = alarmList.safeParse(outcome.structured);
                if (!parsed.success) return { tone: "idle" };
                const firing = parsed.data.alarms.filter(
                    (alarm) => alarm.enabled && alarm.state === "firing"
                ).length;
                return firing > 0 ? countState(firing, "bad") : { tone: "ok", value: "0" };
            },
            wakes: "clock"
        },
        {
            id: "deploy.redeploy",
            kind: "run",
            area: "deploy",
            icon: "rocket",
            scope: "deploy.manage",
            options: z.object({ service: serviceRef }),
            fields: [{ name: "service", type: "text", required: true }],
            run: (options, caller) =>
                viaTool(caller, "deploy_start", { service: options.service }, refused)
        },
        {
            id: "deploy.status",
            kind: "state",
            area: "deploy",
            icon: "rocket",
            scope: "deploy.read",
            options: z.object({ service: serviceRef }),
            fields: [{ name: "service", type: "text", required: true }],
            read: async (options, caller) => {
                const outcome = await callTool(caller, "deploy_deployments", {
                    service: options.service
                });
                if (!outcome.ok) return { tone: "idle" };
                const parsed = deploymentList.safeParse(outcome.structured);
                const newest = parsed.success ? parsed.data.deployments[0] : undefined;
                return newest ? deploymentState(newest.status, caller.locale) : { tone: "idle" };
            },
            wakes: "clock"
        },
        {
            id: "deploy.restart",
            kind: "run",
            area: "deploy",
            icon: "rotate-cw",
            scope: "deploy.manage",
            options: z.object({ service: serviceRef }),
            fields: [{ name: "service", type: "text", required: true }],
            run: (options, caller) =>
                viaTool(caller, "deploy_restart", { service: options.service }, refused)
        },
        {
            id: "polaris.notifications",
            kind: "state",
            area: "polaris",
            icon: "bell",
            scope: null,
            options: z.object({}),
            fields: [],
            read: async (_options, caller) =>
                countState(
                    await prisma.notification.count({
                        where: { userId: caller.userId, readAt: null }
                    })
                ),
            wakes: "clock"
        },
        {
            id: "polaris.open",
            kind: "open",
            area: "polaris",
            icon: "external-link",
            scope: null,
            // A path on this Polaris and nothing else: the plugin joins it to
            // the address it is connected to, so a key never opens another site.
            options: z.object({
                path: z
                    .string()
                    .trim()
                    .max(200)
                    .regex(/^\/(?!\/)[^\s\\]*$/)
                    .default("/home")
            }),
            fields: [{ name: "path", type: "text", required: true }],
            path: "/home"
        },
        ...callDeckActions()
    ];
}
