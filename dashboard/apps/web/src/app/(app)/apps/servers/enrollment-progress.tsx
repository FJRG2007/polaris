"use client";

/**
 * The steps a machine goes through on its way into Polaris, each with its own
 * live log and, where one failed, what to do about it.
 *
 * Drawn entirely from the enrollment's event log (`enrollmentTimeline`), so what
 * is on screen is what the exchange recorded rather than a guess from how long
 * it has been: a step is only ticked once Polaris saw it happen.
 */

import { cn } from "@polaris/ui";
import { useTranslations } from "@/components/i18n/i18n-provider";
import { CheckCircle2, Circle, Loader2, XCircle } from "lucide-react";
import {
    ENROLLMENT_USERNAME,
    enrollmentTimeline,
    type EnrollmentEvent,
    type EnrollmentStepView
} from "@polaris/core";

export function EnrollmentProgress({ events }: { events: EnrollmentEvent[] }) {
    const t = useTranslations("servers");
    const steps = enrollmentTimeline(events);
    // The first step nothing has happened to is the one the reader is waiting on,
    // so it gets the "what happens next" line rather than all of them at once.
    const nextWaiting = steps.find((step) => step.status === "waiting")?.step;
    const anyFailed = steps.some((step) => step.status === "failed");

    return (
        <ol className="flex flex-col gap-2" aria-label={t("onboard.stepsLabel")}>
            {steps.map((view) => (
                <li key={view.step} className="flex gap-2">
                    <StepIcon status={view.status} />
                    <div className="flex min-w-0 flex-1 flex-col gap-1">
                        <span
                            className={cn(
                                "text-sm",
                                view.status === "waiting" ? "text-muted-foreground" : "font-medium"
                            )}
                        >
                            {t(`onboard.steps.${view.step}`)}
                        </span>
                        {view.step === nextWaiting && !anyFailed ? (
                            <span className="text-xs text-muted-foreground">
                                {t(`onboard.next.${view.step}`)}
                            </span>
                        ) : null}
                        {view.events.length > 0 ? <StepLog view={view} /> : null}
                        {view.failure ? <StepFix event={view.failure} /> : null}
                    </div>
                </li>
            ))}
        </ol>
    );
}

function StepIcon({ status }: { status: EnrollmentStepView["status"] }) {
    const t = useTranslations("servers");
    const label = t(`onboard.status.${status}`);
    if (status === "done")
        return <CheckCircle2 className="mt-0.5 size-4 shrink-0 text-success" aria-label={label} />;
    if (status === "failed")
        return <XCircle className="mt-0.5 size-4 shrink-0 text-danger" aria-label={label} />;
    if (status === "active")
        return (
            <Loader2
                className="mt-0.5 size-4 shrink-0 animate-spin text-primary"
                aria-label={label}
            />
        );
    return <Circle className="mt-0.5 size-4 shrink-0 text-muted-foreground/50" aria-label={label} />;
}

/** The step's own lines, with the time each one happened. */
function StepLog({ view }: { view: EnrollmentStepView }) {
    return (
        <ul className="flex flex-col gap-0.5 rounded-md bg-muted/30 px-2 py-1.5 font-mono text-xs">
            {view.events.map((event, index) => (
                <li key={`${event.at}-${index}`} className="flex min-w-0 gap-2">
                    <time className="shrink-0 text-muted-foreground" dateTime={event.at}>
                        {clock(event.at)}
                    </time>
                    <span
                        className={cn(
                            "min-w-0 break-words",
                            event.state === "failed" ? "text-danger" : undefined
                        )}
                    >
                        <LogLine event={event} />
                    </span>
                </li>
            ))}
        </ul>
    );
}

function LogLine({ event }: { event: EnrollmentEvent }) {
    const t = useTranslations("servers");
    const address = event.address ?? "";
    if (event.code === "machineReported" && event.facts) {
        const facts = event.facts;
        const system = [facts.os || facts.platform, facts.arch].filter(Boolean).join(", ");
        return (
            <>
                {t("onboard.log.machineReported", { system })}{" "}
                {facts.docker ? t("onboard.log.dockerYes") : t("onboard.log.dockerNo")}{" "}
                {facts.root ? t("onboard.log.rootYes") : t("onboard.log.rootNo")}
            </>
        );
    }
    if (event.code === "refused") return <>{t("onboard.log.refused")}</>;
    if (event.code === "registered")
        return <>{t("onboard.log.registered", { name: event.detail ?? "" })}</>;
    if (event.code === "setupFailed")
        return <>{t("onboard.log.setupFailed", { reason: event.detail ?? "" })}</>;
    if (event.code === "machineReported") return <>{t("onboard.log.machineReportedBare")}</>;
    return <>{t(`onboard.log.${event.code}`, { address })}</>;
}

/** What the reader can do about the step that failed. A refusal already carries
 *  the machine's own diagnosis, which is more precise than anything generic. */
function StepFix({ event }: { event: EnrollmentEvent }) {
    const t = useTranslations("servers");
    const text =
        event.code === "refused" && event.reason
            ? t(`enroll.refusals.${event.reason}`, { login: ENROLLMENT_USERNAME })
            : event.code in FIXES
              ? t(`onboard.fix.${FIXES[event.code as keyof typeof FIXES]}`)
              : t("onboard.fix.generic");
    return (
        <div className="rounded-md border border-danger-edge bg-danger-soft px-2.5 py-2 text-xs">
            <span className="font-medium">{t("onboard.whatToDo")}</span> {text}
        </div>
    );
}

/** The failures that have their own advice; anything else gets the generic one. */
const FIXES = {
    unreachable: "unreachable",
    keyRefused: "keyRefused",
    wrongMachine: "wrongMachine",
    connectFailed: "connectFailed",
    noAddress: "noAddress",
    noHostKey: "noHostKey",
    setupFailed: "setupFailed",
    setupStalled: "setupFailed"
} as const;

/** The time of day an event happened, to the second: the log is read live. */
function clock(at: string): string {
    const date = new Date(at);
    if (Number.isNaN(date.getTime())) return "";
    return date.toLocaleTimeString(undefined, { hour: "2-digit", minute: "2-digit", second: "2-digit" });
}
