/**
 * Operating one device for one person: the check, the act and the record,
 * once.
 *
 * Shared by the device panel's action and the assistant tool, so a door an
 * assistant opens is opened by exactly the rule, the count and the audit line
 * a press of the button would have used - never a second, weaker copy.
 *
 * Server-only.
 */

import * as devices from "./devices";
import { host } from "@polaris/app-host";
import type { AppHostTypes } from "@polaris/app-host";
import { countDeviceUse, requireDeviceControl } from "./sharing";
import type { DeviceAction, DeviceCommand, DeviceView } from "./device-kinds";

type SessionUser = AppHostTypes["SessionUser"];

/**
 * Operate a device as `user`, who must hold `home.control` or a live grant to
 * control this one. Throws a `HomeError` the person can read when they may
 * not, or when the device will not do it; the attempt is recorded either way
 * once it got as far as the device.
 */
export async function operateDevice(
    user: SessionUser,
    installedAppId: string,
    deviceId: string,
    action: DeviceAction,
    setting: DeviceCommand | undefined
): Promise<DeviceView> {
    const lent = await requireDeviceControl(user, deviceId);
    let device: DeviceView;
    try {
        device = await devices.actOnDevice(installedAppId, deviceId, action, user.name, setting);
    } catch (caught) {
        // Recorded refused as well as done. An attempt that was turned down is
        // the half of this log that says somebody tried.
        await host.auditService.recordAudit({
            actorId: user.id,
            action: `places.device.${action}.refused`,
            targetType: "placeDevice",
            targetId: deviceId
        });
        throw caught;
    }
    await countDeviceUse(lent);
    await host.auditService.recordAudit({
        actorId: user.id,
        action: `places.device.${action}`,
        targetType: "placeDevice",
        targetId: deviceId,
        // Which of the two rights was used, so the log tells a resident opening
        // their own door apart from a visitor spending one of four.
        metadata: {
            name: device.name,
            lent: Boolean(lent),
            ...(setting ? { setting } : {})
        }
    });
    return device;
}
