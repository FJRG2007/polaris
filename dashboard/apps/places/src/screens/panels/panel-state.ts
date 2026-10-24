/**
 * What a press does to the device a wall shows before anything answers, and
 * how it is put back when the answer is a refusal. The same rule the devices
 * screen follows (`use-device-act`), pure so the wall's link mode - which has
 * no server action to call - draws a press the same way and can be tested.
 */

import * as kinds from "../../lib/device-kinds";
import { applyDeviceChange, type DeviceChange } from "../../lib/device-diff";
import type { DeviceAction, DeviceCommand, DeviceView } from "../../lib/device-kinds";

/** The device as it reads the moment it is pressed, or null where the outcome
 *  is the vendor's to report (a lock turning). */
export function optimisticDevice(
    device: DeviceView,
    action: DeviceAction,
    command?: DeviceCommand
): DeviceView | null {
    if (command) {
        const applied = kinds.applyCommand(
            {
                kind: device.kind,
                climate: device.climate ?? null,
                air: device.air ?? null,
                light: device.light ?? null
            },
            command
        );
        if (applied && "climate" in applied && device.climate)
            return { ...device, climate: { ...device.climate, ...applied.climate } };
        if (applied && "air" in applied) return { ...device, air: applied.air };
        if (applied && "light" in applied) return { ...device, light: applied.light };
        return null;
    }
    const settled = kinds.settledState(action);
    return settled ? { ...device, state: settled } : null;
}

/**
 * The entry once a press was refused: what it was before the press, but only
 * while it is still what the press made it. A later press, or a live update,
 * has won since and is kept.
 */
export function rolledBack(entry: DeviceView, before: DeviceView, pressed: DeviceView): DeviceView {
    if (entry.id !== before.id || entry !== pressed) return entry;
    return before;
}

/** A live frame applied to the devices a panel shows. A device that is not on
 *  the panel is never added by a frame: the panel decides what it shows. */
export function applyPanelChange(
    current: readonly DeviceView[],
    change: Pick<DeviceChange, "devices" | "removed">
): DeviceView[] {
    const known = new Set(current.map((device) => device.id));
    return (
        applyDeviceChange(current, {
            devices: change.devices.filter((device) => known.has(device.id)),
            removed: change.removed
        }) ?? [...current]
    );
}

/** Whether it is night by the wall's own clock: nine in the evening to seven
 *  in the morning. */
export function isNight(date: Date): boolean {
    const hour = date.getHours();
    return hour >= 21 || hour < 7;
}
