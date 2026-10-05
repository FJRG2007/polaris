"use client";

/**
 * An air conditioner's controls: its power, what it is doing, the temperature it
 * is aiming for, its fan, and - in the panel - whichever extras it has.
 *
 * Every one of them moves the moment it is used. The screen above applies the
 * change to the device before the answer arrives and puts it back if the answer
 * is a refusal, so these read the device and nothing else. The temperature is
 * its own control (`TemperatureTarget`), stepped or typed, and used wherever a
 * target is set from a device's controls.
 *
 * What a unit can be set to is the unit's own - the modes it has, its range and
 * its step, the extras it was built with - so nothing here offers a choice the
 * unit would refuse. When it cannot be operated at all the controls stay where
 * they are, showing its settings, and say why.
 */

import { usePlacesT } from "../use-places-t";
import * as kinds from "../../lib/device-kinds";
import { Thermometer } from "lucide-react";
import { Select, Switch, cn } from "@polaris/ui";
import { useId } from "react";
import { DeviceSwitch, controlReason } from "./device-switch";
import { TemperatureTarget } from "./temperature-target";
import type { ClimateCommand, DeviceAction, DeviceView } from "../../lib/device-kinds";

export function ClimateControls({
    device,
    canControl,
    busy,
    onAct,
    detailed = false,
    className
}: {
    device: DeviceView;
    canControl: boolean;
    busy: DeviceAction | null;
    onAct: (action: DeviceAction, command?: ClimateCommand) => void;
    /** The panel's version: labelled, with the extras. The row keeps to what is
     *  reached for every day. */
    detailed?: boolean;
    className?: string;
}) {
    const t = usePlacesT();
    const reasonId = useId();
    const climate = device.climate ?? null;
    const reason = controlReason(device, canControl, t);
    const locked = reason !== "";

    const describedBy = locked ? reasonId : undefined;
    const reasonNote = locked ? (
        <span id={reasonId} className="sr-only">
            {reason}
        </span>
    ) : null;

    if (!climate) {
        return (
            <div className={cn("flex flex-wrap items-center gap-2", className)}>
                <DeviceSwitch
                    device={device}
                    canControl={canControl}
                    busy={busy !== null}
                    onAct={(action) => onAct(action)}
                />
                {detailed && (
                    <p className="text-xs text-muted-foreground">
                        {t("devicePanel.climate.unknown")}
                    </p>
                )}
            </div>
        );
    }

    const disabled = locked || busy !== null;
    const label = (text: string) =>
        detailed ? <span className="text-xs text-muted-foreground">{text}</span> : null;

    const current = climate.current !== null && (
        <span
            className="inline-flex shrink-0 items-center gap-1 text-sm tabular-nums text-muted-foreground"
            title={t("devicePanel.climate.room")}
        >
            <Thermometer className="size-4 shrink-0" aria-hidden="true" />
            <span className="sr-only">{t("devicePanel.climate.room")}</span>
            {kinds.temperatureText(climate.current, climate.unit)}
        </span>
    );

    const mode = climate.modes.length > 0 && (
        <label className="flex min-w-0 flex-col gap-1" title={reason || undefined}>
            {label(t("devicePanel.climate.mode"))}
            <Select
                value={climate.mode ?? ""}
                disabled={disabled}
                aria-label={t("devicePanel.climate.modeName", { name: device.name })}
                className="w-32"
                options={climate.modes.map((value) => ({
                    value,
                    label: kinds.climateModeText(value, t)
                }))}
                onValueChange={(value) => {
                    const next = kinds.CLIMATE_MODES.find((entry) => entry === value);
                    if (next && next !== climate.mode)
                        onAct("set-mode", { action: "set-mode", mode: next });
                }}
            />
        </label>
    );

    const target = (
        <div className="flex flex-col gap-1" title={reason || undefined}>
            {label(t("devicePanel.climate.target"))}
            <TemperatureTarget
                name={device.name}
                settings={climate}
                disabled={disabled}
                describedBy={describedBy}
                onSet={(value) =>
                    onAct("set-temperature", { action: "set-temperature", target: value })
                }
            />
        </div>
    );

    const fan = climate.fans.length > 0 && (
        <label className="flex min-w-0 flex-col gap-1" title={reason || undefined}>
            {label(t("devicePanel.climate.fan"))}
            <Select
                value={climate.fan ?? ""}
                disabled={disabled}
                aria-label={t("devicePanel.climate.fanName", { name: device.name })}
                className="w-32"
                options={climate.fans.map((value) => ({
                    value,
                    label: kinds.climateFanText(value, t)
                }))}
                onValueChange={(value) => {
                    const next = kinds.CLIMATE_FANS.find((entry) => entry === value);
                    if (next && next !== climate.fan)
                        onAct("set-fan", { action: "set-fan", fan: next });
                }}
            />
        </label>
    );

    const extras = kinds.CLIMATE_OPTIONS.filter((option) => climate.options[option] !== undefined);

    return (
        <div className={cn("flex flex-col gap-3", className)}>
            <div
                className={cn(
                    "flex flex-wrap gap-x-3 gap-y-2",
                    detailed ? "items-end" : "items-center"
                )}
            >
                <DeviceSwitch
                    device={device}
                    canControl={canControl}
                    busy={busy !== null}
                    onAct={(action) => onAct(action)}
                    className={detailed ? "h-8" : undefined}
                />
                {current}
                {mode}
                {target}
                {fan}
                {reasonNote}
            </div>
            {detailed && extras.length > 0 && (
                <fieldset className="flex flex-col gap-2" aria-describedby={describedBy}>
                    <legend className="mb-1 text-xs text-muted-foreground">
                        {t("devicePanel.climate.extras")}
                    </legend>
                    <div className="flex flex-wrap gap-x-5 gap-y-2" title={reason || undefined}>
                        {extras.map((option) => (
                            <label key={option} className="inline-flex items-center gap-2 text-sm">
                                <Switch
                                    checked={climate.options[option] === true}
                                    disabled={disabled}
                                    aria-label={t("devicePanel.climate.optionName", {
                                        option: kinds.climateOptionText(option, t),
                                        name: device.name
                                    })}
                                    onChange={(on) =>
                                        onAct("set-option", { action: "set-option", option, on })
                                    }
                                />
                                {kinds.climateOptionText(option, t)}
                            </label>
                        ))}
                    </div>
                </fieldset>
            )}
        </div>
    );
}
