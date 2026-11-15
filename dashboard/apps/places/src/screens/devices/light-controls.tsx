"use client";

/**
 * A light's more-info controls, after Home Assistant's light dialog and the
 * Google Home / Apple Home tiles: a tall brightness bar you drag, a colour
 * temperature bar painted warm to cold in kelvin, and a colour wheel - each
 * drawn only when the light reports it. Every one shows where it is dragged at
 * once and sends the value it is let go on; the row's optimistic update and
 * rollback are `useDeviceAct`'s, which is what `onAct` reaches.
 */

import { useState } from "react";
import { ControlSlider, cn } from "@polaris/ui";
import { Sun } from "lucide-react";
import { usePlacesT } from "../use-places-t";
import { ColorWheel } from "./color-wheel";
import type { DeviceAction, DeviceCommand, DeviceView } from "../../lib/device-kinds";

/**
 * The colour of white light at a temperature, as sRGB 0-255: Tanner Helland's
 * fit to the blackbody curve, which Home Assistant's `temperature2rgb` uses too.
 */
export function kelvinToRgb(kelvin: number): [number, number, number] {
    const k = Math.min(40_000, Math.max(1_000, kelvin)) / 100;
    const clamp = (n: number) => Math.round(Math.min(255, Math.max(0, n)));
    const red = k <= 66 ? 255 : 329.698727446 * (k - 60) ** -0.1332047592;
    const green =
        k <= 66 ? 99.4708025861 * Math.log(k) - 161.1195681661 : 288.1221695283 * (k - 60) ** -0.0755148492;
    const blue = k >= 66 ? 255 : k <= 19 ? 0 : 138.5177312231 * Math.log(k - 10) - 305.0447927307;
    return [clamp(red), clamp(green), clamp(blue)];
}

/** The colour temperature track, warm at the left (its minimum) to cold. */
export function kelvinTrack(min: number, max: number, stops = 6): string {
    const colors = Array.from({ length: stops }, (_, index) => {
        const [r, g, b] = kelvinToRgb(min + ((max - min) * index) / (stops - 1));
        return `rgb(${r} ${g} ${b})`;
    });
    return `linear-gradient(to right, ${colors.join(", ")})`;
}

/** Brightness, colour temperature and a colour wheel, each drawn only when the light has it. */
export function LightControls({
    device,
    canControl,
    onAct,
    className
}: {
    device: DeviceView;
    canControl: boolean;
    onAct: (action: DeviceAction, command?: DeviceCommand) => void;
    className?: string;
}) {
    const t = usePlacesT();
    const [liveLevel, setLiveLevel] = useState<number | null>(null);
    const [liveKelvin, setLiveKelvin] = useState<number | null>(null);
    const light = device.light ?? null;
    if (!light) return null;
    const disabled = !canControl || !device.online;
    const brightness = light.brightness;
    const temperature = light.temperature;
    const brightnessLabel = t("devices.actions.set-brightness");
    const warmthLabel = t("devices.actions.set-color-temp");
    const brightnessShown = liveLevel ?? brightness?.level ?? null;
    const kelvinShown = liveKelvin ?? temperature?.kelvin ?? null;
    return (
        <div className={cn("flex flex-col gap-4", className)}>
            {brightness || light.color ? (
                <div className="flex flex-wrap items-center justify-center gap-6">
                    {brightness ? (
                        <ControlSlider
                            orientation="vertical"
                            label={brightnessLabel}
                            value={brightness.level}
                            min={1}
                            max={100}
                            step={1}
                            valueText={(level) => `${level}%`}
                            disabled={disabled}
                            onLive={setLiveLevel}
                            onCommit={(level) =>
                                onAct("set-brightness", { action: "set-brightness", level })
                            }
                            className="h-56 w-24"
                        >
                            <Sun className="size-5 shrink-0" aria-hidden="true" />
                            <span>{brightnessShown === null ? "-" : `${brightnessShown}%`}</span>
                        </ControlSlider>
                    ) : null}
                    {light.color ? (
                        <ColorWheel
                            className="w-56 max-w-full"
                            label={t("devices.actions.set-color")}
                            valueText={({ hue, saturation }) =>
                                t("devices.colorValue", { hue, saturation })
                            }
                            value={
                                light.color.hue === null
                                    ? null
                                    : {
                                          hue: light.color.hue,
                                          saturation: light.color.saturation ?? 100
                                      }
                            }
                            disabled={disabled}
                            onCommit={({ hue, saturation }) =>
                                onAct("set-color", { action: "set-color", hue, saturation })
                            }
                        />
                    ) : null}
                </div>
            ) : null}
            {temperature ? (
                <div className="flex min-w-0 flex-col gap-1">
                    <span className="flex items-baseline justify-between gap-2 text-xs text-muted-foreground">
                        <span className="truncate">{warmthLabel}</span>
                        <span className="shrink-0 tabular-nums">
                            {kelvinShown === null
                                ? "-"
                                : t("devices.kelvinValue", { value: kelvinShown })}
                        </span>
                    </span>
                    <ControlSlider
                        mode="cursor"
                        label={warmthLabel}
                        value={temperature.kelvin}
                        min={temperature.min}
                        max={temperature.max}
                        step={50}
                        valueText={(kelvin) => t("devices.kelvinValue", { value: kelvin })}
                        track={kelvinTrack(temperature.min, temperature.max)}
                        disabled={disabled}
                        onLive={setLiveKelvin}
                        onCommit={(kelvin) =>
                            onAct("set-color-temp", { action: "set-color-temp", kelvin })
                        }
                    />
                </div>
            ) : null}
        </div>
    );
}
