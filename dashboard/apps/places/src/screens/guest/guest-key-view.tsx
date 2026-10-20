"use client";

/**
 * A door as somebody holding its link sees it: what it is, what state it is
 * in, and the buttons the link allows - Open and not Lock, for a link lent to
 * open it. Each press goes to the link's own route, which judges the bounds
 * again; a link fenced to the place asks the browser where it is only when
 * the route says it has to.
 */

import { useState } from "react";
import { MapPin } from "lucide-react";
import { Badge, cn } from "@polaris/ui";
import { usePlacesT } from "../use-places-t";
import * as kinds from "../../lib/device-kinds";
import { LentActionsProvider } from "../devices/lent-actions";
import { whereNow, type ReportedLocation } from "@polaris/core";
import type { DeviceAction, DeviceView } from "../../lib/device-kinds";
import { DeviceControls, DeviceIcon, stateClass } from "../devices/device-panel";

export function GuestKeyView({
    token,
    initial,
    allowed,
    nearbyMeters,
    until,
    note
}: {
    token: string;
    initial: DeviceView;
    /** The grant's actions (open, close, operate) this link allows. */
    allowed: readonly string[];
    nearbyMeters: number | null;
    until: string | null;
    note: string;
}) {
    const t = usePlacesT();
    const [device, setDevice] = useState(initial);
    const [busy, setBusy] = useState<DeviceAction | null>(null);
    const [error, setError] = useState("");

    async function send(
        action: DeviceAction,
        where?: ReportedLocation
    ): Promise<{ device?: DeviceView; error?: string; nearby?: string }> {
        const response = await fetch(`/api/home/keys/${token}`, {
            method: "POST",
            headers: { "content-type": "application/json" },
            body: JSON.stringify({ action, ...(where ? { where } : {}) })
        });
        return (await response.json().catch(() => ({ error: t("refusals.deviceCannot") }))) as {
            device?: DeviceView;
            error?: string;
            nearby?: string;
        };
    }

    async function act(action: DeviceAction) {
        setBusy(action);
        setError("");
        let answer = await send(action);
        // A link fenced to the place says so first; only then is the browser
        // asked where it is, and the press sent once more.
        if (answer.nearby === "unasked") {
            const where = await whereNow();
            if (where) answer = await send(action, where);
        }
        setBusy(null);
        if (answer.device) setDevice(answer.device);
        else setError(answer.error ?? t("refusals.deviceCannot"));
    }

    return (
        <LentActionsProvider lent={{ [device.id]: allowed }}>
            <section className="flex flex-col gap-4 rounded-lg border border-border bg-card p-5">
                <header className="flex min-w-0 flex-wrap items-center gap-2">
                    <DeviceIcon
                        kind={device.kind}
                        className="size-5 shrink-0 text-muted-foreground"
                    />
                    <h1 className="min-w-0 truncate text-base font-medium" title={device.name}>
                        {device.name}
                    </h1>
                    <Badge className={cn("shrink-0", stateClass(device))}>
                        {kinds.badgeText(device, t)}
                    </Badge>
                </header>
                {note ? <p className="text-sm text-muted-foreground">{note}</p> : null}
                <DeviceControls
                    device={device}
                    canControl={false}
                    busy={busy}
                    onAct={(action) => void act(action)}
                />
                {error ? (
                    <p role="alert" className="text-sm text-danger-ink">
                        {error}
                    </p>
                ) : null}
                {until || nearbyMeters ? (
                    <div className="flex flex-col gap-1 text-xs text-muted-foreground">
                        {until ? (
                            <p>{t("guest.until", { when: new Date(until).toLocaleString() })}</p>
                        ) : null}
                        {nearbyMeters ? (
                            <p className="flex items-center gap-1">
                                <MapPin className="size-3.5 shrink-0" aria-hidden />
                                {t("guest.nearby", { meters: nearbyMeters })}
                            </p>
                        ) : null}
                    </div>
                ) : null}
            </section>
        </LentActionsProvider>
    );
}
