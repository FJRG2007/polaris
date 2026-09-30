/**
 * The automation engine, wired to this Polaris: the database, the devices, the
 * owner's rights and the bell.
 *
 * One engine per process, made on first use. Three ways in:
 *
 * - `observeDevices`, from `devices.ts`, after every sync and every press - the
 *   one place a device's state is learned, so the one place a change can fire
 *   anything;
 * - `tickAutomations`, from the scheduler once a minute: ask the devices when an
 *   automation needs to know, fire what the clock says is due, and work through
 *   every run that is waiting;
 * - `automationEngine()` itself, for Run now.
 *
 * Server-only.
 */

import { placesTFor } from "./i18n";
import { prisma } from "@polaris/db";
import { homeInstall } from "./access";
import { host } from "@polaris/app-host";
import { HomeError } from "./home-error";
import { readsDevices } from "./automation-kinds";
import { prismaAutomationStore } from "./automation-store";
import {
    createEngine,
    StepRefusal,
    type AutomationEngine,
    type DeviceReadout
} from "./automation-engine";

const { notify } = host.notificationsDispatch;
const { sessionCan } = host.session;
const { recordAudit } = host.auditService;

/** Where an automation's own screen is, for the bell to point at. */
export function automationHref(id: string): string {
    return `/places/devices/automations/${id}`;
}

/** A device row, in whichever of the shapes `devices.ts` reads it. */
export interface ObservedRow {
    readonly id: string;
    readonly kind: string;
    readonly name: string;
    readonly state: string;
    readonly doorState: string;
    readonly value: string | null;
    readonly online: boolean;
}

function readout(row: ObservedRow): DeviceReadout {
    return {
        id: row.id,
        kind: row.kind,
        name: row.name,
        state: row.state,
        door: row.doorState,
        reading: row.value ?? "",
        online: row.online
    };
}

let engine: AutomationEngine | null = null;

export function automationEngine(): AutomationEngine {
    engine ??= createEngine({
        now: () => new Date(),
        store: prismaAutomationStore,
        devices: {
            async read(installedAppId, deviceId) {
                const row = await prisma.placeDevice.findFirst({
                    where: { id: deviceId, installedAppId },
                    select: {
                        id: true,
                        kind: true,
                        name: true,
                        state: true,
                        doorState: true,
                        value: true,
                        online: true
                    }
                });
                return row ? readout(row) : null;
            },
            async act(installedAppId, deviceId, action, by) {
                // The same service as the button on the screen: the same four
                // refusals, the same history entry, the same state afterwards.
                const devices = await import("./devices");
                try {
                    const device = await devices.actOnDevice(
                        installedAppId,
                        deviceId,
                        action,
                        by.automationName
                    );
                    await recordAudit({
                        actorId: by.ownerId,
                        action: `places.device.${action}`,
                        targetType: "placeDevice",
                        targetId: deviceId,
                        metadata: { name: device.name, automationId: by.automationId }
                    });
                } catch (error) {
                    await recordAudit({
                        actorId: by.ownerId,
                        action: `places.device.${action}.refused`,
                        targetType: "placeDevice",
                        targetId: deviceId,
                        metadata: { automationId: by.automationId }
                    }).catch(() => undefined);
                    if (error instanceof HomeError) throw new StepRefusal(error.message);
                    throw error;
                }
            }
        },
        mayOperate,
        async notify(automation, message, runId) {
            const t = await placesTFor(automation.ownerId);
            await notify({
                userId: automation.ownerId,
                event: "places.automation",
                title: t("automations.notice.title", { name: automation.name }),
                body: message,
                href: automationHref(automation.id),
                metadata: { automationId: automation.id, runId }
            });
        },
        wake(ms) {
            const timer = setTimeout(() => {
                void automationEngine()
                    .drain()
                    .catch((error) => console.error("places: automations could not run:", error));
            }, ms);
            timer.unref?.();
        }
    });
    return engine;
}

/**
 * Whether the owner still holds what a run needs: the right to keep automations
 * here at all (`home.manage`, which writing one took), and for a step that
 * operates a device, the right to operate them (`home.control`).
 *
 * Asked with no request around it, so the owner is read from their row rather
 * than from a session. An account that is banned, switched off or on its way
 * out operates nothing, whatever its roles still say.
 */
async function mayOperate(ownerId: string, right: "run" | "control"): Promise<boolean> {
    const user = await prisma.user.findUnique({
        where: { id: ownerId },
        select: {
            id: true,
            email: true,
            name: true,
            isAdmin: true,
            bannedAt: true,
            disabledAt: true,
            deletionRequestedAt: true
        }
    });
    if (!user || user.bannedAt || user.disabledAt || user.deletionRequestedAt) return false;
    return sessionCan(
        {
            id: user.id,
            email: user.email,
            name: user.name ?? "",
            isAdmin: user.isAdmin,
            sessionId: ""
        },
        right === "control" ? "home.control" : "home.manage"
    );
}

/** What devices were just read as. Never a reason for a sync or a press to fail:
 *  the door moved whether or not an automation hears about it. */
export async function observeDevices(
    installedAppId: string,
    rows: readonly ObservedRow[]
): Promise<void> {
    const running = automationEngine();
    for (const row of rows) {
        try {
            await running.observe(installedAppId, readout(row));
        } catch (error) {
            console.error("places: an automation could not read a device change:", error);
        }
    }
}

/**
 * The minute tick.
 *
 * Asks the devices only when something is listening - an automation that reads
 * a device, or a run waiting on one - since every ask is a call to somebody's
 * account. It is a plain read: nothing is woken, no battery is spent.
 */
export async function tickAutomations(): Promise<void> {
    const install = await homeInstall();
    if (!install) return;
    const running = automationEngine();
    const automations = await prismaAutomationStore.enabledAutomations(install.id);
    const pending = await prisma.placeAutomationRun.count({
        where: { status: { in: ["queued", "waiting", "running"] } }
    });
    if (automations.length === 0 && pending === 0) return;
    if (automations.some((automation) => readsDevices(automation.definition)) || pending > 0) {
        const devices = await import("./devices");
        await devices.syncDevices(install.id).catch((error) => {
            console.error("places: automations could not read the devices:", error);
        });
    }
    await running.evaluateSchedules(install.id);
    await running.drain();
}
