"use client";

/**
 * On and off, as one switch where the device is now - and the one sentence that
 * says why a control cannot be used.
 *
 * Its own file because two sets of controls draw it: the switch, socket and
 * light rows, and an air conditioner's, whose power is the same switch with a
 * mode and a temperature beside it.
 */

import { useId } from "react";
import { Switch, cn } from "@polaris/ui";
import { usePlacesT } from "../use-places-t";
import type { PlacesTranslator } from "../../lib/i18n";
import type { DeviceAction, DeviceView } from "../../lib/device-kinds";

/** Why a device's controls cannot be used now, or an empty string when they can.
 *  Said rather than only greyed out: a control that is merely unavailable reads
 *  as broken. */
export function controlReason(
    device: DeviceView,
    canControl: boolean,
    t: PlacesTranslator
): string {
    if (!canControl) return t("devicePanel.noControl");
    if (!device.controllable) return t("devicePanel.watchOnly");
    if (!device.online) return t("devicePanel.offline");
    return "";
}

/**
 * It flips the moment it is pressed: the screen above moves the device to where
 * it was told before the answer arrives, and back if the answer is a refusal. So
 * this reads the device and nothing else - there is no second, local idea of the
 * state to fall out of step with the badge beside it.
 *
 * When it cannot be pressed it still shows where the device is, off limits, and
 * says why - on hover, and to a screen reader - rather than disappearing.
 */
export function DeviceSwitch({
    device,
    canControl,
    busy,
    onAct,
    className
}: {
    device: DeviceView;
    canControl: boolean;
    busy: boolean;
    onAct: (action: DeviceAction) => void;
    className?: string;
}) {
    const t = usePlacesT();
    const reasonId = useId();
    const reason = controlReason(device, canControl, t);
    const on = device.online && device.state === "on";
    return (
        <span className={cn("inline-flex items-center", className)} title={reason || undefined}>
            <Switch
                checked={on}
                disabled={reason !== "" || busy}
                onChange={(next) => onAct(next ? "turn-on" : "turn-off")}
                aria-label={t("devicePanel.switchName", { name: device.name })}
                aria-describedby={reason ? reasonId : undefined}
            />
            {reason && (
                <span id={reasonId} className="sr-only">
                    {reason}
                </span>
            )}
        </span>
    );
}
