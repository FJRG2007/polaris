"use client";

/**
 * A self-cleaning litter box: what it is doing, what it needs, who used it, and
 * the cycles and settings its own app offers.
 *
 * A row says what it is doing and the one thing worth knowing ("Waste bin
 * full") and offers Clean. The panel adds the litter level, the deodorizer, the
 * day's visits with the cat's weight, the cycle buttons and the settings the
 * box reports. Dumping empties all the litter out, so it asks first.
 */

import { useState } from "react";
import { Loader2, Pause, Play, RotateCcw, Sparkles, Trash2 } from "lucide-react";
import {
    Button,
    cn,
    Dialog,
    DialogContent,
    DialogDescription,
    DialogFooter,
    DialogHeader,
    DialogTitle,
    Switch
} from "@polaris/ui";
import { usePlacesT } from "../use-places-t";
import * as kinds from "../../lib/device-kinds";
import { controlReason } from "./device-switch";
import { hostUi } from "@polaris/app-host/client";
import type { DeviceAction, DeviceCommand, DeviceView } from "../../lib/device-kinds";

const { useDisplayFormat } = hostUi.displayFormat;

const ICONS = {
    clean: Sparkles,
    pause: Pause,
    resume: Play,
    dump: Trash2,
    "reset-deodorizer": RotateCcw
} as const;

type CycleAction = keyof typeof ICONS;

export function LitterControls({
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
    onAct: (action: DeviceAction, command?: DeviceCommand) => void;
    detailed?: boolean;
    className?: string;
}) {
    const t = usePlacesT();
    const format = useDisplayFormat();
    const [confirmDump, setConfirmDump] = useState(false);
    const view = device.litter ?? null;
    const reason = controlReason(device, canControl, t);
    const running = kinds.litterBusy(view);

    const why = (action: CycleAction): string => {
        if (reason) return reason;
        if ((action === "pause" || action === "resume") && !running)
            return t("devicePanel.litter.nothingRunning");
        if ((action === "clean" || action === "dump") && running)
            return t("devicePanel.litter.alreadyRunning");
        if (action === "reset-deodorizer" && !view?.deodorizerResettable)
            return t("devicePanel.litter.noDeodorizerReset");
        return "";
    };

    const button = (action: CycleAction) => {
        const Icon = ICONS[action];
        const blocked = why(action);
        return (
            <Button
                key={action}
                size="sm"
                variant={action === "clean" ? "primary" : "outline"}
                disabled={blocked !== "" || busy !== null}
                title={blocked || undefined}
                aria-label={t("devicePanel.litter.actionName", {
                    action: kinds.actionText(action, t),
                    name: device.name
                })}
                onClick={() => (action === "dump" ? setConfirmDump(true) : onAct(action))}
            >
                {busy === action ? (
                    <Loader2 className="size-4 shrink-0 animate-spin" />
                ) : (
                    <Icon className="size-4 shrink-0" aria-hidden="true" />
                )}
                {kinds.actionText(action, t)}
            </Button>
        );
    };

    if (!detailed) {
        const line = view ? kinds.litterLine(view, t) : "";
        return (
            <div className={cn("flex min-w-0 flex-wrap items-center gap-2", className)}>
                {line && (
                    <span className="min-w-0 truncate text-sm text-muted-foreground" title={line}>
                        {line}
                    </span>
                )}
                {canControl && button("clean")}
            </div>
        );
    }

    const rows: { label: string; value: string; tone?: "danger" | "warning" }[] = [];
    if (view) {
        rows.push({
            label: t("devicePanel.litter.status"),
            value: kinds.litterStatusText(view.status, t)
        });
        if (view.fault)
            rows.push({ label: t("devicePanel.litter.fault"), value: view.fault, tone: "danger" });
        if (view.litterPercent !== null || view.litterLow !== null)
            rows.push({
                label: t("devicePanel.litter.litter"),
                value: view.litterLow
                    ? t("devices.litter.litterLow")
                    : view.litterPercent !== null
                      ? t("devices.litter.litterLevel", { percent: view.litterPercent })
                      : t("devicePanel.litter.litterOk"),
                tone: view.litterLow ? "warning" : undefined
            });
        if (view.binFull !== null)
            rows.push({
                label: t("devicePanel.litter.bin"),
                value: view.binFull ? t("devices.litter.binFull") : t("devicePanel.litter.binOk"),
                tone: view.binFull ? "warning" : undefined
            });
        if (view.deodorizerDays !== null)
            rows.push({
                label: t("devicePanel.litter.deodorizer"),
                value: t("devicePanel.litter.daysLeft", { days: view.deodorizerDays })
            });
        if (view.usesToday !== null)
            rows.push({ label: t("devicePanel.litter.usesToday"), value: String(view.usesToday) });
        if (view.lastUseAt)
            rows.push({
                label: t("devicePanel.litter.lastUse"),
                value: format.dateTime(view.lastUseAt)
            });
    }
    const options = view
        ? kinds.LITTER_OPTIONS.filter((option) => view.options[option] !== undefined)
        : [];

    return (
        <div className={cn("flex min-w-0 flex-col gap-3", className)}>
            {rows.length > 0 ? (
                <dl className="grid grid-cols-[auto_minmax(0,1fr)] gap-x-4 gap-y-1 text-sm">
                    {rows.map((row) => (
                        <div key={row.label} className="contents">
                            <dt className="text-muted-foreground">{row.label}</dt>
                            <dd
                                className={cn(
                                    "min-w-0 break-words tabular-nums",
                                    row.tone === "danger" && "text-destructive",
                                    row.tone === "warning" && "text-warning"
                                )}
                            >
                                {row.value}
                            </dd>
                        </div>
                    ))}
                </dl>
            ) : (
                <p className="text-xs text-muted-foreground">{t("devicePanel.litter.unknown")}</p>
            )}

            {canControl && device.controllable && (
                <div className="flex flex-wrap gap-2">
                    {(Object.keys(ICONS) as CycleAction[]).map(button)}
                </div>
            )}

            {view && view.uses.length > 0 && (
                <section className="flex min-w-0 flex-col gap-1">
                    <h4 className="text-xs font-medium text-muted-foreground">
                        {t("devicePanel.litter.recentUses")}
                    </h4>
                    <ul className="flex min-w-0 flex-col gap-1 text-sm">
                        {view.uses.map((use) => (
                            <li key={use.at} className="flex min-w-0 items-baseline gap-2">
                                <span className="shrink-0 tabular-nums text-muted-foreground">
                                    {format.time(use.at)}
                                </span>
                                <span className="min-w-0 truncate" title={use.pet ?? undefined}>
                                    {use.pet ?? t("devicePanel.litter.someCat")}
                                </span>
                                {use.grams !== null && (
                                    <span className="ml-auto shrink-0 tabular-nums">
                                        {t("devicePanel.litter.weight", {
                                            kg: (use.grams / 1000).toFixed(2)
                                        })}
                                    </span>
                                )}
                            </li>
                        ))}
                    </ul>
                </section>
            )}

            {options.length > 0 && (
                <section className="flex min-w-0 flex-col gap-2">
                    <h4 className="text-xs font-medium text-muted-foreground">
                        {t("devicePanel.litter.settings")}
                    </h4>
                    {options.map((option) => (
                        <label
                            key={option}
                            className="flex min-w-0 items-center justify-between gap-3 text-sm"
                            title={reason || undefined}
                        >
                            <span className="min-w-0 truncate">
                                {kinds.litterOptionText(option, t)}
                            </span>
                            <Switch
                                checked={view?.options[option] === true}
                                disabled={reason !== "" || busy !== null}
                                onChange={(on) =>
                                    onAct("set-option", { action: "set-option", option, on })
                                }
                                aria-label={kinds.litterOptionText(option, t)}
                            />
                        </label>
                    ))}
                </section>
            )}

            <Dialog open={confirmDump} onOpenChange={setConfirmDump}>
                <DialogContent className="max-w-md">
                    <DialogHeader>
                        <DialogTitle>
                            {t("devicePanel.litter.dumpTitle", { name: device.name })}
                        </DialogTitle>
                        <DialogDescription>{t("devicePanel.litter.dumpBody")}</DialogDescription>
                    </DialogHeader>
                    <DialogFooter>
                        <Button variant="outline" onClick={() => setConfirmDump(false)}>
                            {t("devicePanel.litter.cancel")}
                        </Button>
                        <Button
                            variant="danger"
                            onClick={() => {
                                setConfirmDump(false);
                                onAct("dump");
                            }}
                        >
                            {t("devicePanel.litter.dumpConfirm")}
                        </Button>
                    </DialogFooter>
                </DialogContent>
            </Dialog>
        </div>
    );
}
