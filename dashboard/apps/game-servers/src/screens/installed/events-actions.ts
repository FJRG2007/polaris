"use server";

/**
 * A Minecraft server's events: reading them, setting them up, starting one now
 * and calling one off.
 *
 * All of it is the console's grant: an event talks to everybody on the server
 * and hands out items, which is exactly what somebody with the console can do by
 * typing - and nothing somebody without it should be able to do by pressing Run.
 */

import { z } from "zod";
import { host } from "@polaris/app-host";
import * as events from "../../lib/minecraft/events/events-service";

const { recordAudit } = host.auditService;
const { requireGameServer } = host.appsInstallAccess;

const serverId = z.string().uuid();

type Answer = { view?: events.EventsView; error?: string };

const failure = (caught: unknown, fallback: string): string =>
    caught instanceof Error ? caught.message : fallback;

export async function readEventsAction(installedAppId: string): Promise<Answer> {
    const parsed = serverId.safeParse(installedAppId);
    if (!parsed.success) return { error: "That server is not here" };
    try {
        await requireGameServer("games.console", parsed.data);
        return { view: await events.eventsView(parsed.data) };
    } catch (caught) {
        return { error: failure(caught, "The events could not be read") };
    }
}

const saveSchema = z.object({ installedAppId: serverId, config: z.unknown() });

export async function saveEventsAction(input: z.input<typeof saveSchema>): Promise<Answer> {
    const parsed = saveSchema.safeParse(input);
    if (!parsed.success) return { error: "That server is not here" };
    try {
        const { user } = await requireGameServer("games.console", parsed.data.installedAppId);
        await events.saveEventsConfig(parsed.data.installedAppId, parsed.data.config);
        await recordAudit({
            actorId: user.id,
            action: "games.events.settings",
            targetType: "installedApp",
            targetId: parsed.data.installedAppId
        });
        return { view: await events.eventsView(parsed.data.installedAppId) };
    } catch (caught) {
        return { error: failure(caught, "The events could not be saved") };
    }
}

const startSchema = z.object({ installedAppId: serverId, presetId: z.string().min(1).max(64) });

export async function startEventAction(input: z.input<typeof startSchema>): Promise<Answer> {
    const parsed = startSchema.safeParse(input);
    if (!parsed.success) return { error: "That event is not here" };
    try {
        const { user, access } = await requireGameServer(
            "games.console",
            parsed.data.installedAppId
        );
        const run = await events.startEvent({
            ownerId: access.ownerId,
            installedAppId: parsed.data.installedAppId,
            presetId: parsed.data.presetId,
            trigger: "manual",
            startedBy: user.id
        });
        await recordAudit({
            actorId: user.id,
            action: "games.events.start",
            targetType: "installedApp",
            targetId: parsed.data.installedAppId,
            metadata: { event: run.preset.name, kind: run.preset.kind }
        });
        return { view: await events.eventsView(parsed.data.installedAppId) };
    } catch (caught) {
        return { error: failure(caught, "The event could not start") };
    }
}

export async function cancelEventAction(installedAppId: string): Promise<Answer> {
    const parsed = serverId.safeParse(installedAppId);
    if (!parsed.success) return { error: "That server is not here" };
    try {
        const { user, access } = await requireGameServer("games.console", parsed.data);
        await events.cancelEvent(access.ownerId, parsed.data);
        await recordAudit({
            actorId: user.id,
            action: "games.events.cancel",
            targetType: "installedApp",
            targetId: parsed.data
        });
        return { view: await events.eventsView(parsed.data) };
    } catch (caught) {
        return { error: failure(caught, "The event could not be called off") };
    }
}

export async function startNowAction(installedAppId: string): Promise<Answer> {
    const parsed = serverId.safeParse(installedAppId);
    if (!parsed.success) return { error: "That server is not here" };
    try {
        const { user, access } = await requireGameServer("games.console", parsed.data);
        await events.startNow(access.ownerId, parsed.data);
        await recordAudit({
            actorId: user.id,
            action: "games.events.start-now",
            targetType: "installedApp",
            targetId: parsed.data
        });
        return { view: await events.eventsView(parsed.data) };
    } catch (caught) {
        return { error: failure(caught, "The event could not start now") };
    }
}

const forgetSchema = z.object({ installedAppId: serverId, pendingId: z.string().min(1).max(128) });

export async function forgetPrizeAction(input: z.input<typeof forgetSchema>): Promise<Answer> {
    const parsed = forgetSchema.safeParse(input);
    if (!parsed.success) return { error: "That prize is not here" };
    try {
        const { user } = await requireGameServer("games.console", parsed.data.installedAppId);
        await events.forgetPending(parsed.data.installedAppId, parsed.data.pendingId);
        await recordAudit({
            actorId: user.id,
            action: "games.events.forget-prize",
            targetType: "installedApp",
            targetId: parsed.data.installedAppId
        });
        return { view: await events.eventsView(parsed.data.installedAppId) };
    } catch (caught) {
        return { error: failure(caught, "That prize could not be forgotten") };
    }
}
