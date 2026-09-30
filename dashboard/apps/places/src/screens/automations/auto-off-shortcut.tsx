"use client";

/**
 * "Turn it off by itself after this long on", on a switch's own panel, in one
 * press.
 *
 * The request people make of a smart plug more than any other, so it is not
 * behind the automations screen: the minutes and one button, and the result is
 * an ordinary automation that can be opened, changed or switched off like any
 * other. A lock gets the same thing the other way round - lock again after it
 * has been left unlocked.
 *
 * Its own component so the panel carries one line for it.
 */

import Link from "next/link";
import { useState } from "react";
import * as actions from "./actions";
import { Button, Select } from "@polaris/ui";
import { usePlacesT } from "../use-places-t";
import { Loader2, Timer } from "lucide-react";
import { hostUi } from "@polaris/app-host/client";
import * as auto from "../../lib/automation-kinds";
import type { DeviceView } from "../../lib/device-kinds";
import { dropAutomationsCache } from "./cache";

const { runAction } = hostUi.runAction;
const { useDisplayFormat } = hostUi.displayFormat;

const MINUTES = [5, 10, 15, 30, 60, 120, 240];

export function AutoOffShortcut({
    device,
    canManage,
    canControl
}: {
    device: DeviceView;
    canManage: boolean;
    canControl: boolean;
}) {
    const t = usePlacesT();
    const format = useDisplayFormat();
    const [minutes, setMinutes] = useState("30");
    const [busy, setBusy] = useState(false);
    const [error, setError] = useState("");
    const [made, setMade] = useState<auto.AutomationView | null>(null);
    const plan = auto.autoOffPlan(device.kind);
    if (!canManage || !canControl || !plan || !device.controllable) return null;
    const locks = plan.do === "lock";

    const add = async () => {
        setBusy(true);
        setError("");
        const result = await runAction(
            () =>
                actions.addAutoOffAction(
                    device.id,
                    Number(minutes),
                    auto.readerZone(format.preferences.timeZone)
                ),
            setError
        );
        setBusy(false);
        if (!result) return;
        if (result.error || !result.automation) {
            setError(result.error ?? t("refusals.failed"));
            return;
        }
        dropAutomationsCache();
        setMade(result.automation);
    };

    return (
        <section
            className="flex flex-col gap-2 border-t border-border pt-4"
            aria-labelledby={`auto-off-${device.id}`}
        >
            <h3
                id={`auto-off-${device.id}`}
                className="flex items-center gap-1.5 text-sm font-medium"
            >
                <Timer className="size-4 shrink-0 text-muted-foreground" />
                {locks ? t("automations.shortcut.lockTitle") : t("automations.shortcut.offTitle")}
            </h3>
            {made ? (
                <p role="status" className="text-xs text-muted-foreground">
                    {t.rich("automations.shortcut.made", {
                        name: made.name,
                        open: (chunks) => (
                            <Link
                                key="open"
                                href={`/places/devices/automations/${made.id}`}
                                className="font-medium text-foreground underline underline-offset-2"
                            >
                                {chunks}
                            </Link>
                        )
                    })}
                </p>
            ) : (
                <div className="flex flex-wrap items-center gap-2">
                    <span className="text-xs text-muted-foreground">
                        {locks
                            ? t("automations.shortcut.lockAfter")
                            : t("automations.shortcut.offAfter")}
                    </span>
                    <Select
                        value={minutes}
                        className="w-32"
                        aria-label={t("automations.shortcut.minutes")}
                        options={MINUTES.map((value) => ({
                            value: String(value),
                            label: t("automations.units.minutes", { count: value })
                        }))}
                        onValueChange={setMinutes}
                    />
                    <Button size="sm" variant="outline" disabled={busy} onClick={() => void add()}>
                        {busy && <Loader2 className="size-4 animate-spin" />}
                        {t("automations.shortcut.add")}
                    </Button>
                </div>
            )}
            {error && (
                <p role="alert" className="text-xs text-danger">
                    {error}
                </p>
            )}
        </section>
    );
}
