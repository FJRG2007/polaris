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
import { mailNoteText, portNote, portWords } from "@/lib/mail-server/words";
import { useTranslations } from "@/components/i18n/i18n-provider";

type Health = Extract<Awaited<ReturnType<typeof healthAction>>, { health: unknown }>["health"];

/** The part of the server the page read before it drew, to stand in for the
 *  detail until that arrives. */
export interface OverviewSeed {
    readonly hostname: string;
    readonly primaryDomain: string;
    readonly status: string;
}

export function OverviewTab({ serverId, seed }: { serverId: string; seed: OverviewSeed }) {
    const t = useTranslations("mailServer");
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
                error: t("common.unreachable")
            }));
            if (stopped) return;
            if ("server" in answer && answer.server) {
                setDetail(answer.server);
                setError(null);
                if (answer.server.running || answer.server.status === "setting-up")
                    timer = setTimeout(tick, 3000);
            } else {
                setError(answer.error ?? t("refusals.notFound"));
            }
        };
        void tick();
        return () => {
            stopped = true;
            if (timer) clearTimeout(timer);
        };
    }, [serverId, busy, t]);

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

    // Until the detail arrives the header, the health check and the way out are
    // drawn from what the page already read; only the steps, the log and the
    // name of the machine wait. Removing waits too, since whether setup is
    // running is not known until then.
    const status = detail?.status ?? seed.status;
    const settingUp = detail
        ? detail.running || detail.status === "setting-up"
        : status === "setting-up";
    return (
        <div className="flex flex-col gap-6">
            <section className="flex flex-col gap-3">
                <div className="flex flex-wrap items-center gap-2">
                    <StatusBadge status={status} />
                    <span className="flex items-center gap-1 text-[0.8125rem] text-muted-foreground">
                        {t.rich("overview.on", {
                            domain: detail?.primaryDomain ?? seed.primaryDomain,
                            place: () =>
                                detail ? (
                                    <span key="place">{detail.placementName}</span>
                                ) : (
                                    <Skeleton key="place" className="h-3.5 w-24" />
                                )
                        })}
                    </span>
                    <div className="ml-auto flex items-center gap-2">
                        {detail?.projectId ? (
                            <Button asChild size="sm" variant="outline">
                                <Link href={`/apps/deploy/${detail.projectId}`}>
                                    <ExternalLink />
                                    {t("overview.inDeploy")}
                                </Link>
                            </Button>
                        ) : null}
                    </div>
                </div>
                {error ? <PanelError message={error} /> : null}
                {!detail ? <Skeleton className="h-32 w-full" /> : null}
                {detail && detail.status === "failed" && detail.error ? (
                    <div className="flex flex-wrap items-center justify-between gap-3 rounded-md border border-danger-edge bg-danger-soft px-3 py-2">
                        <span className="text-[0.8125rem] text-danger">{detail.error}</span>
                        <Button size="sm" onClick={() => void resume(null)} disabled={busy}>
                            {t("overview.runAgain")}
                        </Button>
                    </div>
                ) : null}
                {detail ? (
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
                ) : null}
                {detail?.log ? (
                    <pre className="max-h-64 overflow-auto overscroll-contain whitespace-pre-wrap rounded-md border border-border bg-surface p-3 font-mono text-xs text-muted-foreground">
                        {detail.log}
                    </pre>
                ) : null}
                {detail && !settingUp ? (
                    <div className="flex flex-wrap items-center gap-2">
                        <span className="text-xs text-muted-foreground">
                            {t("overview.repairFrom")}
                        </span>
                        <div className="w-64">
                            <Select
                                aria-label={t("overview.repairStep")}
                                value={repairFrom}
                                onValueChange={setRepairFrom}
                                placeholder={t("overview.chooseStep")}
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
                            {t("overview.repair")}
                        </Button>
                    </div>
                ) : null}
            </section>

            {status === "ready" || status === "down" ? <HealthSection serverId={serverId} /> : null}

            <section className="flex flex-wrap items-center justify-between gap-3 border-t border-border pt-4">
                <p className="max-w-xl text-xs text-muted-foreground">
                    {t("overview.removeHint")}
                </p>
                <Button
                    size="sm"
                    variant="outline"
                    onClick={() => setRemoving(true)}
                    disabled={!detail || detail.running}
                >
                    {t("overview.remove")}
                </Button>
            </section>
            <ConfirmDeleteDialog
                open={removing}
                onOpenChange={setRemoving}
                name={detail?.hostname ?? seed.hostname}
                kind={t("overview.kind")}
                title={t("overview.removeTitle")}
                confirmLabel={t("overview.removeConfirm")}
                description={t("overview.removeBody")}
                error={removeError}
                onConfirm={() => void remove()}
            />
        </div>
    );
}

function HealthSection({ serverId }: { serverId: string }) {
    const t = useTranslations("mailServer");
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
                <h2 className="text-sm font-semibold text-foreground">{t("health.title")}</h2>
                <Button
                    size="sm"
                    variant="outline"
                    onClick={() => void check()}
                    disabled={checking}
                >
                    <RefreshCw className={checking ? "animate-spin" : undefined} />
                    {checking ? t("dns.checking") : t("health.check")}
                </Button>
            </div>
            {error ? <PanelError message={error} /> : null}
            {health ? (
                <dl className="grid grid-cols-1 gap-3 sm:grid-cols-3">
                    <div className="rounded-md border border-border p-3">
                        <dt className="text-xs text-muted-foreground">{t("health.engine")}</dt>
                        <dd className="mt-1 flex items-center gap-2 text-[0.8125rem]">
                            <VerdictBadge
                                verdict={
                                    health.engine.answers && health.engine.managed ? "pass" : "fail"
                                }
                                label={
                                    health.engine.answers
                                        ? health.engine.managed
                                            ? t("health.answering")
                                            : t("health.notManaged")
                                        : t("status.down")
                                }
                            />
                        </dd>
                        {health.engine.note ? (
                            <p className="mt-1 text-xs text-muted-foreground">
                                {mailNoteText(t, health.engine.note)}
                            </p>
                        ) : null}
                    </div>
                    <div className="rounded-md border border-border p-3">
                        <dt className="text-xs text-muted-foreground">{t("health.queued")}</dt>
                        <dd className="mt-1 text-[0.8125rem] text-foreground">
                            {health.engine.queued === null
                                ? t("health.unknown")
                                : t("health.messages", { count: health.engine.queued })}
                        </dd>
                    </div>
                    <div className="rounded-md border border-border p-3">
                        <dt className="text-xs text-muted-foreground">{t("health.certificate")}</dt>
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
                                {t("health.expires", { when: format.date(health.certificate.expiresAt) })}
                            </p>
                        ) : null}
                        {health.certificate.note ? (
                            <p className="mt-1 text-xs text-muted-foreground">
                                {mailNoteText(t, health.certificate.note)}
                            </p>
                        ) : null}
                    </div>
                </dl>
            ) : null}
            {/* The pair the DNS tab cannot cover, because neither is a record in
                the operator's own zone: a reverse name is set by whoever hands
                out the address. Put beside the ports rather than under Domains
                for that reason, and because it is about the one address the
                whole server sends from rather than about a domain. */}
            {health ? (
                <div className="flex flex-col gap-2 rounded-md border border-border p-3">
                    <div className="flex flex-wrap items-center gap-2">
                        <h3 className="text-xs text-muted-foreground">
                            {t("health.leavesFrom")}
                        </h3>
                        <VerdictBadge verdict={health.reverse.verdict} />
                        {health.reverse.address ? <Mono>{health.reverse.address}</Mono> : null}
                    </div>
                    {[health.reverse.reverse, health.reverse.greeting].map((check, at) => (
                        <div key={at} className="flex flex-col gap-0.5">
                            <p className="flex items-center gap-2 text-[0.8125rem]">
                                <VerdictBadge verdict={check.verdict} />
                                <span className="text-muted-foreground">
                                    {at === 0 ? t("health.reverse") : t("health.greeting")}
                                </span>
                            </p>
                            <p className="text-xs text-muted-foreground">{mailNoteText(t, check.note)}</p>
                            {check.instruction ? (
                                <p className="text-xs text-foreground">{mailNoteText(t, check.instruction)}</p>
                            ) : null}
                        </div>
                    ))}
                </div>
            ) : null}
            {ports ? (
                <div className="flex flex-col gap-2">
                    <p className="text-xs text-muted-foreground">
                        {ports.address ? (
                            t.rich(ports.at ? "health.knockedAt" : "health.knocked", {
                                address: ports.address,
                                when: ports.at ? format.dateTime(ports.at) : "",
                                mono: (chunks) => <Mono key="address">{chunks}</Mono>
                            })
                        ) : (
                            mailNoteText(t, ports.note)
                        )}
                    </p>
                    {ports.results.length > 0 ? (
                        <div className="overflow-x-auto">
                            <table className="w-full text-[0.8125rem]">
                                <thead>
                                    <tr className="text-left">
                                        <th className="py-1.5 pr-3">{t("health.columns.port")}</th>
                                        <th className="py-1.5 pr-3">{t("health.columns.usedFor")}</th>
                                        <th className="py-1.5 pr-3">{t("health.columns.result")}</th>
                                    </tr>
                                </thead>
                                <tbody className="divide-y divide-border">
                                    {ports.results.map((result) => (
                                        <tr key={result.port}>
                                            <td className="py-2 pr-3 font-mono text-xs">
                                                {result.port}{" "}
                                                <span className="text-muted-foreground">
                                                    {portWords(t, result).label}
                                                </span>
                                            </td>
                                            <td className="py-2 pr-3 text-muted-foreground">
                                                {portWords(t, result).purpose}
                                            </td>
                                            <td className="py-2 pr-3">
                                                <div className="flex flex-col gap-1">
                                                    <VerdictBadge verdict={result.verdict} />
                                                    {result.note ? (
                                                        <span className="text-xs text-muted-foreground">
                                                            {portNote(t, result.note)}
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
                <p className="text-xs text-muted-foreground">{t("dns.notChecked")}</p>
            ) : null}
        </section>
    );
}
