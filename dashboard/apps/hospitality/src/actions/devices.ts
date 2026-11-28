"use server";

/**
 * The venue admin's side of devices: approve a code, list, rename, revoke.
 * All of it needs `hospitality.manage`. Every input is validated first.
 */

import * as devices from "../lib/devices";
import { invalid, outcome, type Outcome } from "../lib/outcome";
import { venueOnly } from "../model/order-schemas";
import { approveDeviceInput, deviceOnly, renameDeviceInput } from "../model/device-schemas";

export async function listDevicesAction(raw: unknown): Promise<Outcome<{ devices: devices.DeviceView[] }>> {
    const input = venueOnly.safeParse(raw);
    if (!input.success) return invalid();
    return outcome("hospitality.manage", async () => ({ devices: await devices.listDevices(input.data.venueId) }));
}

export async function approveDeviceAction(raw: unknown): Promise<Outcome<object>> {
    const input = approveDeviceInput.safeParse(raw);
    if (!input.success) return invalid();
    return outcome("hospitality.manage", async (user) => (await devices.approveLink(input.data, user.id), {}));
}

export async function renameDeviceAction(raw: unknown): Promise<Outcome<object>> {
    const input = renameDeviceInput.safeParse(raw);
    if (!input.success) return invalid();
    return outcome("hospitality.manage", async () => (await devices.renameDevice(input.data.id, input.data.name), {}));
}

export async function revokeDeviceAction(raw: unknown): Promise<Outcome<object>> {
    const input = deviceOnly.safeParse(raw);
    if (!input.success) return invalid();
    return outcome("hospitality.manage", async () => (await devices.revokeDevice(input.data.id), {}));
}
