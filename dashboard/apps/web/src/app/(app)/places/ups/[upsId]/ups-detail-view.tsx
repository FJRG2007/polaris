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
import { usePathname, useRouter, useSearchParams } from "next/navigation";
import { ArrowLeft, Pencil, Share2, Trash2 } from "lucide-react";
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
    Select,
    Skeleton,
    Switch,
    useToast
} from "@polaris/ui";
import * as upsReading from "@/lib/ups/ups-reading";
import type { UpsView } from "@/lib/ups/ups-service";
import { UpsConnectionDialog } from "../ups-connection-dialog";
import { UpsEnergyPanel } from "./ups-energy-panel";
import { UpsEventsPanel } from "./ups-events-panel";
import { UpsBatteryPanel } from "./ups-battery-panel";
import { UpsCommandsPanel } from "./ups-commands-panel";
import { UpsSettingsPanel } from "./ups-settings-panel";
import { UpsVariablesPanel } from "./ups-variables-panel";
import { ShareDialog } from "@/components/access/share-dialog";
import {
    fencedCall,
    upsErrorKey,
    UpsStandingContext,
    type UpsReaderStanding
} from "./ups-standing";
import * as upsSettings from "@/lib/ups/ups-settings";
import { useLiveResource } from "@/components/use-live-resource";
import { useTranslations } from "@/components/i18n/i18n-provider";
import {
    removeUpsAction,
    runUpsCommandAction,
    setUpsPlaceAction,
    updateUpsShutdownAction
} from "../actions";
import {
    minutesLeft,
    rounded,
    upsStatus,
    type UpsDetailAnswer,
    type UpsMachine
} from "../ups-words";

const POLL_MS = 10_000;
const RANGES = { h6: 6, h24: 24, d7: 168, d30: 720 } as const;
type RangeKey = keyof typeof RANGES;
const TABS = [
    "overview",
    "energy",
    "power",
    "battery",
    "events",
    "commands",
    "variables",
    "settings"
] as const;
type Tab = (typeof TABS)[number];

export function UpsDetailView({
    initial,
    machines,
    canOfferNetwork,
    places,
    standing = { manage: true, control: true }
}: {
    initial: UpsView;
    machines: UpsMachine[];
    canOfferNetwork: boolean;
    places: { id: string; name: string }[];
    /** What the reader may do: an administrator runs it, a visitor was lent it
     *  to watch or to control. Everything else is not drawn for them. */
    standing?: UpsReaderStanding;
}) {
    const t = useTranslations("servers");
    const router = useRouter();
    const pathname = usePathname();
    const search = useSearchParams();
    const asked = search.get("tab");
    // A visitor sees the tabs they were lent: no settings unless they run it,
    // no commands or variables unless they may drive it.
    const tabs = TABS.filter(
        (key) =>
            (key !== "settings" || standing.manage) &&
            ((key !== "commands" && key !== "variables") || standing.control)
    );
    const tab: Tab = (tabs as readonly string[]).includes(asked ?? "")
        ? (asked as Tab)
        : "overview";
    const [sharing, setSharing] = useState(false);
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
    const toast = useToast();
    // Optimistic: the picker shows the new place at once and goes back to the
    // old one if the server refuses it.
    const [placeId, setPlaceId] = useState<string | null>(initial.placeId);
    async function movePlace(next: string | null) {
        const before = placeId;
        if (next === before) return;
        setPlaceId(next);
        const outcome = await setUpsPlaceAction(ups.id, next);
        if (!outcome.ok) {
            setPlaceId(before);
            toast.show({ key: `ups:${ups.id}:place`, title: t("ups.place.failed") });
        }
    }
    const result = live.data?.result ?? null;
    const reading = result?.ok ? result.reading : null;

    async function remove() {
        const outcome = await removeUpsAction(ups.id);
        if (!outcome.ok) {
            setRemoveError(t(`ups.errors.${outcome.error === "notFound" ? "notFound" : "failed"}`));
            return;
        }
        router.push("/places/ups");
    }

    function openTab(next: Tab) {
        const params = new URLSearchParams(search.toString());
        if (next === "overview") params.delete("tab");
        else params.set("tab", next);
        const query = params.toString();
        router.replace(query ? `${pathname}?${query}` : pathname, { scroll: false });
    }

    const rangePicker = (
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
    );

    return (
        <UpsStandingContext.Provider value={standing}>
            <Link
                href="/places/ups"
                className="mb-3 inline-flex items-center gap-1 text-sm text-muted-foreground hover:text-foreground"
            >
                <ArrowLeft className="size-4 shrink-0" aria-hidden />
                {t("ups.back")}
            </Link>
            <PageHeader
                title={ups.name}
                description={t(`ups.connection.${ups.connection}`)}
                actions={
                    standing.manage ? (
                        <div className="flex flex-wrap gap-2">
                            {places.length > 0 ? (
                                <Select
                                    aria-label={t("ups.place.label")}
                                    className="w-48"
                                    value={placeId ?? ""}
                                    onValueChange={(value) => void movePlace(value || null)}
                                    options={[
                                        { value: "", label: t("ups.place.none") },
                                        ...places.map((place) => ({
                                            value: place.id,
                                            label: place.name
                                        }))
                                    ]}
                                />
                            ) : null}
                            <Button variant="outline" onClick={() => setEditing(true)}>
                                <Pencil className="size-4 shrink-0" aria-hidden />
                                {t("ups.edit")}
                            </Button>
                            <Button variant="outline" onClick={() => setSharing(true)}>
                                <Share2 className="size-4 shrink-0" aria-hidden />
                                {t("ups.share")}
                            </Button>
                            <Button variant="outline" onClick={() => setRemoving(true)}>
                                <Trash2 className="size-4 shrink-0" aria-hidden />
                                {t("ups.remove")}
                            </Button>
                        </div>
                    ) : null
                }
            />

            <div className="mb-4 overflow-x-auto">
                <SegmentedControl<Tab>
                    size="sm"
                    aria-label={t("ups.tabs.label")}
                    value={tab}
                    onValueChange={openTab}
                    options={tabs.map((key) => ({ value: key, label: t(`ups.tabs.${key}`) }))}
                />
            </div>

            {tab === "overview" ? (
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
                            <UpsNow reading={reading} overrideW={ups.settings.nominalPowerW} />
                        )}
                    </section>

                    {standing.control ? (
                        <section aria-labelledby="ups-controls" className="flex flex-col gap-3">
                            <h2 id="ups-controls" className="text-sm font-medium">
                                {t("ups.regions.controls")}
                            </h2>
                            {result === null ? (
                                <Skeleton className="h-16 w-full" />
                            ) : (
                                <UpsControls id={ups.id} reading={reading} />
                            )}
                        </section>
                    ) : null}

                    {standing.manage ? (
                        <section aria-labelledby="ups-shutdown" className="flex flex-col gap-3">
                            <h2 id="ups-shutdown" className="text-sm font-medium">
                                {t("ups.regions.shutdown")}
                            </h2>
                            <UpsShutdown
                                ups={initial}
                                machines={machines}
                                sentAt={ups.shutdownSentAt}
                            />
                        </section>
                    ) : null}
                </div>
            ) : null}

            {tab === "power" ? (
                <section aria-labelledby="ups-history" className="flex flex-col gap-3">
                    <div className="flex flex-wrap items-center justify-between gap-2">
                        <h2 id="ups-history" className="text-sm font-medium">
                            {t("ups.regions.history")}
                        </h2>
                        {rangePicker}
                    </div>
                    <UpsHistory answer={live.data} hours={RANGES[range]} />
                </section>
            ) : null}
            {tab === "energy" ? <UpsEnergyPanel ups={ups} reading={reading} /> : null}
            {tab === "battery" ? (
                <div className="flex flex-col gap-3">
                    <div className="flex justify-end">{rangePicker}</div>
                    <UpsBatteryPanel upsId={ups.id} answer={live.data} hours={RANGES[range]} />
                </div>
            ) : null}
            {tab === "events" ? <UpsEventsPanel upsId={ups.id} /> : null}
            {tab === "commands" ? (
                <UpsCommandsPanel
                    upsId={ups.id}
                    commands={result === null ? null : (reading?.commands ?? [])}
                />
            ) : null}
            {tab === "variables" ? (
                <UpsVariablesPanel
                    ups={ups}
                    vars={result === null ? null : result.ok ? result.vars : {}}
                    rw={result === null ? null : result.ok ? result.rw : []}
                    onChanged={() => {
                        live.refresh();
                        router.refresh();
                    }}
                />
            ) : null}
            {tab === "settings" ? (
                <UpsSettingsPanel ups={initial} canOfferNetwork={canOfferNetwork} />
            ) : null}

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
            {standing.manage ? (
                <ShareDialog
                    open={sharing}
                    onOpenChange={setSharing}
                    subject="place.ups"
                    subjectId={ups.id}
                    name={ups.name}
                    // Watching a UPS through an outage, or running its test,
                    // is as much a thing for an afternoon as a door is.
                    bounded
                />
            ) : null}
        </UpsStandingContext.Provider>
    );
}

function UpsNow({
    reading,
    overrideW
}: {
    reading: upsReading.UpsReading | null;
    overrideW: number | null;
}) {
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
        {
            key: "power",
            label: t("ups.metrics.power"),
            value: (() => {
                const watts = reading
                    ? upsSettings.powerWatts({
                          realPowerW: reading.realPowerW,
                          load: reading.load,
                          nominalPowerW: reading.nominalPowerW,
                          overrideW: overrideW
                      })
                    : null;
                return watts === null ? null : t("ups.units.watts", { value: Math.round(watts) });
            })()
        },
        {
            key: "transfer",
            label: t("ups.metrics.transfer"),
            value:
                reading?.transferLowV == null || reading.transferHighV == null
                    ? null
                    : `${t("ups.units.volts", { value: reading.transferLowV })} - ${t("ups.units.volts", { value: reading.transferHighV })}`
        },
        { key: "model", label: t("ups.metrics.model"), value: reading?.model ?? null },
        { key: "firmware", label: t("ups.metrics.firmware"), value: reading?.firmware ?? null },
        {
            key: "manufacturer",
            label: t("ups.metrics.manufacturer"),
            value: reading?.manufacturer ?? null
        },
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
                        <dd
                            className="truncate text-sm font-medium tabular-nums"
                            title={tile.value ?? undefined}
                        >
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
                },
                {
                    key: "output",
                    label: t("ups.metrics.output"),
                    points: points.map((point) => ({ t: point.t, v: point.outputV }))
                }
            ],
            power: [
                {
                    key: "power",
                    label: t("ups.metrics.power"),
                    points: points.map((point) => ({ t: point.t, v: point.powerW }))
                }
            ],
            frequency: [
                {
                    key: "hz",
                    label: t("ups.metrics.frequency"),
                    points: points.map((point) => ({ t: point.t, v: point.inputHz }))
                }
            ],
            battery: [
                {
                    key: "battery",
                    label: t("ups.metrics.battery"),
                    points: points.map((point) => ({ t: point.t, v: point.batteryV }))
                }
            ],
            empty: points.length === 0
        };
    }, [answer, t]);
    if (!charts) return <Skeleton className="h-48 w-full" />;
    if (charts.empty)
        return <p className="text-sm text-muted-foreground">{t("ups.chart.empty")}</p>;
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
            <MultiSeriesChart
                label={t("ups.chart.power")}
                series={charts.power}
                from={from}
                to={to}
                format={(value) => t("ups.units.watts", { value: Math.round(value) })}
            />
            <MultiSeriesChart
                label={t("ups.chart.frequency")}
                series={charts.frequency}
                from={from}
                to={to}
                format={(value) => t("ups.units.hertz", { value: value.toFixed(1) })}
            />
            <MultiSeriesChart
                label={t("ups.chart.batteryVoltage")}
                series={charts.battery}
                from={from}
                to={to}
                format={(value) => t("ups.units.volts", { value: value.toFixed(1) })}
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
        const outcome = await fencedCall((where) => runUpsCommandAction(id, command, where));
        setBusy(null);
        toast.show({
            key: `ups:${id}:command`,
            title: outcome.ok
                ? t(`ups.commandResult.${outcome.value}`)
                : t(`ups.errors.${upsErrorKey(outcome.error)}`)
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
                <p className="text-sm text-muted-foreground">{t("ups.test.moved")}</p>
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
    const [charge, setCharge] = useState(
        saved.belowCharge === null ? "" : String(saved.belowCharge)
    );
    const [runtime, setRuntime] = useState(
        saved.belowRuntimeMin === null ? "" : String(saved.belowRuntimeMin)
    );
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
                                onChange={(event) =>
                                    toggleMachine(machine.id, event.target.checked)
                                }
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
                {done && !dirty ? (
                    <span className="text-sm text-muted-foreground">{t("ups.shutdown.saved")}</span>
                ) : null}
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
