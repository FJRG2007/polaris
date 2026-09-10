"use client";

/**
 * A service's copies, what each may use, and how traffic is spread over them.
 *
 * A count or a limit applies as soon as it is saved: the running release is started again
 * from its kept image, so nothing is rebuilt and the copies already running stay
 * up. The form checks every field against the same schema the server does, as it
 * is typed.
 */

import * as core from "@polaris/core";
import { Loader2 } from "lucide-react";
import { Button, Input, Switch } from "@polaris/ui";
import { describeServiceEvent } from "./service-history";
import { RelativeTime } from "@/components/relative-time";
import { useEffect, useMemo, useState, useTransition } from "react";
import type { ServiceScalingView } from "@/lib/deploy/scaling-service";
import { saveServiceScalingAction, serviceScalingAction } from "./scaling-actions";

interface Draft {
    replicas: string;
    autoscale: boolean;
    min: string;
    max: string;
    cpuPercent: string;
    /** Blank is no traffic target: scaled on CPU alone. */
    requestsPerCopy: string;
    sticky: boolean;
    healthPath: string;
    cpus: string;
    memoryMb: string;
    sleeps: boolean;
    sleepAfter: string;
}

function draftOf(view: ServiceScalingView): Draft {
    return {
        replicas: String(view.replicas),
        autoscale: view.autoscale !== null,
        min: String(view.autoscale?.min ?? 1),
        max: String(view.autoscale?.max ?? Math.max(2, view.replicas)),
        cpuPercent: String(view.autoscale?.cpuPercent ?? 50),
        requestsPerCopy: view.autoscale?.requestsPerCopy
            ? String(view.autoscale.requestsPerCopy)
            : "",
        sticky: view.balancing.sticky,
        healthPath: view.balancing.healthPath ?? "",
        cpus: view.limits.cpus === null ? "" : String(view.limits.cpus),
        memoryMb: view.limits.memoryMb === null ? "" : String(view.limits.memoryMb),
        sleeps: view.sleepAfterMinutes !== null,
        sleepAfter: String(view.sleepAfterMinutes ?? 30)
    };
}

/** The draft as the server takes it, or the first thing wrong with it. */
function parse(draft: Draft) {
    const input = {
        replicas: Number(draft.replicas),
        autoscale: draft.autoscale
            ? {
                  min: Number(draft.min),
                  max: Number(draft.max),
                  cpuPercent: Number(draft.cpuPercent),
                  requestsPerCopy: draft.requestsPerCopy.trim()
                      ? Number(draft.requestsPerCopy)
                      : null
              }
            : null,
        balancing: { sticky: draft.sticky, healthPath: draft.healthPath.trim() || null },
        // Blank is no limit, not zero.
        limits: {
            cpus: draft.cpus.trim() ? Number(draft.cpus) : null,
            memoryMb: draft.memoryMb.trim() ? Number(draft.memoryMb) : null
        },
        sleepAfterMinutes: draft.sleeps ? Number(draft.sleepAfter) : null
    };
    const parsed = core.serviceScalingSchema
        .extend({
            balancing: core.edgeBalancingSchema,
            limits: core.resourceLimitsSchema,
            sleepAfterMinutes: core.serviceSleepSchema
        })
        .safeParse(input);
    return parsed.success
        ? { input: parsed.data, problem: null }
        : { input: null, problem: parsed.error.issues[0]?.message ?? "Check these settings" };
}

export function ScalingSection({
    applicationId,
    onChanged
}: {
    applicationId: string;
    onChanged: () => void;
}) {
    const [view, setView] = useState<ServiceScalingView | null>(null);
    const [draft, setDraft] = useState<Draft | null>(null);
    const [error, setError] = useState<string | null>(null);
    const [note, setNote] = useState<string | null>(null);
    const [pending, startTransition] = useTransition();

    useEffect(() => {
        let active = true;
        void serviceScalingAction(applicationId).then((result) => {
            if (!active) return;
            if (result.scaling) {
                setView(result.scaling);
                setDraft(draftOf(result.scaling));
            } else setError(result.error ?? "Could not read how this service is scaled");
        });
        return () => {
            active = false;
        };
    }, [applicationId]);

    const checked = useMemo(() => (draft ? parse(draft) : null), [draft]);
    const set = (patch: Partial<Draft>) =>
        setDraft((current) => (current ? { ...current, ...patch } : current));
    const copies = Number(draft?.autoscale ? draft.max : draft?.replicas) || 1;

    function save() {
        if (!checked?.input) return;
        const input = checked.input;
        setError(null);
        setNote(null);
        startTransition(async () => {
            const result = await saveServiceScalingAction(applicationId, input);
            if (result.error) {
                setError(result.error);
                return;
            }
            setNote(
                result.redeployed
                    ? "Saved. The service is being started again with the new settings."
                    : "Saved."
            );
            onChanged();
        });
    }

    return (
        <section className="flex flex-col gap-2">
            <h3 className="text-sm font-medium">Scaling</h3>
            {!draft || !view ? (
                error ? (
                    <p className="text-sm text-danger">{error}</p>
                ) : (
                    <div className="h-40 animate-pulse rounded-md border border-border bg-muted/40" />
                )
            ) : (
                <div className="flex flex-col gap-3 rounded-md border border-border p-3 text-sm">
                    {view.single && <p className="text-xs text-muted-foreground">{view.single}</p>}
                    <label className="flex flex-col gap-1">
                        <span className="font-medium">Copies</span>
                        <Input
                            type="number"
                            min={1}
                            max={core.REPLICAS_MAX}
                            value={draft.replicas}
                            disabled={view.single !== null || draft.autoscale}
                            onChange={(event) => set({ replicas: event.target.value })}
                            className="w-28"
                        />
                        <span className="text-xs text-muted-foreground">
                            How many copies of the service run at once, up to {core.REPLICAS_MAX}.
                            The edge spreads requests over them.
                        </span>
                    </label>

                    <div className="flex items-start justify-between gap-3">
                        <span>
                            <span className="font-medium">Scale by itself</span>
                            <span className="block text-xs text-muted-foreground">
                                Add a copy when CPU or requests per copy stay above their target for
                                three minutes, and take one away after ten minutes with both low.
                                With a requests target, {core.AUTOSCALE_IDLE_AFTER} minutes with no
                                requests at all drops straight to the fewest. CPU is each
                                copy&apos;s share of the machine, the same figure the Metrics tab
                                shows.
                                {view.engine === "swarm" &&
                                    " Not on a swarm machine, which keeps its own count."}
                            </span>
                        </span>
                        <Switch
                            checked={draft.autoscale}
                            onChange={(value) => set({ autoscale: value })}
                            disabled={view.single !== null || view.engine === "swarm"}
                            aria-label="Scale by itself"
                        />
                    </div>
                    {draft.autoscale && (
                        <div className="flex flex-wrap gap-3">
                            <label className="flex flex-col gap-1">
                                <span className="text-xs text-muted-foreground">Fewest</span>
                                <Input
                                    type="number"
                                    min={1}
                                    max={core.REPLICAS_MAX}
                                    value={draft.min}
                                    onChange={(event) => set({ min: event.target.value })}
                                    className="w-24"
                                />
                            </label>
                            <label className="flex flex-col gap-1">
                                <span className="text-xs text-muted-foreground">Most</span>
                                <Input
                                    type="number"
                                    min={1}
                                    max={core.REPLICAS_MAX}
                                    value={draft.max}
                                    onChange={(event) => set({ max: event.target.value })}
                                    className="w-24"
                                />
                            </label>
                            <label className="flex flex-col gap-1">
                                <span className="text-xs text-muted-foreground">
                                    CPU target (%)
                                </span>
                                <Input
                                    type="number"
                                    min={5}
                                    max={90}
                                    value={draft.cpuPercent}
                                    onChange={(event) => set({ cpuPercent: event.target.value })}
                                    className="w-24"
                                />
                            </label>
                            <label className="flex flex-col gap-1">
                                <span className="text-xs text-muted-foreground">
                                    Requests per copy (a minute)
                                </span>
                                <Input
                                    type="number"
                                    min={1}
                                    max={core.REQUESTS_PER_COPY_MAX}
                                    value={draft.requestsPerCopy}
                                    // A stored target can still be cleared where it cannot be read.
                                    disabled={
                                        view.trafficBlocked !== null &&
                                        !draft.requestsPerCopy.trim()
                                    }
                                    onChange={(event) =>
                                        set({ requestsPerCopy: event.target.value })
                                    }
                                    placeholder="CPU only"
                                    className="w-44"
                                />
                            </label>
                        </div>
                    )}
                    {draft.autoscale && view.trafficBlocked && (
                        <p className="text-xs text-muted-foreground">{view.trafficBlocked}</p>
                    )}
                    {draft.autoscale && view.lastAutoscale && (
                        <p className="text-xs text-muted-foreground">
                            {describeServiceEvent(view.lastAutoscale)}{" "}
                            <span className="text-foreground-subtle">
                                <RelativeTime iso={view.lastAutoscale.createdAt} />
                            </span>
                        </p>
                    )}

                    <div className="flex items-start justify-between gap-3">
                        <span>
                            <span className="font-medium">Sleep when nobody visits</span>
                            <span className="block text-xs text-muted-foreground">
                                Stop the service after a stretch with no visits, and start it on the
                                next one. The first visitor sees a page saying it is waking up for
                                the few seconds that takes.
                                {view.asleep && " It is asleep now."}
                                {view.sleepBlocked && ` ${view.sleepBlocked}`}
                            </span>
                        </span>
                        <Switch
                            checked={draft.sleeps}
                            onChange={(value) => set({ sleeps: value })}
                            disabled={view.sleepBlocked !== null && !draft.sleeps}
                            aria-label="Sleep when nobody visits"
                        />
                    </div>
                    {draft.sleeps && (
                        <label className="flex flex-col gap-1">
                            <span className="text-xs text-muted-foreground">
                                After (minutes without a visit)
                            </span>
                            <Input
                                type="number"
                                min={core.SLEEP_AFTER_MIN_MINUTES}
                                max={core.SLEEP_AFTER_MAX_MINUTES}
                                value={draft.sleepAfter}
                                onChange={(event) => set({ sleepAfter: event.target.value })}
                                className="w-28"
                            />
                        </label>
                    )}

                    <div className="flex flex-col gap-1">
                        <span className="font-medium">Resources per copy</span>
                        <div className="flex flex-wrap gap-3">
                            <label className="flex flex-col gap-1">
                                <span className="text-xs text-muted-foreground">CPU (cores)</span>
                                <Input
                                    type="number"
                                    min={0.05}
                                    step={0.05}
                                    value={draft.cpus}
                                    onChange={(event) => set({ cpus: event.target.value })}
                                    placeholder="No limit"
                                    className="w-28"
                                />
                            </label>
                            <label className="flex flex-col gap-1">
                                <span className="text-xs text-muted-foreground">Memory (MB)</span>
                                <Input
                                    type="number"
                                    min={16}
                                    step={64}
                                    value={draft.memoryMb}
                                    onChange={(event) => set({ memoryMb: event.target.value })}
                                    placeholder="No limit"
                                    className="w-28"
                                />
                            </label>
                        </div>
                        <span className="text-xs text-muted-foreground">
                            A copy past its memory is stopped and started again; one past its CPU is
                            slowed. Blank = no limit.
                        </span>
                    </div>

                    <div className="flex items-start justify-between gap-3">
                        <span>
                            <span className="font-medium">Keep each visitor on one copy</span>
                            <span className="block text-xs text-muted-foreground">
                                For WebSockets and sessions kept in memory. A cookie pins the
                                visitor to the copy that answered them first.
                            </span>
                        </span>
                        <Switch
                            checked={draft.sticky}
                            onChange={(value) => set({ sticky: value })}
                            aria-label="Keep each visitor on one copy"
                        />
                    </div>
                    <label className="flex flex-col gap-1">
                        <span className="font-medium">Health check path</span>
                        <Input
                            value={draft.healthPath}
                            onChange={(event) => set({ healthPath: event.target.value })}
                            placeholder="/healthz"
                            autoCapitalize="none"
                            autoCorrect="off"
                            spellCheck={false}
                            className="max-w-xs"
                        />
                        <span className="text-xs text-muted-foreground">
                            Asked of every copy every 10 seconds. One that stops answering is left
                            out until it answers again. Blank = no check.
                        </span>
                    </label>
                    {copies > 1 && (
                        <p className="text-xs text-muted-foreground">
                            With more than one copy the edge balances between them itself, so email
                            addresses in its pages are not hidden from scrapers.
                        </p>
                    )}

                    {checked?.problem && <p className="text-xs text-danger">{checked.problem}</p>}
                    {error && <p className="text-sm text-danger">{error}</p>}
                    {note && <p className="text-xs text-muted-foreground">{note}</p>}
                    <div className="flex justify-end">
                        <Button onClick={save} disabled={pending || !checked?.input}>
                            {pending && <Loader2 className="size-4 animate-spin" />} Save scaling
                        </Button>
                    </div>
                </div>
            )}
        </section>
    );
}
