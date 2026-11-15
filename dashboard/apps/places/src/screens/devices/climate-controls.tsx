"use client";

/**
 * An air conditioner's controls: its power, what it is doing, the temperature it
 * is aiming for, its fan, and - in the panel - whichever extras it has.
 *
 * Every one of them moves the moment it is used. The screen above applies the
 * change to the device before the answer arrives and puts it back if the answer
 * is a refusal, so these read the device and nothing else. The temperature is
 * its own control (`TemperatureTarget`), dragged or typed - a thermostat dial in
 * the panel, a slider in the row - and the mode is a row of large icon buttons,
 * as on Home Assistant's climate dialog and the Google Home thermostat.
 *
 * What a unit can be set to is the unit's own - the modes it has, its range and
 * its step, the extras it was built with - so nothing here offers a choice the
 * unit would refuse. When it cannot be operated at all the controls stay where
 * they are, showing its settings, and say why.
 */

import { usePlacesT } from "../use-places-t";
import * as kinds from "../../lib/device-kinds";
import { Droplet, Fan, Flame, Snowflake, Thermometer } from "lucide-react";
import { SegmentedControl, Select, Switch, cn } from "@polaris/ui";
import { useId } from "react";
import { DeviceSwitch, controlReason } from "./device-switch";
import { TemperatureTarget } from "./temperature-target";
import type { DialTone } from "./controls/thermostat-dial";
import type { LucideIcon } from "lucide-react";
import type { ClimateCommand, DeviceAction, DeviceView } from "../../lib/device-kinds";

const MODE_ICONS: Readonly<Record<kinds.ClimateMode, LucideIcon>> = {
    cool: Snowflake,
    heat: Flame,
    dry: Droplet,
    fan: Fan,
    auto: Thermometer
};

const MODE_TONES: Readonly<Record<kinds.ClimateMode, DialTone>> = {
    cool: "cool",
    heat: "heat",
    dry: "dry",
    fan: "idle",
    auto: "auto"
};

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
        <div className="flex min-w-0 flex-col gap-1" title={reason || undefined}>
            {label(t("devicePanel.climate.mode"))}
            <SegmentedControl
                size="lg"
                value={climate.mode}
                aria-label={t("devicePanel.climate.modeName", { name: device.name })}
                className={detailed ? "w-full" : undefined}
                options={climate.modes.map((value) => {
                    const Icon = MODE_ICONS[value];
                    const text = kinds.climateModeText(value, t);
                    return {
                        value,
                        disabled,
                        title: text,
                        label: (
                            <>
                                <Icon className="size-5 shrink-0" aria-hidden="true" />
                                {/* The row has room for the icons; the name is
                                    still each button's own, read aloud. */}
                                <span className={detailed ? undefined : "sr-only"}>{text}</span>
                            </>
                        )
                    };
                })}
                onValueChange={(next) => {
                    if (next !== climate.mode) onAct("set-mode", { action: "set-mode", mode: next });
                }}
            />
        </div>
    );

    const target = (
        <div
            className={cn("flex min-w-0 flex-col gap-1", detailed && "w-full")}
            title={reason || undefined}
        >
            {!detailed && label(t("devicePanel.climate.target"))}
            <TemperatureTarget
                name={device.name}
                settings={climate}
                disabled={disabled}
                describedBy={describedBy}
                variant={detailed ? "dial" : "row"}
                tone={device.state === "off" || !climate.mode ? "idle" : MODE_TONES[climate.mode]}
                current={climate.current}
                onSet={(value) =>
                    onAct("set-temperature", { action: "set-temperature", target: value })
                }
            />
        </div>
    );

    const fanName = t("devicePanel.climate.fanName", { name: device.name });
    const pickFan = (value: string) => {
        const next = kinds.CLIMATE_FANS.find((entry) => entry === value);
        if (next && next !== climate.fan) onAct("set-fan", { action: "set-fan", fan: next });
    };
    const fanOptions = climate.fans.map((value) => ({
        value,
        label: kinds.climateFanText(value, t)
    }));
    const fan = climate.fans.length > 0 && (
        <div className="flex min-w-0 flex-col gap-1" title={reason || undefined}>
            {label(t("devicePanel.climate.fan"))}
            {detailed ? (
                <SegmentedControl
                    size="lg"
                    value={climate.fan}
                    aria-label={fanName}
                    className="w-full"
                    options={fanOptions.map((option) => ({ ...option, disabled }))}
                    onValueChange={pickFan}
                />
            ) : (
                <Select
                    value={climate.fan ?? ""}
                    disabled={disabled}
                    aria-label={fanName}
                    className="w-32"
                    options={fanOptions}
                    onValueChange={pickFan}
                />
            )}
        </div>
    );

    const extras = kinds.CLIMATE_OPTIONS.filter((option) => climate.options[option] !== undefined);

    return (
        <div className={cn("flex flex-col gap-3", className)}>
            {detailed ? (
                <>
                    <div className="flex flex-wrap items-center gap-x-3 gap-y-2">
                        <DeviceSwitch
                            device={device}
                            canControl={canControl}
                            busy={busy !== null}
                            onAct={(action) => onAct(action)}
                            className="h-8"
                        />
                        {reasonNote}
                    </div>
                    {target}
                    {mode}
                    {fan}
                </>
            ) : (
                <div className="flex flex-wrap items-center gap-x-3 gap-y-2">
                    <DeviceSwitch
                        device={device}
                        canControl={canControl}
                        busy={busy !== null}
                        onAct={(action) => onAct(action)}
                    />
                    {current}
                    {mode}
                    {target}
                    {fan}
                    {reasonNote}
                </div>
            )}
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
