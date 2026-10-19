"use client";

/**
 * One UPS: what it says now, its history, its beeper and battery test, the
 * machines it shuts down when the battery runs low, and how it is reached.
 *
 * Everything that is the UPS's own settings paints at once from the page; the
 * reading and the chart wait on `/api/servers/ups/<id>`, read again every few
 * seconds while the tab is visible, each region with a skeleton of its own.
 */

import Link from "next/link";
import { useMemo, useState } from "react";
import { useRouter } from "next/navigation";
import { ArrowLeft, Pencil, Trash2 } from "lucide-react";
import {
    Badge,
    Button,
    Checkbox,
    ConfirmDeleteDialog,
    Dialog,
    DialogContent,
    DialogDescription,
    DialogFooter,
    DialogHeader,
    DialogTitle,
    Input,
    MultiSeriesChart,
    PageHeader,
    SegmentedControl,
    Skeleton,
    Switch,
    useToast
} from "@polaris/ui";
import * as upsReading from "@/lib/ups/ups-reading";
import type { UpsView } from "@/lib/ups/ups-service";
import { UpsConnectionDialog } from "../ups-connection-dialog";
import { useLiveResource } from "@/components/use-live-resource";
import { useTranslations } from "@/components/i18n/i18n-provider";
import { removeUpsAction, runUpsCommandAction, updateUpsShutdownAction } from "../actions";
import { minutesLeft, rounded, upsStatus, type UpsDetailAnswer, type UpsMachine } from "../ups-words";

const POLL_MS = 10_000;
const RANGES = { h6: 6, h24: 24, d7: 168, d30: 720 } as const;
type RangeKey = keyof typeof RANGES;

export function UpsDetailView({ initial, machines }: { initial: UpsView; machines: UpsMachine[] }) {
    const t = useTranslations("servers");
    const router = useRouter();
    const [range, setRange] = useState<RangeKey>("h24");
    const [editing, setEditing] = useState(false);
    const [removing, setRemoving] = useState(false);
    const [removeError, setRemoveError] = useState<string | null>(null);
    const live = useLiveResource<UpsDetailAnswer>({
        url: `/api/servers/ups/${initial.id}?hours=${RANGES[range]}`,
        cacheKey: `ups:${initial.id}:${range}`,
        intervalMs: POLL_MS,
        select: (body) => body as UpsDetailAnswer
    });
    const ups = live.data?.ups ?? initial;
    const result = live.data?.result ?? null;
    const reading = result?.ok ? result.reading : null;

    async function remove() {
        const outcome = await removeUpsAction(ups.id);
        if (!outcome.ok) {
            setRemoveError(t(`ups.errors.${outcome.error === "notFound" ? "notFound" : "failed"}`));
            return;
        }
        router.push("/apps/servers/ups");
    }

    return (
        <>
            <Link
                href="/apps/servers/ups"
                className="mb-3 inline-flex items-center gap-1 text-sm text-muted-foreground hover:text-foreground"
            >
                <ArrowLeft className="size-4 shrink-0" aria-hidden />
                {t("ups.back")}
            </Link>
            <PageHeader
                title={ups.name}
                description={t(`ups.connection.${ups.connection}`)}
                actions={
                    <div className="flex gap-2">
                        <Button variant="outline" onClick={() => setEditing(true)}>
                            <Pencil className="size-4 shrink-0" aria-hidden />
                            {t("ups.edit")}
                        </Button>
                        <Button variant="outline" onClick={() => setRemoving(true)}>
                            <Trash2 className="size-4 shrink-0" aria-hidden />
                            {t("ups.remove")}
                        </Button>
                    </div>
                }
            />

            <div className="flex flex-col gap-6">
                <section aria-labelledby="ups-now" className="flex flex-col gap-3">
                    <div className="flex flex-wrap items-center gap-2">
                        <h2 id="ups-now" className="text-sm font-medium">
                            {t("ups.regions.now")}
                        </h2>
                        {result === null ? (
                            <Skeleton className="h-5 w-20" />
                        ) : (
                            <Badge variant={upsStatus(reading).tone}>
                                {t(`ups.status.${upsStatus(reading).key}`)}
                            </Badge>
                        )}
                    </div>
                    {result && !result.ok ? (
                        <p role="status" className="text-sm text-muted-foreground">
                            {t(`ups.unreachable.${result.reason}`)}
                        </p>
                    ) : (
                        <UpsNow reading={reading} />
                    )}
                </section>

                <section aria-labelledby="ups-history" className="flex flex-col gap-3">
                    <div className="flex flex-wrap items-center justify-between gap-2">
                        <h2 id="ups-history" className="text-sm font-medium">
                            {t("ups.regions.history")}
                        </h2>
                        <SegmentedControl<RangeKey>
                            size="sm"
                            aria-label={t("ups.regions.history")}
                            value={range}
                            onValueChange={setRange}
                            options={(Object.keys(RANGES) as RangeKey[]).map((key) => ({
                                value: key,
                                label: t(`ups.ranges.${key}`)
                            }))}
                        />
                    </div>
                    <UpsHistory answer={live.data} hours={RANGES[range]} />
                </section>

                <section aria-labelledby="ups-controls" className="flex flex-col gap-3">
                    <h2 id="ups-controls" className="text-sm font-medium">
                        {t("ups.regions.controls")}
                    </h2>
                    {result === null ? <Skeleton className="h-16 w-full" /> : <UpsControls id={ups.id} reading={reading} />}
                </section>

                <section aria-labelledby="ups-shutdown" className="flex flex-col gap-3">
                    <h2 id="ups-shutdown" className="text-sm font-medium">
                        {t("ups.regions.shutdown")}
                    </h2>
                    <UpsShutdown ups={initial} machines={machines} sentAt={ups.shutdownSentAt} />
                </section>
            </div>

            {editing ? (
                <UpsConnectionDialog
                    open
                    onOpenChange={setEditing}
                    editing={ups}
                    machines={machines}
                    offers={[]}
                    onSaved={() => {
                        live.refresh();
                        router.refresh();
                    }}
                />
            ) : null}
            <ConfirmDeleteDialog
                open={removing}
                onOpenChange={(open) => {
                    setRemoving(open);
                    setRemoveError(null);
                }}
                name={ups.name}
                kind={t("ups.removeKind")}
                description={t("ups.removeBody")}
                confirmLabel={t("ups.remove")}
                error={removeError}
                onConfirm={() => void remove()}
            />
        </>
    );
}

function UpsNow({ reading }: { reading: upsReading.UpsReading | null }) {
    const t = useTranslations("servers");
    const percent = (value: number | null) => {
        const shown = rounded(value);
        return shown === null ? null : t("ups.units.percent", { value: shown });
    };
    const volts = (value: number | null, hz: number | null) => {
        const v = rounded(value, 1);
        if (v === null) return null;
        const f = rounded(hz, 1);
        return f === null
            ? t("ups.units.volts", { value: v })
            : `${t("ups.units.volts", { value: v })} / ${t("ups.units.hertz", { value: f })}`;
    };
    const minutes = minutesLeft(reading?.runtimeS ?? null);
    const temperature = rounded(reading?.temperatureC ?? null, 1);
    const tiles: { key: string; label: string; value: string | null }[] = [
        { key: "charge", label: t("ups.metrics.charge"), value: percent(reading?.charge ?? null) },
        {
            key: "runtime",
            label: t("ups.metrics.runtime"),
            value: minutes === null ? null : t("ups.units.minutes", { count: minutes })
        },
        { key: "load", label: t("ups.metrics.load"), value: percent(reading?.load ?? null) },
        {
            key: "input",
            label: t("ups.metrics.input"),
            value: volts(reading?.inputV ?? null, reading?.inputHz ?? null)
        },
        {
            key: "output",
            label: t("ups.metrics.output"),
            value: volts(reading?.outputV ?? null, reading?.outputHz ?? null)
        },
        {
            key: "battery",
            label: t("ups.metrics.battery"),
            value: volts(reading?.batteryV ?? null, null)
        },
        {
            key: "temperature",
            label: t("ups.metrics.temperature"),
            value: temperature === null ? null : t("ups.units.celsius", { value: temperature })
        },
        { key: "model", label: t("ups.metrics.model"), value: reading?.model ?? null },
        { key: "manufacturer", label: t("ups.metrics.manufacturer"), value: reading?.manufacturer ?? null },
        { key: "serial", label: t("ups.metrics.serial"), value: reading?.serial ?? null }
    ];
    return (
        <dl className="grid grid-cols-[repeat(auto-fill,minmax(9rem,1fr))] gap-3">
            {tiles
                // A loaded reading leaves out what this UPS does not report.
                .filter((tile) => reading === null || tile.value !== null)
                .map((tile) => (
                    <div key={tile.key} className="min-w-0 rounded-md bg-muted/50 px-3 py-2">
                        <dt className="text-xs text-muted-foreground">{tile.label}</dt>
                        <dd className="truncate text-sm font-medium tabular-nums" title={tile.value ?? undefined}>
                            {reading === null ? <Skeleton className="mt-1 h-4 w-14" /> : tile.value}
                        </dd>
                    </div>
                ))}
        </dl>
    );
}

function UpsHistory({ answer, hours }: { answer: UpsDetailAnswer | null; hours: number }) {
    const t = useTranslations("servers");
    const charts = useMemo(() => {
        if (!answer) return null;
        const points = answer.history.map((point) => ({ ...point, t: Date.parse(point.ts) }));
        return {
            percent: [
                {
                    key: "charge",
                    label: t("ups.metrics.charge"),
                    points: points.map((point) => ({ t: point.t, v: point.charge }))
                },
                {
                    key: "load",
                    label: t("ups.metrics.load"),
                    points: points.map((point) => ({ t: point.t, v: point.load }))
                }
            ],
            voltage: [
                {
                    key: "input",
                    label: t("ups.metrics.input"),
                    points: points.map((point) => ({ t: point.t, v: point.inputV }))
                }
            ],
            empty: points.length === 0
        };
    }, [answer, t]);
    if (!charts) return <Skeleton className="h-48 w-full" />;
    if (charts.empty) return <p className="text-sm text-muted-foreground">{t("ups.chart.empty")}</p>;
    const to = Date.now();
    const from = to - hours * 3_600_000;
    return (
        <div className="grid gap-4 lg:grid-cols-2">
            <MultiSeriesChart
                label={t("ups.chart.percent")}
                series={charts.percent}
                from={from}
                to={to}
                max={100}
                format={(value) => t("ups.units.percent", { value: Math.round(value) })}
            />
            <MultiSeriesChart
                label={t("ups.chart.voltage")}
                series={charts.voltage}
                from={from}
                to={to}
                format={(value) => t("ups.units.volts", { value: Math.round(value) })}
            />
        </div>
    );
}

function UpsControls({ id, reading }: { id: string; reading: upsReading.UpsReading | null }) {
    const t = useTranslations("servers");
    const toast = useToast();
    const [busy, setBusy] = useState<upsReading.UpsCommand | null>(null);
    const commands = new Set(reading?.commands ?? []);

    async function run(command: upsReading.UpsCommand) {
        setBusy(command);
        const outcome = await runUpsCommandAction(id, command);
        setBusy(null);
        toast.show({
            key: `ups:${id}:command`,
            title: outcome.ok
                ? t(`ups.commandResult.${outcome.value}`)
                : t(`ups.errors.${outcome.error === "notFound" ? "notFound" : "failed"}`)
        });
    }

    const button = (command: upsReading.UpsCommand, label: string) =>
        commands.has(command) ? (
            <Button
                key={command}
                size="sm"
                variant="outline"
                disabled={busy !== null}
                onClick={() => void run(command)}
            >
                {label}
            </Button>
        ) : null;

    const beeper = reading?.beeper?.toLowerCase();
    const outcome = upsReading.testOutcome(reading?.testResult ?? null);
    const hasBeeper = ["beeper.enable", "beeper.disable", "beeper.mute"].some((one) =>
        commands.has(one as upsReading.UpsCommand)
    );
    const hasTest = ["test.battery.start.quick", "test.battery.start.deep"].some((one) =>
        commands.has(one as upsReading.UpsCommand)
    );

    return (
        <div className="flex flex-col gap-4">
            {!hasBeeper && !hasTest ? (
                <p className="text-sm text-muted-foreground">{t("ups.noCommands")}</p>
            ) : null}
            {hasBeeper ? (
                <div className="flex flex-wrap items-center gap-2">
                    <span className="text-sm">{t("ups.beeper.label")}</span>
                    {beeper === "enabled" || beeper === "disabled" || beeper === "muted" ? (
                        <Badge>{t(`ups.beeper.state.${beeper}`)}</Badge>
                    ) : null}
                    {button("beeper.enable", t("ups.beeper.enable"))}
                    {button("beeper.disable", t("ups.beeper.disable"))}
                    {button("beeper.mute", t("ups.beeper.mute"))}
                </div>
            ) : null}
            {hasTest ? (
                <div className="flex flex-wrap items-center gap-2">
                    <span className="text-sm">{t("ups.test.label")}</span>
                    {button("test.battery.start.quick", t("ups.test.quick"))}
                    {button("test.battery.start.deep", t("ups.test.deep"))}
                    {button("test.battery.stop", t("ups.test.stop"))}
                    <span className="flex min-w-0 items-center gap-2 text-sm text-muted-foreground">
                        {t("ups.test.result")}:
                        {reading?.testResult ? (
                            <>
                                {outcome ? (
                                    <Badge
                                        variant={
                                            outcome === "passed" ? "success" : outcome === "failed" ? "danger" : "neutral"
                                        }
                                    >
                                        {t(`ups.test.outcome.${outcome}`)}
                                    </Badge>
                                ) : null}
                                <span className="truncate" title={reading.testResult}>
                                    {reading.testResult}
                                </span>
                            </>
                        ) : (
                            <span>{t("ups.test.none")}</span>
                        )}
                    </span>
                </div>
            ) : null}
        </div>
    );
}

function UpsShutdown({
    ups,
    machines,
    sentAt
}: {
    ups: UpsView;
    machines: UpsMachine[];
    sentAt: string | null;
}) {
    const t = useTranslations("servers");
    const [saved, setSaved] = useState(ups.shutdown);
    const [draft, setDraft] = useState(ups.shutdown);
    const [charge, setCharge] = useState(saved.belowCharge === null ? "" : String(saved.belowCharge));
    const [runtime, setRuntime] = useState(saved.belowRuntimeMin === null ? "" : String(saved.belowRuntimeMin));
    const [confirming, setConfirming] = useState(false);
    const [pending, setPending] = useState(false);
    const [error, setError] = useState<string | null>(null);
    const [done, setDone] = useState(false);

    const candidate = {
        ...draft,
        belowCharge: charge.trim() === "" ? null : Number(charge),
        belowRuntimeMin: runtime.trim() === "" ? null : Number(runtime)
    };
    const parsed = upsReading.upsShutdownSchema.safeParse(candidate);
    const dirty = JSON.stringify(candidate) !== JSON.stringify(saved);

    async function save() {
        if (!parsed.success) return;
        setPending(true);
        setError(null);
        const outcome = await updateUpsShutdownAction(ups.id, parsed.data);
        setPending(false);
        if (!outcome.ok) {
            setError(outcome.error);
            return;
        }
        setSaved(parsed.data);
        setDone(true);
    }

    function toggleMachine(id: string, on: boolean) {
        setDone(false);
        setDraft((current) => ({
            ...current,
            protectedMachineIds: on
                ? [...current.protectedMachineIds, id]
                : current.protectedMachineIds.filter((one) => one !== id)
        }));
    }

    const errorText = (() => {
        if (error) {
            const known = ["unknownMachine", "notFound", "shutdownIncomplete"];
            return t(`ups.errors.${(known.includes(error) ? error : "failed") as "failed"}`);
        }
        return draft.enabled && !parsed.success ? t("ups.shutdown.incomplete") : null;
    })();

    return (
        <div className="flex flex-col gap-3">
            <p className="text-sm text-muted-foreground">{t("ups.shutdown.intro")}</p>
            <label className="flex items-center gap-2 text-sm">
                <Switch
                    checked={draft.enabled}
                    aria-label={t("ups.shutdown.enabled")}
                    onChange={(on) => {
                        setDone(false);
                        if (on) setConfirming(true);
                        else setDraft((current) => ({ ...current, enabled: false }));
                    }}
                />
                {t("ups.shutdown.enabled")}
            </label>
            {sentAt ? <p className="text-sm text-warning-ink">{t("ups.shutdown.sent")}</p> : null}
            <div className="grid max-w-md grid-cols-2 gap-2">
                <label className="flex min-w-0 flex-col gap-1 text-sm">
                    {t("ups.shutdown.belowCharge")}
                    <Input
                        inputMode="numeric"
                        value={charge}
                        placeholder="20"
                        onChange={(event) => {
                            setDone(false);
                            setCharge(event.target.value);
                        }}
                    />
                </label>
                <label className="flex min-w-0 flex-col gap-1 text-sm">
                    {t("ups.shutdown.belowRuntime")}
                    <Input
                        inputMode="numeric"
                        value={runtime}
                        placeholder="5"
                        onChange={(event) => {
                            setDone(false);
                            setRuntime(event.target.value);
                        }}
                    />
                </label>
            </div>
            <fieldset className="flex flex-col gap-1.5">
                <legend className="mb-1 text-sm">{t("ups.shutdown.machines")}</legend>
                {machines.length === 0 ? (
                    <p className="text-sm text-muted-foreground">{t("ups.shutdown.noMachines")}</p>
                ) : (
                    machines.map((machine) => (
                        <label key={machine.id} className="flex min-w-0 items-center gap-2 text-sm">
                            <Checkbox
                                checked={draft.protectedMachineIds.includes(machine.id)}
                                onChange={(event) => toggleMachine(machine.id, event.target.checked)}
                            />
                            <span className="truncate" title={machine.name}>
                                {machine.name}
                            </span>
                        </label>
                    ))
                )}
            </fieldset>
            {errorText ? (
                <p role="alert" className="text-sm text-danger-ink">
                    {errorText}
                </p>
            ) : null}
            <div className="flex items-center gap-2">
                <Button
                    aria-disabled={!dirty || !parsed.success || pending}
                    disabled={pending}
                    onClick={() => {
                        if (dirty && parsed.success) void save();
                    }}
                >
                    {t("ups.shutdown.save")}
                </Button>
                {done && !dirty ? <span className="text-sm text-muted-foreground">{t("ups.shutdown.saved")}</span> : null}
            </div>

            <Dialog open={confirming} onOpenChange={setConfirming}>
                <DialogContent>
                    <DialogHeader>
                        <DialogTitle>{t("ups.shutdown.confirm.title")}</DialogTitle>
                        <DialogDescription>
                            {t("ups.shutdown.confirm.body", {
                                count: Math.max(1, draft.protectedMachineIds.length)
                            })}
                        </DialogDescription>
                    </DialogHeader>
                    <DialogFooter>
                        <Button variant="ghost" onClick={() => setConfirming(false)}>
                            {t("ups.form.cancel")}
                        </Button>
                        <Button
                            variant="danger"
                            onClick={() => {
                                setDraft((current) => ({ ...current, enabled: true }));
                                setConfirming(false);
                            }}
                        >
                            {t("ups.shutdown.confirm.action")}
                        </Button>
                    </DialogFooter>
                </DialogContent>
            </Dialog>
        </div>
    );
}
