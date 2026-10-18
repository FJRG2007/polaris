/**
 * Places' cards for the Overview: the devices somebody picks, at a glance, and
 * the switches and temperatures they use most.
 *
 * Two kinds. "Devices at a glance" reads - an air conditioner's room and target
 * temperature and mode, a purifier's air quality, a sensor's reading, a
 * battery that is running down. "Quick controls" adds what can be changed from
 * there: power for anything with an on and an off, and the temperature an air
 * conditioner is set to.
 *
 * Nothing here decides access on its own. What is listed and read is what the
 * reader reaches - the house, for somebody who lives there, and only the devices
 * lent to them for anybody else - and every press goes through
 * `operateDeviceAction`, the same action the devices screen uses, with its
 * permission checks, its lent-device counting and its audit record. A device the
 * reader stops reaching drops off their card rather than being reported.
 *
 * Server-only.
 */

import { placesT } from "./i18n";
import { homeInstall } from "./access";
import * as kinds from "./device-kinds";
import { listDevices } from "./devices";
import { host } from "@polaris/app-host";
import type { AppHostTypes } from "@polaris/app-host";
import { airQuality, airQualityText } from "./air-kinds";
import { placesReach, reachesDevice, type PlacesReach } from "./sharing";

type AppWidgetView = AppHostTypes["AppWidgetView"];
type Item = AppWidgetView["items"][number];
type Control = Item["controls"][number];
type Reading = Item["readings"][number];

export type DeviceCardMode = "status" | "controls";

/** Where a device's own screen is. */
const DEVICES_PATH = "/places/devices";

/** The control that turns a device on and off, and the one that sets a
 *  temperature. Their ids are what a press names. */
export const POWER = "power";
export const TARGET = "target";
/** An air conditioner's or purifier's mode, and the one-press actions a lock,
 *  an opener and an appliance have. */
export const MODE = "mode";
export const LOCK = "lock";
export const UNLOCK = "unlock";
export const UNLATCH = "unlatch";
export const STOP = "stop";
/** What a glance card draws, and so all it may be pressed for. */
const GLANCE_CONTROLS: readonly string[] = [POWER, LOCK, UNLOCK, STOP];

/** The two kinds' names, in the reader's language. */
export async function describeCard(mode: DeviceCardMode): Promise<{ label: string; hint: string }> {
    const t = await placesT();
    return mode === "status"
        ? { label: t("overview.statusLabel"), hint: t("overview.statusHint") }
        : { label: t("overview.controlsLabel"), hint: t("overview.controlsHint") };
}

/** Whether a device has something a quick-controls card can change. */
export function hasQuickControl(device: kinds.DeviceView): boolean {
    const actions = kinds.actionsFor(device.kind);
    return (
        (actions.includes("turn-on") && actions.includes("turn-off")) ||
        (actions.includes("set-temperature") && Boolean(device.climate)) ||
        actions.includes("lock") ||
        actions.includes("unlatch") ||
        (actions.includes("stop") && Boolean(device.appliance?.stoppable))
    );
}

/** The devices this reader reaches, or none when there is no house. */
async function reachable(): Promise<{ devices: kinds.DeviceView[]; reach: PlacesReach } | null> {
    const install = await homeInstall();
    if (!install) return null;
    const user = await host.session.requireUser();
    const reach = await placesReach(user);
    const devices = (await listDevices(install.id)).filter((device) =>
        reachesDevice(reach, device.id)
    );
    return { devices, reach };
}

/** What the picker lists. For quick controls, only what has something to
 *  change. */
export async function deviceTargets(mode: DeviceCardMode) {
    const found = await reachable();
    if (!found) return [];
    const t = await placesT();
    return found.devices
        .filter((device) => mode === "status" || hasQuickControl(device))
        .map((device) => ({
            id: device.id,
            label: device.name,
            detail: [device.zone, t(`devices.kinds.${kinds.deviceKind(device.kind)}`)]
                .filter(Boolean)
                .join(" - ")
        }));
}

/** One temperature, as the unit reads it. */
function degrees(value: number | null | undefined, unit: string): string | null {
    return value === null || value === undefined ? null : `${value}°${unit}`;
}

/** What one device reads as. Pure, so it can be tested without a house. */
export function deviceItem(
    device: kinds.DeviceView,
    mode: DeviceCardMode,
    words: {
        readonly t: Awaited<ReturnType<typeof placesT>>;
        /** Whether this reader may operate it at all. */
        readonly mayOperate: boolean;
    }
): Item {
    const { t } = words;
    const readings: Reading[] = [];
    const climate = device.climate ?? null;
    if (climate) {
        const room = degrees(climate.current, climate.unit);
        if (room) readings.push({ label: t("overview.room"), value: room });
        const target = degrees(climate.target, climate.unit);
        if (target) readings.push({ label: t("overview.target"), value: target });
        if (climate.mode) {
            readings.push({
                label: t("overview.mode"),
                value: t(`devices.climate.modes.${climate.mode}`)
            });
        }
    }
    const air = device.air ?? null;
    if (air) {
        const quality = airQuality(air);
        if (quality) {
            readings.push({
                label: t("overview.air"),
                value: airQualityText(quality.level, t),
                tone:
                    quality.level === "good" || quality.level === "fair"
                        ? "ok"
                        : quality.level === "moderate"
                          ? "warn"
                          : "bad"
            });
        }
        if (air.readings.pm25 !== undefined) {
            readings.push({ label: t("overview.pm25"), value: `${air.readings.pm25} µg/m³` });
        }
        if (air.readings.humidity !== undefined) {
            readings.push({ label: t("overview.humidity"), value: `${air.readings.humidity}%` });
        }
    }
    if (!climate && !air && device.reading) {
        readings.push({
            label: t("overview.reading"),
            value: `${device.reading.value}${device.reading.unit ? ` ${device.reading.unit}` : ""}`
        });
    }
    if (device.batteryPercent !== null) {
        readings.push({
            label: t("overview.battery"),
            value: `${device.batteryPercent}%`,
            tone: device.batteryCritical ? "bad" : device.batteryPercent <= 20 ? "warn" : undefined
        });
    }

    const actions = kinds.actionsFor(device.kind);
    // Why nothing on it can be pressed, said where the controls are.
    const blocked = !device.online
        ? t("overview.offline")
        : !device.controllable
          ? t("overview.watchOnly")
          : !words.mayOperate
            ? t("overview.noControl")
            : null;
    // The device's own main control is on both kinds of card, the way a tile
    // on a home dashboard switches what it shows: power for anything with an on
    // and an off, the bolt for a lock, stopping for an appliance that can be.
    // The settings behind it - temperature, mode, opening the door - are the
    // quick-controls card's.
    const controls: Control[] = [];
    if (actions.includes("turn-on") && actions.includes("turn-off")) {
        controls.push({
            kind: "toggle",
            id: POWER,
            label: t("overview.power"),
            on: device.state === "on",
            disabled: blocked
        });
    }
    if (actions.includes("lock")) {
        const locked = device.state === "locked";
        controls.push({
            kind: "action",
            id: locked ? UNLOCK : LOCK,
            label: t(locked ? "devices.actions.unlock" : "devices.actions.lock"),
            disabled: blocked ?? (device.state === "moving" ? t("devices.states.moving") : null)
        });
    }
    if (actions.includes("stop") && device.appliance?.stoppable) {
        controls.push({
            kind: "action",
            id: STOP,
            label: t("devices.actions.stop"),
            disabled: blocked
        });
    }
    if (mode === "controls") {
        // Opening a door is never one brush of a finger away: it asks for a
        // second press on the same button.
        if (actions.includes("unlatch")) {
            controls.push({
                kind: "action",
                id: UNLATCH,
                label: t("overview.unlatch"),
                confirm: t("overview.unlatchConfirm"),
                disabled: blocked
            });
        }
        if (actions.includes("set-mode") && climate && climate.modes.length > 1) {
            controls.push({
                kind: "choice",
                id: MODE,
                label: t("overview.mode"),
                value: climate.mode,
                options: climate.modes.map((value) => ({
                    value,
                    label: t(`devices.climate.modes.${value}`)
                })),
                disabled: blocked
            });
        }
        if (actions.includes("set-mode") && air && air.modes.length > 1) {
            controls.push({
                kind: "choice",
                id: MODE,
                label: t("overview.mode"),
                value: air.mode,
                options: air.modes.map((value) => ({
                    value,
                    label: t(`devices.air.modes.${value}`)
                })),
                disabled: blocked
            });
        }
        if (actions.includes("set-temperature") && climate) {
            controls.push({
                kind: "number",
                id: TARGET,
                label: t("overview.setTo"),
                value: climate.target,
                min: climate.min,
                max: climate.max,
                step: climate.step,
                unit: `°${climate.unit}`,
                disabled: blocked
            });
        }
    }

    const state = !device.online
        ? { state: t("overview.offline"), tone: "bad" as const }
        : device.state === "on"
          ? { state: t("devices.states.on"), tone: "ok" as const }
          : device.state === "off"
            ? { state: t("devices.states.off"), tone: "off" as const }
            : device.state === "unknown"
              ? {}
              : { state: t(`devices.states.${device.state}`), tone: "warn" as const };

    return {
        id: device.id,
        title: device.name,
        ...(device.zone ? { subtitle: device.zone } : {}),
        ...state,
        readings,
        controls,
        href: DEVICES_PATH
    };
}

/** What a card shows for the devices picked, in the order they were picked.
 *  A device this reader no longer reaches - or that is gone - is left out. */
export async function readDevices(
    targets: readonly string[],
    mode: DeviceCardMode
): Promise<AppWidgetView> {
    const found = await reachable();
    if (!found) return { items: [] };
    const t = await placesT();
    const byId = new Map(found.devices.map((device) => [device.id, device]));
    // Whether the house's own people may operate things; a visitor's right is
    // per device, and is the lent grant's.
    const user = await host.session.requireUser();
    const resident =
        found.reach.everything && (await host.session.sessionCanAny(user, "home.control"));
    return {
        items: targets.flatMap((id) => {
            const device = byId.get(id);
            if (!device) return [];
            // Somebody who lives here operates with the house's own right; a visitor
            // only what was lent to them to operate, not only to look at.
            const mayOperate = found.reach.everything
                ? resident
                : reachesDevice(found.reach, id, "control");
            return [deviceItem(device, mode, { t, mayOperate })];
        })
    };
}

/** A press on a quick-controls card, as the device action it is. Null for a
 *  control this card does not draw. */
export function pressAsAction(
    control: string,
    value: boolean | number | string,
    kind = ""
): { action: kinds.DeviceAction; command?: kinds.DeviceCommand } | null {
    if (control === POWER && typeof value === "boolean") {
        return { action: value ? "turn-on" : "turn-off" };
    }
    if (control === TARGET && typeof value === "number" && Number.isFinite(value)) {
        return { action: "set-temperature", command: { action: "set-temperature", target: value } };
    }
    if (
        value === true &&
        (control === LOCK || control === UNLOCK || control === UNLATCH || control === STOP)
    ) {
        return { action: control };
    }
    if (control === MODE && typeof value === "string") {
        // Read as the device's own kind's mode; the service checks it against the
        // modes that unit has before anything is sent.
        const command = kinds.commandFor(kind, { action: "set-mode", mode: value });
        return command ? { action: "set-mode", command: command.command } : null;
    }
    return null;
}

/** Press it, through the devices screen's own action and every check it makes. */
export async function operate(
    targets: readonly string[],
    input: { item: string; control: string; value: boolean | number | string },
    mode: DeviceCardMode = "controls"
): Promise<{ error?: string }> {
    const t = await placesT();
    if (!targets.includes(input.item)) return { error: t("refusals.deviceCannot") };
    if (mode === "status" && !GLANCE_CONTROLS.includes(input.control))
        return { error: t("refusals.deviceCannot") };
    // The device's kind decides which presses it has at all - a lock's bolt on an
    // air conditioner is refused here, before the devices screen is asked - and
    // what a mode may be.
    const device = (await reachable())?.devices.find((one) => one.id === input.item);
    if (!device) return { error: t("refusals.deviceCannot") };
    const press = pressAsAction(input.control, input.value, device.kind);
    if (!press || !kinds.actionsFor(device.kind).includes(press.action))
        return { error: t("refusals.deviceCannot") };
    const { operateDeviceAction } = await import("../screens/actions");
    const answer = await operateDeviceAction(input.item, press.action, press.command);
    return answer.error ? { error: answer.error } : {};
}
