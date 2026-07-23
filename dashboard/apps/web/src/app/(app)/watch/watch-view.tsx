"use client";

/**
 * The Watch UI: the owner's alarms with live state, a recent-events log, and a
 * create dialog. Metric choices follow the target kind (apps watch CPU/memory or
 * service liveness; domains watch reachability). Mutations go through the
 * deploy.manage-gated actions; the shared schema validates the form.
 */

import { useMemo, useState, useTransition } from "react";
import { useRouter } from "next/navigation";
import { Activity, Loader2, Plus, Trash2 } from "lucide-react";
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
import { alarmInputSchema } from "@/lib/watch/watch-schema";
import { createAlarmAction, deleteAlarmAction, setAlarmEnabledAction } from "./actions";
import type { AlarmEventView, AlarmTargets, AlarmView } from "@/lib/watch-service";

const METRIC_LABEL: Record<string, string> = {
    cpu: "CPU %",
    memory: "Memory %",
    service: "Service up",
    http: "Reachable"
};

const STATE_LABEL: Record<string, string> = { ok: "OK", alarm: "Alarm", insufficient: "No data" };

function stateTone(state: string): string | undefined {
    if (state === "alarm") return "border-danger/40 text-danger";
    if (state === "ok") return "border-success/40 text-success";
    return undefined;
}

export function WatchView({
    initialAlarms,
    initialEvents,
    targets
}: {
    initialAlarms: AlarmView[];
    initialEvents: AlarmEventView[];
    targets: AlarmTargets;
}) {
    const router = useRouter();
    const [creating, setCreating] = useState(false);

    const targetName = useMemo(() => {
        const map = new Map<string, string>();
        for (const app of targets.apps) map.set(app.id, app.name);
        for (const domain of targets.domains) map.set(domain.id, domain.hostname);
        return map;
    }, [targets]);

    function describe(alarm: AlarmView): string {
        if (alarm.metric === "cpu" || alarm.metric === "memory") {
            return `${METRIC_LABEL[alarm.metric]} ${alarm.operator === "lt" ? "<" : ">"} ${alarm.threshold ?? 0}% for ${alarm.forPeriods}`;
        }
        return alarm.targetType === "domain" ? "Domain reachability" : "Service liveness";
    }

    return (
        <div className="flex flex-col gap-6">
            <PageHeader
                title="Watch"
                description="Alarms on your apps and domains - CPU/memory spikes, a service down, an unreachable domain."
                actions={
                    <Button size="sm" onClick={() => setCreating(true)}>
                        <Plus className="size-4" /> New alarm
                    </Button>
                }
            />

            <section className="flex flex-col gap-3">
                <h2 className="text-sm font-medium text-muted-foreground">Alarms</h2>
                {initialAlarms.length === 0 ? (
                    <p className="text-sm text-muted-foreground">No alarms yet. Create one to start watching.</p>
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
                                                {targetName.get(alarm.targetId) ?? "unknown"} - {describe(alarm)}
                                            </p>
                                        </div>
                                    </div>
                                    <div className="flex items-center gap-2">
                                        <Badge className={cn(stateTone(alarm.state))}>
                                            {STATE_LABEL[alarm.state] ?? alarm.state}
                                        </Badge>
                                        <Switch
                                            checked={alarm.enabled}
                                            onChange={(next) =>
                                                void setAlarmEnabledAction(alarm.id, next).then(() => router.refresh())
                                            }
                                            aria-label={alarm.enabled ? "Disable alarm" : "Enable alarm"}
                                        />
                                        <button
                                            type="button"
                                            aria-label="Delete alarm"
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
                <h2 className="text-sm font-medium text-muted-foreground">Recent events</h2>
                {initialEvents.length === 0 ? (
                    <p className="text-sm text-muted-foreground">No events yet.</p>
                ) : (
                    <div className="flex flex-col gap-1">
                        {initialEvents.map((event) => (
                            <div key={event.id} className="flex items-center gap-2 text-sm">
                                <Badge className={cn(event.kind === "triggered" ? "border-danger/40 text-danger" : "border-success/40 text-success")}>
                                    {event.kind === "triggered" ? "Fired" : "Cleared"}
                                </Badge>
                                <span className="font-medium">{event.alarmName}</span>
                                <span className="truncate text-muted-foreground">{event.detail}</span>
                                <span className="ml-auto shrink-0 text-xs text-muted-foreground">
                                    {new Date(event.createdAt).toLocaleString()}
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
    const [pending, startTransition] = useTransition();
    const [name, setName] = useState("");
    const [targetType, setTargetType] = useState<"application" | "domain">("application");
    const [targetId, setTargetId] = useState("");
    const [metric, setMetric] = useState("cpu");
    const [operator, setOperator] = useState<"gt" | "lt">("gt");
    const [threshold, setThreshold] = useState("80");
    const [forPeriods, setForPeriods] = useState("2");
    const [error, setError] = useState<string | null>(null);

    const options = targetType === "application" ? targets.apps.map((a) => ({ value: a.id, label: a.name })) : targets.domains.map((d) => ({ value: d.id, label: d.hostname }));
    const metricOptions =
        targetType === "application"
            ? [
                  { value: "cpu", label: "CPU %" },
                  { value: "memory", label: "Memory %" },
                  { value: "service", label: "Service up" }
              ]
            : [{ value: "http", label: "Reachable" }];
    const isThresholdMetric = metric === "cpu" || metric === "memory";

    function submit() {
        setError(null);
        const input = {
            name: name.trim(),
            targetType,
            targetId,
            metric: targetType === "domain" ? "http" : metric,
            operator,
            threshold: isThresholdMetric ? Number(threshold) : undefined,
            forPeriods: Number(forPeriods)
        };
        const parsed = alarmInputSchema.safeParse(input);
        if (!parsed.success) {
            setError(parsed.error.issues[0]?.message ?? "Check the form");
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
                    <DialogTitle>New alarm</DialogTitle>
                    <DialogDescription>Watch an app or domain and get notified when it breaches.</DialogDescription>
                </DialogHeader>
                <div className="flex flex-col gap-3">
                    <label className="flex flex-col gap-1 text-sm">
                        <span className="font-medium">Name</span>
                        <Input value={name} onChange={(event) => setName(event.target.value)} placeholder="API CPU high" />
                    </label>
                    <label className="flex flex-col gap-1 text-sm">
                        <span className="font-medium">Target</span>
                        <Select
                            value={targetType}
                            onValueChange={(value) => {
                                const next = value as "application" | "domain";
                                setTargetType(next);
                                setTargetId("");
                                setMetric(next === "domain" ? "http" : "cpu");
                            }}
                            options={[
                                { value: "application", label: "App" },
                                { value: "domain", label: "Domain" }
                            ]}
                        />
                    </label>
                    <label className="flex flex-col gap-1 text-sm">
                        <span className="font-medium">{targetType === "domain" ? "Domain" : "App"}</span>
                        <Select value={targetId} onValueChange={setTargetId} placeholder="Choose one" options={options} />
                    </label>
                    <label className="flex flex-col gap-1 text-sm">
                        <span className="font-medium">Metric</span>
                        <Select value={metric} onValueChange={setMetric} options={metricOptions} />
                    </label>
                    {isThresholdMetric && (
                        <div className="flex gap-2">
                            <label className="flex flex-1 flex-col gap-1 text-sm">
                                <span className="font-medium">When</span>
                                <Select
                                    value={operator}
                                    onValueChange={(value) => setOperator(value as "gt" | "lt")}
                                    options={[
                                        { value: "gt", label: "Above" },
                                        { value: "lt", label: "Below" }
                                    ]}
                                />
                            </label>
                            <label className="flex flex-1 flex-col gap-1 text-sm">
                                <span className="font-medium">Threshold %</span>
                                <Input
                                    type="number"
                                    value={threshold}
                                    onChange={(event) => setThreshold(event.target.value)}
                                />
                            </label>
                        </div>
                    )}
                    <label className="flex flex-col gap-1 text-sm">
                        <span className="font-medium">For consecutive checks</span>
                        <Input type="number" value={forPeriods} onChange={(event) => setForPeriods(event.target.value)} />
                    </label>
                    {error && <p className="text-sm text-danger">{error}</p>}
                    <div className="flex justify-end gap-2">
                        <Button variant="ghost" onClick={onClose} disabled={pending}>
                            Cancel
                        </Button>
                        <Button onClick={submit} disabled={pending || !name.trim() || !targetId}>
                            {pending && <Loader2 className="size-4 animate-spin" />}
                            Create
                        </Button>
                    </div>
                </div>
            </DialogContent>
        </Dialog>
    );
}
