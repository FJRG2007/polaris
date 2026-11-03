"use client";

/**
 * A wall switch's or a socket's settings beside on and off: what it does after
 * a power cut, its indicator light, a child lock and a timer.
 *
 * Only what the device reports is drawn, so a switch with no child lock has no
 * toggle for one. Every change lands on the screen at once and is put back if
 * the device refuses it (`useDeviceAct`).
 */

import { usePlacesT } from "../use-places-t";
import * as kinds from "../../lib/device-kinds";
import { controlReason } from "./device-switch";
import type { ReactNode } from "react";
import { Select, Switch, cn } from "@polaris/ui";
import type { DeviceAction, DeviceCommand, DeviceView } from "../../lib/device-kinds";

export function SwitchSettings({
    device,
    canControl,
    busy,
    onAct,
    className
}: {
    device: DeviceView;
    canControl: boolean;
    busy: DeviceAction | null;
    onAct: (action: DeviceAction, command?: DeviceCommand) => void;
    className?: string;
}) {
    const t = usePlacesT();
    const view = device.switchSettings ?? null;
    if (!kinds.hasSwitchSettings(view) || !view) return null;
    const reason = controlReason(device, canControl, t);
    const disabled = reason !== "" || busy !== null;
    const set = (command: DeviceCommand) => onAct("set-option", command);

    const row = (label: string, control: ReactNode) => (
        <div
            key={label}
            className="flex min-w-0 items-center justify-between gap-3 text-sm"
            title={reason || undefined}
        >
            <span className="min-w-0 truncate" title={label}>
                {label}
            </span>
            {control}
        </div>
    );

    const countdownLabel =
        device.state === "on"
            ? t("devicePanel.switchSettings.countdownWhenOn")
            : t("devicePanel.switchSettings.countdownWhenOff");
    const countdown = view.countdown;

    return (
        <section className={cn("flex min-w-0 flex-col gap-2", className)}>
            <h4 className="text-xs font-medium text-muted-foreground">
                {t("devicePanel.switchSettings.title")}
            </h4>
            {view.powerOn !== null &&
                row(
                    t("devicePanel.switchSettings.powerOn"),
                    <Select
                        value={view.powerOn}
                        disabled={disabled}
                        aria-label={t("devicePanel.switchSettings.powerOn")}
                        className="w-40 shrink-0"
                        options={kinds.POWER_ON_STATES.map((value) => ({
                            value,
                            label: kinds.powerOnText(value, t)
                        }))}
                        onValueChange={(value) => {
                            const next = kinds.POWER_ON_STATES.find((entry) => entry === value);
                            if (next && next !== view.powerOn)
                                set({ action: "set-option", setting: "power-on", value: next });
                        }}
                    />
                )}
            {view.indicators.length > 0 &&
                row(
                    t("devicePanel.switchSettings.indicator"),
                    <Select
                        value={view.indicator ?? ""}
                        disabled={disabled}
                        aria-label={t("devicePanel.switchSettings.indicator")}
                        className="w-40 shrink-0"
                        options={view.indicators.map((value) => ({
                            value,
                            label: kinds.indicatorText(value, t)
                        }))}
                        onValueChange={(value) => {
                            const next = view.indicators.find((entry) => entry === value);
                            if (next && next !== view.indicator)
                                set({ action: "set-option", setting: "indicator", value: next });
                        }}
                    />
                )}
            {view.childLock !== null &&
                row(
                    t("devicePanel.switchSettings.childLock"),
                    <Switch
                        checked={view.childLock}
                        disabled={disabled}
                        aria-label={t("devicePanel.switchSettings.childLock")}
                        onChange={(on) => {
                            if (on !== view.childLock)
                                set({ action: "set-option", setting: "child-lock", on });
                        }}
                    />
                )}
            {countdown !== null &&
                row(
                    countdownLabel,
                    <div className="flex min-w-0 shrink-0 items-center gap-2">
                        {countdown > 0 && (
                            <span className="text-xs tabular-nums text-muted-foreground">
                                {t("devicePanel.switchSettings.left", {
                                    time: kinds.countdownText(countdown, t)
                                })}
                            </span>
                        )}
                        <Select
                            value={
                                (kinds.COUNTDOWN_CHOICES as readonly number[]).includes(countdown)
                                    ? String(countdown)
                                    : ""
                            }
                            placeholder={kinds.countdownText(countdown, t)}
                            disabled={disabled}
                            aria-label={countdownLabel}
                            className="w-32"
                            options={kinds.COUNTDOWN_CHOICES.map((seconds) => ({
                                value: String(seconds),
                                label: kinds.countdownText(seconds, t)
                            }))}
                            onValueChange={(value) => {
                                const seconds = Number(value);
                                if (Number.isInteger(seconds) && seconds !== countdown)
                                    set({ action: "set-option", setting: "countdown", seconds });
                            }}
                        />
                    </div>
                )}
        </section>
    );
}
