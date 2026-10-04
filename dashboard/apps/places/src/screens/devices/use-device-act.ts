"use client";

/**
 * Telling a device to do something, from any screen that lists devices.
 *
 * Where the outcome is known before anything answers - a switch told to go on is
 * on or it failed - the device moves there at once and moves back if the answer
 * is a refusal, so a switch flips under the finger rather than a second later. A
 * lock is left alone until it reports: it is turning, and where it gets to is the
 * vendor's to say.
 *
 * Shared by the devices screen and the Overview so the two never disagree about
 * what a press does, and a fix to the rollback lands in both.
 */

import { useState } from "react";
import * as actions from "../actions";
import * as kinds from "../../lib/device-kinds";
import { hostUi } from "@polaris/app-host/client";
import type { DeviceAction, DeviceCommand, DeviceView } from "../../lib/device-kinds";

const { runAction } = hostUi.runAction;

export function useDeviceAct({
    update,
    setError,
    resync
}: {
    /** Apply a change to every copy of a device the screen holds - the list and
     *  an open panel - so they never disagree about what a door is doing. */
    update: (change: (entry: DeviceView) => DeviceView) => void;
    setError: (message: string) => void;
    /** Read the list again, quietly; asked for once a few seconds after a press. */
    resync: () => void;
}) {
    const [busy, setBusy] = useState<{ id: string; action: DeviceAction } | null>(null);

    const act = async (device: DeviceView, action: DeviceAction, command?: DeviceCommand) => {
        setBusy({ id: device.id, action });
        setError("");
        const settle = (next: DeviceView) =>
            update((entry) => (entry.id === next.id ? next : entry));
        const settled = kinds.settledState(action);
        // A setting lands where it was told, like a switch: the row shows it now
        // and puts the old one back if the unit refuses. An air conditioner keeps
        // its room temperature beside its settings; a purifier's are whole.
        const applied = command
            ? kinds.applyCommand(
                  {
                      kind: device.kind,
                      climate: device.climate ?? null,
                      air: device.air ?? null
                  },
                  command
              )
            : null;
        const climate =
            applied && "climate" in applied && device.climate
                ? { ...device.climate, ...applied.climate }
                : null;
        const air = applied && "air" in applied ? applied.air : null;
        if (climate) settle({ ...device, climate });
        else if (air) settle({ ...device, air });
        else if (settled) settle({ ...device, state: settled });
        const result = await runAction(
            () => actions.operateDeviceAction(device.id, action, command),
            setError
        );
        setBusy(null);
        if (!result || result.error) {
            // Only what this press changed is put back, and only while it is
            // still what this press made it: a later press, or a sync, wins.
            if (climate || air || settled) {
                update((entry) => {
                    if (entry.id !== device.id) return entry;
                    if (climate && entry.climate === climate)
                        return { ...entry, climate: device.climate };
                    if (air && entry.air === air) return { ...entry, air: device.air };
                    if (!climate && !air && settled && entry.state === settled)
                        return { ...entry, state: device.state };
                    return entry;
                });
            }
            if (!result) return;
            setError(result.error ?? "");
            throw new Error(result.error);
        }
        if (result.device) settle(result.device);
        // The lock answers before the door has finished moving, so the state that
        // matters is the one after it. Asked for once, a few seconds later, rather
        // than left saying "moving" until the minute is up.
        setTimeout(resync, 4000);
    };

    return { busy, act };
}
