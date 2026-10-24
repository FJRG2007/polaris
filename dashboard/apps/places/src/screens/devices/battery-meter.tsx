"use client";

/**
 * How full a device's battery is, as an icon that empties with it and the
 * number beside it, in the danger tone once it is below the device's own low
 * line (`batteryLow`). Drawn nowhere for a device that does not report one.
 */

import { Battery, BatteryFull, BatteryLow, BatteryMedium, BatteryWarning } from "lucide-react";
import { cn } from "@polaris/ui";
import { usePlacesT } from "../use-places-t";
import { batteryLow } from "../../lib/automation-kinds";
import type { DeviceView } from "../../lib/device-kinds";

/** The icon for a level: three steps, and a warning once it is low. */
export function batteryIcon(percent: number, low: boolean): typeof Battery {
    if (low) return BatteryWarning;
    if (percent >= 70) return BatteryFull;
    if (percent >= 35) return BatteryMedium;
    if (percent > 0) return BatteryLow;
    return Battery;
}

export function BatteryMeter({
    device,
    className,
    large = false
}: {
    device: DeviceView;
    className?: string;
    /** The wall's size, read from across a room. */
    large?: boolean;
}) {
    const t = usePlacesT();
    if (device.batteryPercent === null) return null;
    const low = batteryLow(device);
    const Icon = batteryIcon(device.batteryPercent, low);
    const label = low
        ? `${t("battery.low")} - ${t("battery.level", { percent: device.batteryPercent })}`
        : t("battery.level", { percent: device.batteryPercent });
    return (
        <span
            role="img"
            aria-label={label}
            title={label}
            className={cn(
                "inline-flex shrink-0 items-center gap-1 tabular-nums",
                large ? "text-sm" : "text-[0.6875rem]",
                low ? "text-danger" : "text-muted-foreground",
                className
            )}
        >
            <Icon className={large ? "size-5" : "size-3.5"} aria-hidden />
            {device.batteryPercent}%
        </span>
    );
}
