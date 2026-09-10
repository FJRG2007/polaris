"use client";

/**
 * Where a deploy is, drawn as its steps: queued, source, build, keep, start,
 * live. The track fills as it goes and each circle says what happened to its
 * step - done, running now, failed, not needed, or done with a caveat.
 *
 * Two sizes: the full one over a build log, with labels and timings, and a
 * compact row of segments for a deployment in a list, which asks the server for
 * the steps rather than for the whole log.
 */

import { cn } from "@polaris/ui";
import { useEffect, useState } from "react";
import { Check, Loader2, Minus, TriangleAlert, X } from "lucide-react";
import type { DeployStep, DeployStepState } from "@/lib/deploy/deploy-steps";

const CIRCLE: Record<DeployStepState, string> = {
    done: "border-transparent bg-primary text-primary-foreground",
    current: "border-transparent bg-foreground text-background",
    failed: "border-transparent bg-danger-solid text-danger-foreground",
    warning: "border-transparent bg-warning-solid text-warning-foreground",
    skipped: "border-border bg-card text-foreground-subtle",
    pending: "border-border bg-card text-foreground-subtle"
};

const SEGMENT: Record<DeployStepState, string> = {
    done: "bg-primary",
    current: "bg-foreground animate-pulse",
    failed: "bg-danger-solid",
    warning: "bg-warning-solid",
    skipped: "bg-muted",
    pending: "bg-muted"
};

const STATE_WORD: Record<DeployStepState, string> = {
    done: "done",
    current: "in progress",
    failed: "failed",
    warning: "done with a warning",
    skipped: "not needed",
    pending: "not started"
};

function Glyph({ state }: { state: DeployStepState }) {
    if (state === "done") return <Check className="size-3.5" aria-hidden />;
    if (state === "current") return <Loader2 className="size-3.5 animate-spin" aria-hidden />;
    if (state === "failed") return <X className="size-3.5" aria-hidden />;
    if (state === "warning") return <TriangleAlert className="size-3" aria-hidden />;
    if (state === "skipped") return <Minus className="size-3" aria-hidden />;
    return <span className="size-1.5 rounded-full bg-foreground-subtle" aria-hidden />;
}

/** The full stepper, for the top of a build log. */
export function DeployStepper({ steps }: { steps: readonly DeployStep[] }) {
    const last = steps.reduce((furthest, step, index) => (step.state !== "pending" ? index : furthest), 0);
    const progress = steps.length > 1 ? (last / (steps.length - 1)) * 100 : 0;
    return (
        <ol className="relative flex items-start justify-between gap-1 px-1 pb-1 pt-1" aria-label="Deploy progress">
            {/* The track, behind the circles; each circle carries a ring the colour
                of the card so the line stops cleanly at its edge. */}
            <span className="absolute left-4 right-4 top-[0.9rem] h-0.5 rounded-full bg-border" aria-hidden />
            <span
                className="absolute left-4 top-[0.9rem] h-0.5 rounded-full bg-primary transition-[width] duration"
                style={{ width: `calc((100% - 2rem) * ${progress / 100})` }}
                aria-hidden
            />
            {steps.map((step) => (
                <li
                    key={step.id}
                    className="relative flex min-w-0 flex-1 flex-col items-center gap-1 text-center"
                    aria-label={`${step.label}: ${STATE_WORD[step.state]}`}
                >
                    <span
                        className={cn(
                            "flex size-6 items-center justify-center rounded-full border ring-4 ring-card",
                            CIRCLE[step.state]
                        )}
                    >
                        <Glyph state={step.state} />
                    </span>
                    <span
                        className={cn(
                            "max-w-full truncate text-[0.6875rem] font-medium",
                            step.state === "pending" || step.state === "skipped"
                                ? "text-foreground-subtle"
                                : step.state === "failed"
                                  ? "text-danger-ink"
                                  : "text-foreground"
                        )}
                    >
                        {step.label}
                    </span>
                    <span className="h-3.5 text-[0.625rem] tabular-nums text-foreground-subtle">
                        {step.seconds !== undefined ? `${step.seconds < 10 ? step.seconds.toFixed(1) : Math.round(step.seconds)}s` : ""}
                    </span>
                </li>
            ))}
        </ol>
    );
}

/** A thin row of segments, one per step, for a deployment in a list. */
export function DeployStepSegments({ steps }: { steps: readonly DeployStep[] }) {
    const current = steps.find((step) => step.state === "current" || step.state === "failed");
    return (
        <span className="inline-flex min-w-0 items-center gap-2">
            <span className="flex w-24 shrink-0 gap-0.5" aria-hidden>
                {steps.map((step) => (
                    <span key={step.id} className={cn("h-1 flex-1 rounded-full", SEGMENT[step.state])} />
                ))}
            </span>
            {current && (
                <span className={cn("truncate text-xs", current.state === "failed" ? "text-danger-ink" : "text-muted-foreground")}>
                    {current.label}
                </span>
            )}
        </span>
    );
}

/**
 * Follow one deployment's steps while it is moving. Asks for the steps alone -
 * see the log route's `view=steps` - and stops once the deploy has settled.
 */
export function useDeploySteps(deploymentId: string, moving: boolean): DeployStep[] | null {
    const [steps, setSteps] = useState<DeployStep[] | null>(null);
    useEffect(() => {
        let active = true;
        let timer: ReturnType<typeof setTimeout>;
        async function poll(): Promise<void> {
            const response = await fetch(`/api/deploy/deployments/${deploymentId}/log?view=steps`, {
                cache: "no-store"
            }).catch(() => null);
            if (!active) return;
            if (response?.ok) {
                const data = (await response.json()) as { steps: DeployStep[] };
                setSteps(data.steps);
            }
            if (moving) timer = setTimeout(poll, 2000);
        }
        void poll();
        return () => {
            active = false;
            clearTimeout(timer);
        };
    }, [deploymentId, moving]);
    return steps;
}
