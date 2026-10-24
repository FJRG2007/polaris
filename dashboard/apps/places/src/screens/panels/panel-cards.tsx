"use client";

/**
 * What a wall panel's cards draw: a device with every control it really has,
 * a room with its devices, and a clock. The controls are the devices screen's
 * own (`DeviceControls`), so a light offers a slider only when it dims, a
 * colour only when it is coloured, and a switch only when it switches.
 */

import { Badge, cn } from "@polaris/ui";
import { useEffect, useState } from "react";
import { usePlacesT } from "../use-places-t";
import * as kinds from "../../lib/device-kinds";
import { hostUi } from "@polaris/app-host/client";
import { BatteryMeter } from "../devices/battery-meter";
import { DeviceControls, DeviceIcon, stateClass } from "../devices/device-panel";
import type { DeviceAction, DeviceCommand, DeviceView } from "../../lib/device-kinds";

export interface CardActs {
    readonly canControl: boolean;
    readonly busy: { id: string; action: DeviceAction } | null;
    readonly onAct: (device: DeviceView, action: DeviceAction, command?: DeviceCommand) => void;
}

/** The frame every card sits in. */
function CardFrame({ children, className }: { children: React.ReactNode; className?: string }) {
    return (
        <div
            className={cn(
                "flex h-full min-h-0 min-w-0 flex-col gap-3 overflow-hidden rounded-xl border border-border bg-card p-4",
                className
            )}
        >
            {children}
        </div>
    );
}

/** One device: its name, state and battery, and the controls it has. */
export function DeviceTile({ device, acts }: { device: DeviceView; acts: CardActs }) {
    const t = usePlacesT();
    const busy = acts.busy?.id === device.id ? acts.busy.action : null;
    return (
        <CardFrame>
            <div className="flex min-w-0 items-center gap-2">
                <DeviceIcon kind={device.kind} className="size-5 shrink-0 text-muted-foreground" />
                <span className="min-w-0 flex-1 truncate text-base font-medium" title={device.name}>
                    {device.name}
                </span>
                <BatteryMeter device={device} large />
            </div>
            <Badge className={cn("w-fit shrink-0", stateClass(device))}>
                {kinds.badgeText(device, t)}
            </Badge>
            <div className="min-h-0 flex-1 overflow-y-auto overscroll-contain">
                <DeviceControls
                    device={device}
                    canControl={acts.canControl}
                    busy={busy}
                    onAct={(action, command) => acts.onAct(device, action, command)}
                    detailed
                />
            </div>
        </CardFrame>
    );
}

/** A room: each of its devices on a line, with the one control a line holds. */
export function RoomCard({
    name,
    devices,
    acts
}: {
    name: string;
    devices: readonly DeviceView[];
    acts: CardActs;
}) {
    const t = usePlacesT();
    return (
        <CardFrame>
            <h2 className="min-w-0 truncate text-base font-medium" title={name}>
                {name}
            </h2>
            {devices.length === 0 ? (
                <p className="text-sm text-muted-foreground">{t("panels.roomEmpty")}</p>
            ) : (
                <ul className="flex min-h-0 flex-1 flex-col gap-3 overflow-y-auto overscroll-contain">
                    {devices.map((device) => (
                        <li key={device.id} className="flex min-w-0 flex-wrap items-center gap-2">
                            <DeviceIcon
                                kind={device.kind}
                                className="size-4 shrink-0 text-muted-foreground"
                            />
                            <span className="min-w-0 flex-1 truncate text-sm" title={device.name}>
                                {device.name}
                            </span>
                            <BatteryMeter device={device} />
                            <DeviceControls
                                device={device}
                                canControl={acts.canControl}
                                busy={acts.busy?.id === device.id ? acts.busy.action : null}
                                onAct={(action, command) => acts.onAct(device, action, command)}
                            />
                        </li>
                    ))}
                </ul>
            )}
        </CardFrame>
    );
}

/** The time and the date, in the reader's language. */
export function ClockCard() {
    const locale = hostUi.i18nProvider.useLocale();
    const [now, setNow] = useState<Date | null>(null);
    useEffect(() => {
        setNow(new Date());
        const timer = setInterval(() => setNow(new Date()), 15_000);
        return () => clearInterval(timer);
    }, []);
    return (
        <CardFrame className="items-center justify-center text-center">
            <span className="text-4xl font-semibold tabular-nums">
                {now
                    ? new Intl.DateTimeFormat(locale, { hour: "2-digit", minute: "2-digit" }).format(
                          now
                      )
                    : "--:--"}
            </span>
            <span className="min-w-0 truncate text-sm text-muted-foreground">
                {now
                    ? new Intl.DateTimeFormat(locale, {
                          weekday: "long",
                          day: "numeric",
                          month: "long"
                      }).format(now)
                    : ""}
            </span>
        </CardFrame>
    );
}

/** A card whose device or room is gone. */
export function GoneCard() {
    const t = usePlacesT();
    return (
        <CardFrame className="justify-center">
            <p className="text-sm text-muted-foreground">{t("panels.cardGone")}</p>
        </CardFrame>
    );
}
