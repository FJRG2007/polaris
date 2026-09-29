"use client";

/**
 * The Watch UI: the owner's alarms with live state, a recent-events log, and a
 * create dialog. Metric choices follow the target kind (apps and servers watch
 * CPU, memory, disk and network, apps also service liveness; domains watch
 * reachability - see `alarm-metrics`). Mutations go through the
 * deploy.manage-gated actions; the shared schema validates the form.
 */

import Link from "next/link";
import { useRouter } from "next/navigation";
import { useMemo, useState, useTransition } from "react";
import { alarmInputSchema } from "@/lib/watch/watch-schema";
import { useDisplayFormat } from "@/components/display-format";
import { useTranslations } from "@/components/i18n/i18n-provider";
import { alarmStateWord, metricWord, thresholdWords, watchText } from "@/lib/watch/words";
import { Activity, Bell, BellOff, Loader2, Plus, Trash2 } from "lucide-react";
import type { AlarmEventView, AlarmTargets, AlarmView } from "@/lib/watch-service";
import { createAlarmAction, deleteAlarmAction, setAlarmEnabledAction } from "./actions";
import {
    ALARM_TARGET_TYPES,
    alarmUnit,
    defaultThreshold,
    metricsFor,
    type AlarmMetric,
    type AlarmTargetType
} from "@/lib/watch/alarm-metrics";
import {
    Badge,
    Button,
    Card,
    CardBody,
    Dialog,
    DialogContent,
    DialogDescription,
    DialogHeader,
    DialogTitle,
    Input,
    PageHeader,
    Select,
    Switch,
    cn
} from "@polaris/ui";

function stateTone(state: string): string | undefined {
    if (state === "alarm") return "border-danger-edge text-danger";
    if (state === "ok") return "border-success-edge text-success";
    return undefined;
}

export function WatchView({
    initialAlarms,
    initialEvents,
    targets,
    routes
}: {
    initialAlarms: AlarmView[];
    initialEvents: AlarmEventView[];
    targets: AlarmTargets;
    /** Where a firing alarm is currently sent, by the account's rules. */
    routes: string[];
}) {
    const router = useRouter();
    const format = useDisplayFormat();
    const t = useTranslations("watch");
    const [creating, setCreating] = useState(false);

    const targetName = useMemo(() => {
        const map = new Map<string, string>();
        for (const app of targets.apps) map.set(app.id, app.name);
        for (const host of targets.hosts) map.set(host.id, host.name);
        for (const domain of targets.domains) map.set(domain.id, domain.hostname);
        return map;
    }, [targets]);

    function describe(alarm: AlarmView): string {
        if (alarmUnit(alarm.metric, alarm.targetType)) {
            return t("alarms.thresholdFor", {
                threshold: thresholdWords(t, { ...alarm, threshold: alarm.threshold ?? 0 }),
                count: alarm.forPeriods
            });
        }
        return alarm.targetType === "domain" ? t("alarms.domainReachability") : t("alarms.serviceLiveness");
    }

    return (
        <div className="flex flex-col gap-6">
            <PageHeader
                title={t("overview.title")}
                description={t("alarms.description")}
                actions={
                    <Button size="sm" onClick={() => setCreating(true)}>
                        <Plus className="size-4" /> {t("alarms.new")}
                    </Button>
                }
            />

            <p className="flex flex-wrap items-center gap-1.5 text-sm text-muted-foreground">
                {routes.length === 0 ? (
                    <>
                        <BellOff className="size-4 shrink-0 text-warning" />
                        {t("alarms.sentNowhere")}
                    </>
                ) : (
                    <>
                        <Bell className="size-4 shrink-0" />
                        {t("alarms.sentTo", { routes: routes.join(", ") })}
                    </>
                )}
                <Link href="/account/notifications" className="text-primary hover:underline">
                    {t("alarms.change")}
                </Link>
            </p>

            <section className="flex flex-col gap-3">
                <h2 className="text-sm font-medium text-muted-foreground">{t("overview.alarms")}</h2>
                {initialAlarms.length === 0 ? (
                    <p className="text-sm text-muted-foreground">{t("alarms.none")}</p>
                ) : (
                    <div className="grid grid-cols-1 gap-2 lg:grid-cols-2">
                        {initialAlarms.map((alarm) => (
                            <Card key={alarm.id}>
                                <CardBody className="flex items-center justify-between gap-3 py-3">
                                    <div className="flex items-center gap-2">
                                        <Activity className="size-4 text-muted-foreground" />
                                        <div className="min-w-0">
                                            <p className="truncate text-sm font-medium">{alarm.name}</p>
                                            <p className="truncate text-xs text-muted-foreground">
                                                {t("alarms.line", {
                                                    target: targetName.get(alarm.targetId) ?? t("alarms.unknownTarget"),
                                                    summary: describe(alarm)
                                                })}
                                            </p>
                                        </div>
                                    </div>
                                    <div className="flex items-center gap-2">
                                        <Badge className={cn(stateTone(alarm.state))}>
                                            {alarmStateWord(t, alarm.state)}
                                        </Badge>
                                        <Switch
                                            checked={alarm.enabled}
                                            onChange={(next) =>
                                                void setAlarmEnabledAction(alarm.id, next).then(() => router.refresh())
                                            }
                                            aria-label={alarm.enabled ? t("alarms.disable") : t("alarms.enable")}
                                        />
                                        <button
                                            type="button"
                                            aria-label={t("alarms.delete")}
                                            className="text-muted-foreground hover:text-danger"
                                            onClick={() =>
                                                void deleteAlarmAction(alarm.id).then(() => router.refresh())
                                            }
                                        >
                                            <Trash2 className="size-4" />
                                        </button>
                                    </div>
                                </CardBody>
                            </Card>
                        ))}
                    </div>
                )}
            </section>

            <section className="flex flex-col gap-3">
                <h2 className="text-sm font-medium text-muted-foreground">{t("alarms.recent")}</h2>
                {initialEvents.length === 0 ? (
                    <p className="text-sm text-muted-foreground">{t("alarms.noEvents")}</p>
                ) : (
                    <div className="flex flex-col gap-1">
                        {initialEvents.map((event) => (
                            <div key={event.id} className="flex items-center gap-2 text-sm">
                                <Badge className={cn(event.kind === "triggered" ? "border-danger-edge text-danger" : "border-success-edge text-success")}>
                                    {event.kind === "triggered" ? t("alarms.fired") : t("alarms.cleared")}
                                </Badge>
                                <span className="font-medium">{event.alarmName}</span>
                                <span className="truncate text-muted-foreground">
                                    {event.detail ? watchText(t, event.detail) : null}
                                </span>
                                <span className="ml-auto shrink-0 text-xs text-muted-foreground">
                                    {format.dateTime(event.createdAt)}
                                </span>
                            </div>
                        ))}
                    </div>
                )}
            </section>

            {creating && (
                <CreateAlarmDialog targets={targets} onClose={() => setCreating(false)} onCreated={() => { setCreating(false); router.refresh(); }} />
            )}
        </div>
    );
}

function CreateAlarmDialog({
    targets,
    onClose,
    onCreated
}: {
    targets: AlarmTargets;
    onClose: () => void;
    onCreated: () => void;
}) {
    const t = useTranslations("watch");
    const tcommon = useTranslations("common");
    const [pending, startTransition] = useTransition();
    const [name, setName] = useState("");
    const [targetType, setTargetType] = useState<AlarmTargetType>("application");
    const [targetId, setTargetId] = useState("");
    const [metric, setMetric] = useState<AlarmMetric>("cpu");
    const [operator, setOperator] = useState<"gt" | "lt">("gt");
    const [threshold, setThreshold] = useState("80");
    const [forPeriods, setForPeriods] = useState("2");
    const [error, setError] = useState<string | null>(null);

    const options =
        targetType === "application"
            ? targets.apps.map((a) => ({ value: a.id, label: a.name }))
            : targetType === "host"
              ? targets.hosts.map((h) => ({ value: h.id, label: h.name }))
              : targets.domains.map((d) => ({ value: d.id, label: d.hostname }));
    const chosenHost = targetType === "host" ? targets.hosts.find((host) => host.id === targetId) : undefined;
    const metricOptions = metricsFor(targetType)
        // A server reached over SSH has no disk reading to judge.
        .filter((entry) => entry !== "disk" || targetType !== "host" || !chosenHost || chosenHost.measuresDisk)
        .map((entry) => ({ value: entry, label: metricWord(t, entry) }));
    const unit = alarmUnit(metric, targetType);

    function chooseMetric(next: AlarmMetric, type: AlarmTargetType = targetType): void {
        setMetric(next);
        setThreshold(String(defaultThreshold(next, type)));
    }

    function submit() {
        setError(null);
        const input = {
            name: name.trim(),
            targetType,
            targetId,
            metric,
            operator,
            threshold: unit ? Number(threshold) : undefined,
            forPeriods: Number(forPeriods)
        };
        const parsed = alarmInputSchema.safeParse(input);
        if (!parsed.success) {
            const message = parsed.error.issues[0]?.message;
            setError(message ? watchText(t, message) : t("alarms.checkForm"));
            return;
        }
        startTransition(async () => {
            const result = await createAlarmAction(parsed.data);
            if (result.error) {
                setError(result.error);
                return;
            }
            onCreated();
        });
    }

    return (
        <Dialog open onOpenChange={(open) => !open && onClose()}>
            <DialogContent>
                <DialogHeader>
                    <DialogTitle>{t("alarms.new")}</DialogTitle>
                    <DialogDescription>{t("alarms.newDescription")}</DialogDescription>
                </DialogHeader>
                <div className="flex flex-col gap-3">
                    <label className="flex flex-col gap-1 text-sm">
                        <span className="font-medium">{t("alarms.name")}</span>
                        <Input
                            value={name}
                            onChange={(event) => setName(event.target.value)}
                            placeholder={t("alarms.namePlaceholder")}
                        />
                    </label>
                    <label className="flex flex-col gap-1 text-sm">
                        <span className="font-medium">{t("alarms.target")}</span>
                        <Select
                            value={targetType}
                            onValueChange={(value) => {
                                const next = value as AlarmTargetType;
                                setTargetType(next);
                                setTargetId("");
                                chooseMetric(metricsFor(next)[0] ?? "cpu", next);
                            }}
                            options={ALARM_TARGET_TYPES.map((type) => ({ value: type, label: t(`labels.target.${type}`) }))}
                        />
                    </label>
                    <label className="flex flex-col gap-1 text-sm">
                        <span className="font-medium">{t(`labels.target.${targetType}`)}</span>
                        <Select
                            value={targetId}
                            onValueChange={(value) => {
                                setTargetId(value);
                                // A disk alarm cannot stay on a server that has no disk reading.
                                const host = targetType === "host" ? targets.hosts.find((entry) => entry.id === value) : undefined;
                                if (metric === "disk" && host && !host.measuresDisk) chooseMetric("cpu");
                            }}
                            placeholder={t("alarms.chooseOne")}
                            options={options}
                        />
                    </label>
                    <label className="flex flex-col gap-1 text-sm">
                        <span className="font-medium">{t("alarms.metric")}</span>
                        <Select value={metric} onValueChange={(value) => chooseMetric(value as AlarmMetric)} options={metricOptions} />
                    </label>
                    {metric === "disk" && targetType === "application" && (
                        <p className="text-xs text-muted-foreground">{t("alarms.volumesHint")}</p>
                    )}
                    {unit && (
                        <div className="flex gap-2">
                            <label className="flex flex-1 flex-col gap-1 text-sm">
                                <span className="font-medium">{t("alarms.when")}</span>
                                <Select
                                    value={operator}
                                    onValueChange={(value) => setOperator(value as "gt" | "lt")}
                                    options={[
                                        { value: "gt", label: t("alarms.above") },
                                        { value: "lt", label: t("alarms.below") }
                                    ]}
                                />
                            </label>
                            <label className="flex flex-1 flex-col gap-1 text-sm">
                                <span className="font-medium">{t("alarms.threshold", { unit })}</span>
                                <Input
                                    type="number"
                                    min={0}
                                    max={unit === "%" ? 100 : undefined}
                                    step={unit === "%" ? 1 : 0.1}
                                    value={threshold}
                                    onChange={(event) => setThreshold(event.target.value)}
                                />
                            </label>
                        </div>
                    )}
                    <label className="flex flex-col gap-1 text-sm">
                        <span className="font-medium">{t("alarms.forChecks")}</span>
                        <Input type="number" value={forPeriods} onChange={(event) => setForPeriods(event.target.value)} />
                    </label>
                    {error && <p className="text-sm text-danger">{error}</p>}
                    <div className="flex justify-end gap-2">
                        <Button variant="ghost" onClick={onClose} disabled={pending}>
                            {tcommon("actions.cancel")}
                        </Button>
                        <Button onClick={submit} disabled={pending || !name.trim() || !targetId}>
                            {pending && <Loader2 className="size-4 animate-spin" />}
                            {t("alarms.create")}
                        </Button>
                    </div>
                </div>
            </DialogContent>
        </Dialog>
    );
}
