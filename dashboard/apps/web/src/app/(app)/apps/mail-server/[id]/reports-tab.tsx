"use client";

/**
 * DMARC aggregate reports: every address that sent mail as your domains, as the
 * receivers saw it, and whether it passed. Reports arrive by themselves in the
 * server's report mailbox and are read every quarter of an hour; one somebody
 * forwarded you can be uploaded.
 */

import { useRef, useState } from "react";
import { RefreshCw, ShieldCheck, Upload } from "lucide-react";
import { useDisplayFormat } from "@/components/display-format";
import { collectReportsAction, dmarcAction } from "../actions";
import { Mono, PanelError, usePanelData, VerdictBadge } from "../ui-bits";
import { Button, EmptyState, SegmentedControl, Skeleton } from "@polaris/ui";
import { useTranslations } from "@/components/i18n/i18n-provider";
import { mailServerRefusalText } from "@/lib/mail-server/refusal-text";

type Range = "7" | "30" | "90";

export function ReportsTab({ serverId }: { serverId: string }) {
    const t = useTranslations("mailServer");
    const format = useDisplayFormat();
    const [range, setRange] = useState<Range>("30");
    const panel = usePanelData(`dmarc:${serverId}:${range}`, () => dmarcAction({ serverId, days: Number(range) }));
    const [busy, setBusy] = useState(false);
    const [message, setMessage] = useState<{ tone: "error" | "ok"; text: string } | null>(null);
    const file = useRef<HTMLInputElement>(null);

    async function collect(): Promise<void> {
        setBusy(true);
        setMessage(null);
        const answer = await collectReportsAction(serverId);
        setBusy(false);
        if (answer.error) setMessage({ tone: "error", text: answer.error });
        else if ("filed" in answer) {
            setMessage({ tone: "ok", text: t("reports.collected", { messages: answer.messages, filed: answer.filed }) });
            await panel.reload();
        }
    }

    async function upload(chosen: File): Promise<void> {
        setBusy(true);
        setMessage(null);
        const body = new FormData();
        body.append("file", chosen);
        const response = await fetch(`/api/mail-server/${serverId}/reports`, { method: "POST", body }).catch(() => null);
        const answer = (await response?.json().catch(() => null)) as { error?: string; filed?: number; ignored?: number } | null;
        setBusy(false);
        if (!response?.ok || !answer || answer.error) {
            setMessage({
                tone: "error",
                text: answer?.error ? mailServerRefusalText(t, answer.error) : t("reports.uploadFailed")
            });
            return;
        }
        setMessage({
            tone: "ok",
            text:
                (answer.filed ?? 0) > 0
                    ? t("reports.filed", { count: answer.filed ?? 0 })
                    : (answer.ignored ?? 0) > 0
                      ? t("reports.otherDomain")
                      : t("reports.already")
        });
        await panel.reload();
    }

    const overview = panel.data?.overview ?? null;
    return (
        <div className="flex flex-col gap-4">
            <div className="flex flex-wrap items-center justify-between gap-2">
                <SegmentedControl
                    aria-label={t("reports.range")}
                    size="sm"
                    value={range}
                    onValueChange={setRange}
                    options={[
                        { value: "7", label: t("reports.days", { count: 7 }) },
                        { value: "30", label: t("reports.days", { count: 30 }) },
                        { value: "90", label: t("reports.days", { count: 90 }) }
                    ]}
                />
                <div className="flex items-center gap-2">
                    <Button size="sm" variant="outline" onClick={() => void collect()} disabled={busy}>
                        <RefreshCw className={busy ? "animate-spin" : undefined} />
                        {t("reports.read")}
                    </Button>
                    <Button size="sm" variant="outline" onClick={() => file.current?.click()} disabled={busy}>
                        <Upload />
                        {t("reports.upload")}
                    </Button>
                    <input
                        ref={file}
                        type="file"
                        className="hidden"
                        accept=".xml,.gz,.zip,.eml,application/xml,application/gzip,application/zip,message/rfc822"
                        onChange={(event) => {
                            const chosen = event.target.files?.[0];
                            event.target.value = "";
                            if (chosen) void upload(chosen);
                        }}
                    />
                </div>
            </div>
            {message ? <p className={message.tone === "error" ? "text-xs text-danger" : "text-xs text-success"}>{message.text}</p> : null}
            {panel.error && !overview ? <PanelError message={panel.error} onRetry={() => void panel.reload()} /> : null}
            {overview ? (
                <p className="text-xs text-muted-foreground">
                    {t.rich("reports.address", {
                        address: overview.address,
                        mono: (chunks) => <Mono key="address">{chunks}</Mono>
                    })}{" "}
                    {overview.checkedAt
                        ? t("reports.lastRead", { when: format.dateTime(overview.checkedAt) })
                        : t("reports.notRead")}
                    {overview.error ? (
                        <span className="text-danger"> {mailServerRefusalText(t, overview.error)}</span>
                    ) : null}
                </p>
            ) : null}
            {!overview && panel.loading ? <Skeleton className="h-40 w-full" /> : null}
            {overview && overview.sources.length === 0 ? (
                <EmptyState
                    icon={<ShieldCheck />}
                    title={t("reports.none")}
                    description={t("reports.noneBody")}
                />
            ) : null}
            {overview && overview.sources.length > 0 ? (
                <div className="overflow-x-auto">
                    <table className="w-full text-[0.8125rem]">
                        <thead>
                            <tr className="text-left">
                                <th className="py-1.5 pr-3">{t("reports.columns.source")}</th>
                                <th className="py-1.5 pr-3">{t("reports.columns.messages")}</th>
                                <th className="py-1.5 pr-3">{t("reports.columns.passed")}</th>
                                <th className="py-1.5 pr-3">{t("reports.columns.failed")}</th>
                                <th className="py-1.5 pr-3">{t("reports.columns.reporters")}</th>
                                <th className="py-1.5">{t("reports.columns.verdict")}</th>
                            </tr>
                        </thead>
                        <tbody className="divide-y divide-border">
                            {overview.sources.map((source) => (
                                <tr key={source.sourceIp}>
                                    <td className="py-2 pr-3">
                                        <Mono>{source.sourceIp}</Mono>
                                    </td>
                                    <td className="py-2 pr-3">{source.messages}</td>
                                    <td className="py-2 pr-3 text-success">{source.passed}</td>
                                    <td className="py-2 pr-3 text-danger">{source.failed}</td>
                                    <td className="py-2 pr-3 text-xs text-muted-foreground">{source.reporters.join(", ")}</td>
                                    <td className="py-2">
                                        <VerdictBadge verdict={source.verdict} label={
                                                source.verdict === "pass"
                                                    ? t("reports.passes")
                                                    : source.verdict === "fail"
                                                      ? t("reports.fails")
                                                      : t("reports.someFail")
                                            } />
                                    </td>
                                </tr>
                            ))}
                        </tbody>
                    </table>
                    <p className="mt-2 text-xs text-muted-foreground">
                        {t("reports.failHint")}
                    </p>
                </div>
            ) : null}
            {overview && overview.reports.length > 0 ? (
                <details className="text-[0.8125rem]">
                    <summary className="cursor-pointer text-muted-foreground">
                        {t("reports.inRange", { count: overview.reports.length })}
                    </summary>
                    <ul className="mt-2 flex flex-col divide-y divide-border">
                        {overview.reports.map((report) => (
                            <li key={report.id} className="flex flex-wrap items-center gap-2 py-1.5">
                                <span className="text-foreground">{report.orgName}</span>
                                <span className="text-muted-foreground">{report.domain}</span>
                                <span className="text-xs text-foreground-subtle">
                                    {format.date(report.beginAt)} - {format.date(report.endAt)}
                                </span>
                                <span className="ml-auto text-xs text-muted-foreground">
                                    {t("reports.reportLine", { messages: report.messages, failed: report.failed })}
                                </span>
                            </li>
                        ))}
                    </ul>
                </details>
            ) : null}
        </div>
    );
}
