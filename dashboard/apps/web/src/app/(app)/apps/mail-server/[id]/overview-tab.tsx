"use client";

/**
 * Setup as it runs, and whether the server is well once it has.
 *
 * While setup runs the log is read back every few seconds; when it stops on
 * something, the sentence it stopped on is shown beside the button that runs it
 * again from there. Repair runs it again from a chosen step. Once the server is
 * up, the health check knocks on its ports from outside and reads the
 * certificate a mail app would be shown.
 */

import Link from "next/link";
import { useRouter } from "next/navigation";
import { useEffect, useState } from "react";
import { useDisplayFormat } from "@/components/display-format";
import { Button, ConfirmDeleteDialog, Select, Skeleton } from "@polaris/ui";
import { Check, Circle, ExternalLink, Loader2, RefreshCw } from "lucide-react";
import {
    Mono,
    PanelError,
    StatusBadge,
    usePanelData,
    VerdictBadge,
    forgetPanelData
} from "../ui-bits";
import {
    healthAction,
    removeServerAction,
    resumeSetupAction,
    serverDetailAction,
    storedHealthAction,
    type MailServerDetail
} from "../actions";

type Health = Extract<Awaited<ReturnType<typeof healthAction>>, { health: unknown }>["health"];

export function OverviewTab({ serverId }: { serverId: string }) {
    const router = useRouter();
    const [detail, setDetail] = useState<MailServerDetail | null>(null);
    const [error, setError] = useState<string | null>(null);
    const [repairFrom, setRepairFrom] = useState<string>("");
    const [busy, setBusy] = useState(false);
    const [removing, setRemoving] = useState(false);
    const [removeError, setRemoveError] = useState<string | null>(null);

    // Read the row back; every three seconds while setup is running.
    useEffect(() => {
        let stopped = false;
        let timer: ReturnType<typeof setTimeout> | null = null;
        const tick = async () => {
            const answer = await serverDetailAction(serverId).catch(() => ({
                error: "Polaris could not be reached."
            }));
            if (stopped) return;
            if ("server" in answer && answer.server) {
                setDetail(answer.server);
                setError(null);
                if (answer.server.running || answer.server.status === "setting-up")
                    timer = setTimeout(tick, 3000);
            } else {
                setError(answer.error ?? "That mail server was not found.");
            }
        };
        void tick();
        return () => {
            stopped = true;
            if (timer) clearTimeout(timer);
        };
    }, [serverId, busy]);

    async function resume(from: string | null): Promise<void> {
        setBusy(true);
        const answer = await resumeSetupAction({ serverId, from });
        if (answer.error) setError(answer.error);
        setBusy(false);
    }

    async function remove(): Promise<void> {
        setRemoveError(null);
        const answer = await removeServerAction(serverId);
        if (answer.error) {
            setRemoveError(answer.error);
            return;
        }
        forgetPanelData("servers");
        router.push("/apps/mail-server");
    }

    if (error && !detail) return <PanelError message={error} />;
    if (!detail) {
        return (
            <div className="flex flex-col gap-3">
                <Skeleton className="h-6 w-48" />
                <Skeleton className="h-32 w-full" />
            </div>
        );
    }

    const settingUp = detail.running || detail.status === "setting-up";
    return (
        <div className="flex flex-col gap-6">
            <section className="flex flex-col gap-3">
                <div className="flex flex-wrap items-center gap-2">
                    <StatusBadge status={detail.status} />
                    <span className="text-[0.8125rem] text-muted-foreground">
                        {detail.primaryDomain} on {detail.placementName}
                    </span>
                    <div className="ml-auto flex items-center gap-2">
                        {detail.projectId ? (
                            <Button asChild size="sm" variant="outline">
                                <Link href={`/apps/deploy/${detail.projectId}`}>
                                    <ExternalLink />
                                    Service in Deploy
                                </Link>
                            </Button>
                        ) : null}
                    </div>
                </div>
                {error ? <PanelError message={error} /> : null}
                {detail.status === "failed" && detail.error ? (
                    <div className="flex flex-wrap items-center justify-between gap-3 rounded-md border border-danger-edge bg-danger-soft px-3 py-2">
                        <span className="text-[0.8125rem] text-danger">{detail.error}</span>
                        <Button size="sm" onClick={() => void resume(null)} disabled={busy}>
                            Run setup again from here
                        </Button>
                    </div>
                ) : null}
                <ol className="flex flex-col gap-1.5">
                    {detail.steps.map((entry, index) => {
                        const current =
                            settingUp &&
                            !entry.done &&
                            (index === 0 || detail.steps[index - 1]?.done);
                        return (
                            <li
                                key={entry.step}
                                className="flex items-center gap-2 text-[0.8125rem]"
                            >
                                {entry.done ? (
                                    <Check className="size-4 text-success" />
                                ) : current ? (
                                    <Loader2 className="size-4 animate-spin text-primary" />
                                ) : (
                                    <Circle className="size-4 text-foreground-subtle" />
                                )}
                                <span
                                    className={
                                        entry.done ? "text-foreground" : "text-muted-foreground"
                                    }
                                >
                                    {entry.label}
                                </span>
                            </li>
                        );
                    })}
                </ol>
                {detail.log ? (
                    <pre className="max-h-64 overflow-auto overscroll-contain whitespace-pre-wrap rounded-md border border-border bg-surface p-3 font-mono text-xs text-muted-foreground">
                        {detail.log}
                    </pre>
                ) : null}
                {!settingUp ? (
                    <div className="flex flex-wrap items-center gap-2">
                        <span className="text-xs text-muted-foreground">
                            Repair by running setup again from
                        </span>
                        <div className="w-64">
                            <Select
                                aria-label="Step to repair from"
                                value={repairFrom}
                                onValueChange={setRepairFrom}
                                placeholder="Choose a step"
                                options={detail.steps.map((entry) => ({
                                    value: entry.step,
                                    label: entry.label
                                }))}
                            />
                        </div>
                        <Button
                            size="sm"
                            variant="outline"
                            disabled={!repairFrom || busy}
                            onClick={() => void resume(repairFrom)}
                        >
                            Repair
                        </Button>
                    </div>
                ) : null}
            </section>

            {detail.status === "ready" || detail.status === "down" ? (
                <HealthSection serverId={serverId} />
            ) : null}

            <section className="flex flex-wrap items-center justify-between gap-3 border-t border-border pt-4">
                <p className="max-w-xl text-xs text-muted-foreground">
                    Removing it here stops Polaris managing it. The service, its volumes and the
                    mail in them stay in Deploy until you delete them there.
                </p>
                <Button
                    size="sm"
                    variant="outline"
                    onClick={() => setRemoving(true)}
                    disabled={detail.running}
                >
                    Remove from Polaris
                </Button>
            </section>
            <ConfirmDeleteDialog
                open={removing}
                onOpenChange={setRemoving}
                name={detail.hostname}
                kind="mail server"
                title="Stop managing this mail server?"
                confirmLabel="Remove"
                description="Its service and mail stay in Deploy. Rules on incoming mail and filed DMARC reports are deleted."
                error={removeError}
                onConfirm={() => void remove()}
            />
        </div>
    );
}

function HealthSection({ serverId }: { serverId: string }) {
    const format = useDisplayFormat();
    const stored = usePanelData(`stored-health:${serverId}`, () => storedHealthAction(serverId));
    const [health, setHealth] = useState<Health | null>(null);
    const [checking, setChecking] = useState(false);
    const [error, setError] = useState<string | null>(null);

    async function check(): Promise<void> {
        setChecking(true);
        setError(null);
        const answer = await healthAction(serverId);
        setChecking(false);
        if (answer.error) setError(answer.error);
        else if ("health" in answer) {
            setHealth(answer.health);
            forgetPanelData(`stored-health:${serverId}`);
        }
    }

    const ports = health?.ports ?? stored.data?.ports ?? null;
    return (
        <section className="flex flex-col gap-3">
            <div className="flex items-center justify-between gap-2">
                <h2 className="text-sm font-semibold text-foreground">Health</h2>
                <Button
                    size="sm"
                    variant="outline"
                    onClick={() => void check()}
                    disabled={checking}
                >
                    <RefreshCw className={checking ? "animate-spin" : undefined} />
                    {checking ? "Checking..." : "Check now"}
                </Button>
            </div>
            {error ? <PanelError message={error} /> : null}
            {health ? (
                <dl className="grid grid-cols-1 gap-3 sm:grid-cols-3">
                    <div className="rounded-md border border-border p-3">
                        <dt className="text-xs text-muted-foreground">Engine</dt>
                        <dd className="mt-1 flex items-center gap-2 text-[0.8125rem]">
                            <VerdictBadge
                                verdict={
                                    health.engine.answers && health.engine.managed ? "pass" : "fail"
                                }
                                label={
                                    health.engine.answers
                                        ? health.engine.managed
                                            ? "Answering"
                                            : "Not managed"
                                        : "Not answering"
                                }
                            />
                        </dd>
                        {health.engine.note ? (
                            <p className="mt-1 text-xs text-muted-foreground">
                                {health.engine.note}
                            </p>
                        ) : null}
                    </div>
                    <div className="rounded-md border border-border p-3">
                        <dt className="text-xs text-muted-foreground">Waiting to go out</dt>
                        <dd className="mt-1 text-[0.8125rem] text-foreground">
                            {health.engine.queued === null
                                ? "Unknown"
                                : `${health.engine.queued} message${health.engine.queued === 1 ? "" : "s"}`}
                        </dd>
                    </div>
                    <div className="rounded-md border border-border p-3">
                        <dt className="text-xs text-muted-foreground">Certificate on 465</dt>
                        <dd className="mt-1 flex flex-wrap items-center gap-2 text-[0.8125rem]">
                            <VerdictBadge verdict={health.certificate.verdict} />
                            {health.certificate.issuer ? (
                                <span className="text-muted-foreground">
                                    {health.certificate.issuer}
                                </span>
                            ) : null}
                        </dd>
                        {health.certificate.expiresAt ? (
                            <p className="mt-1 text-xs text-muted-foreground">
                                Expires {format.date(health.certificate.expiresAt)}
                            </p>
                        ) : null}
                        {health.certificate.note ? (
                            <p className="mt-1 text-xs text-muted-foreground">
                                {health.certificate.note}
                            </p>
                        ) : null}
                    </div>
                </dl>
            ) : null}
            {ports ? (
                <div className="flex flex-col gap-2">
                    <p className="text-xs text-muted-foreground">
                        {ports.address ? (
                            <>
                                Ports knocked on at <Mono>{ports.address}</Mono>, from where Polaris
                                runs
                                {ports.at ? `, ${format.dateTime(ports.at)}` : ""}.
                            </>
                        ) : (
                            ports.note
                        )}
                    </p>
                    {ports.results.length > 0 ? (
                        <div className="overflow-x-auto">
                            <table className="w-full text-[0.8125rem]">
                                <thead>
                                    <tr className="text-left">
                                        <th className="py-1.5 pr-3">Port</th>
                                        <th className="py-1.5 pr-3">Used for</th>
                                        <th className="py-1.5 pr-3">Result</th>
                                    </tr>
                                </thead>
                                <tbody className="divide-y divide-border">
                                    {ports.results.map((result) => (
                                        <tr key={result.port}>
                                            <td className="py-2 pr-3 font-mono text-xs">
                                                {result.port}{" "}
                                                <span className="text-muted-foreground">
                                                    {result.label}
                                                </span>
                                            </td>
                                            <td className="py-2 pr-3 text-muted-foreground">
                                                {result.purpose}
                                            </td>
                                            <td className="py-2 pr-3">
                                                <div className="flex flex-col gap-1">
                                                    <VerdictBadge verdict={result.verdict} />
                                                    {result.note ? (
                                                        <span className="text-xs text-muted-foreground">
                                                            {result.note}
                                                        </span>
                                                    ) : null}
                                                </div>
                                            </td>
                                        </tr>
                                    ))}
                                </tbody>
                            </table>
                        </div>
                    ) : null}
                </div>
            ) : !health && !stored.loading ? (
                <p className="text-xs text-muted-foreground">Not checked yet.</p>
            ) : null}
        </section>
    );
}
