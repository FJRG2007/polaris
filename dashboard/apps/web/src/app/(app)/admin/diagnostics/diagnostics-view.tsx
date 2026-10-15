"use client";

/**
 * The Diagnostics screen: checks, speed test, support bundle.
 *
 * Every check row paints at once with its name and a placeholder, and each
 * asks for its own answer, so a slow certificate probe never holds the disk
 * reading. The bundle's contents are read on paint too, so the reader sees
 * what the archive holds before they download it, and the download itself is
 * fetched here so a refusal reads as a sentence rather than a broken file.
 */

import { Download, Gauge, RefreshCw } from "lucide-react";
import { RelativeTime } from "@/components/relative-time";
import { runFixAction, runSpeedTestAction } from "./actions";
import type { SpeedResult } from "@/lib/diagnostics/speed-test";
import { useCallback, useEffect, useRef, useState } from "react";
import { useTranslations } from "@/components/i18n/i18n-provider";
import type { CheckId, CheckResult, CheckStatus } from "@/lib/diagnostics/checks";
import { Badge, Button, Card, CardBody, CardHeader, CardTitle, Skeleton } from "@polaris/ui";

type Translator = ReturnType<typeof useTranslations<"diagnostics">>;
type Key = Parameters<Translator>[0];

const BADGE: Record<CheckStatus, "success" | "warning" | "danger" | "neutral"> = {
    pass: "success",
    warn: "warning",
    fail: "danger",
    unknown: "neutral",
    skip: "neutral"
};

const LINK_LABEL: Partial<Record<string, Key>> = {
    "/admin/settings": "fix.openSettings",
    "/admin/domains": "fix.openDomains"
};

const BUNDLE_FILES: ReadonlyArray<{ name: string; key: Key }> = [
    { name: "manifest.json", key: "bundle.files.manifest" },
    { name: "diagnosis.json", key: "bundle.files.diagnosis" },
    { name: "errors.json", key: "bundle.files.errors" },
    { name: "config.json", key: "bundle.files.config" },
    { name: "speed-test.json", key: "bundle.files.speed" }
];

/** A check that could not be asked at all - a dropped request, a 500. */
function failedCheck(id: CheckId): CheckResult {
    return { id, status: "unknown", code: "failedToRun", facts: {}, fix: null, ms: 0 };
}

function sentence(t: Translator, check: CheckResult): string {
    if (check.code === "timeout") return t("status.timeout");
    if (check.code === "failedToRun") return t("status.failedToRun");
    const key = `checks.${check.id}.${check.code}` as Key;
    return t.has(key) ? t(key, check.facts as never) : t("status.failedToRun");
}

function CheckRow({
    id,
    check,
    busy,
    onFix
}: {
    id: CheckId;
    check: CheckResult | null;
    busy: boolean;
    onFix: (check: CheckResult) => void;
}) {
    const t = useTranslations("diagnostics");
    const fix = check?.fix ?? null;
    const linkLabel = fix?.kind === "link" ? LINK_LABEL[fix.href] : undefined;
    return (
        <li className="flex flex-wrap items-center gap-x-3 gap-y-2 px-4 py-3">
            <div className="flex min-w-0 flex-1 flex-col gap-0.5">
                <span className="text-sm font-medium">{t(`checks.${id}.title` as Key)}</span>
                {check ? (
                    <span className="break-words text-xs text-muted-foreground">
                        {sentence(t, check)}
                    </span>
                ) : (
                    <Skeleton className="h-3.5 w-48 max-w-full" />
                )}
            </div>
            {fix?.kind === "action" ? (
                <Button
                    size="sm"
                    variant="outline"
                    disabled={busy}
                    onClick={() => check && onFix(check)}
                >
                    {t(`fix.${fix.action}` as Key)}
                </Button>
            ) : null}
            {fix?.kind === "link" && linkLabel ? (
                <Button size="sm" variant="outline" asChild>
                    <a href={fix.href}>{t(linkLabel)}</a>
                </Button>
            ) : null}
            {check ? (
                <Badge variant={BADGE[check.status]}>{t(`status.${check.status}` as Key)}</Badge>
            ) : (
                <Skeleton className="h-5 w-14" />
            )}
        </li>
    );
}

function ChecksCard({ ids }: { ids: CheckId[] }) {
    const t = useTranslations("diagnostics");
    const [results, setResults] = useState<Partial<Record<CheckId, CheckResult>>>({});
    const [fixing, setFixing] = useState(false);
    const [note, setNote] = useState<{ ok: boolean } | null>(null);
    const round = useRef(0);

    const runAll = useCallback(() => {
        const mine = ++round.current;
        setResults({});
        setNote(null);
        for (const id of ids) {
            fetch(`/api/admin/diagnostics/check?id=${id}`, { cache: "no-store" })
                .then((response) =>
                    response.ok ? (response.json() as Promise<CheckResult>) : failedCheck(id)
                )
                .catch(() => failedCheck(id))
                .then((result) => {
                    if (round.current === mine)
                        setResults((current) => ({ ...current, [id]: result }));
                });
        }
    }, [ids]);

    useEffect(runAll, [runAll]);

    const fix = async (check: CheckResult) => {
        if (check.fix?.kind !== "action") return;
        setFixing(true);
        setNote(null);
        try {
            const outcome = await runFixAction(check.fix.action);
            if (outcome.check) setResults((current) => ({ ...current, [check.id]: outcome.check }));
            setNote({ ok: outcome.ok });
        } catch {
            setNote({ ok: false });
        } finally {
            setFixing(false);
        }
    };

    const done = ids.every((id) => results[id]);
    const count = (status: CheckStatus) =>
        ids.filter((id) => results[id]?.status === status).length;

    return (
        <Card>
            <CardHeader className="flex-row flex-wrap items-center justify-between gap-2">
                <div className="flex min-w-0 flex-col gap-0.5">
                    <CardTitle>{t("checks.heading")}</CardTitle>
                    {done ? (
                        <span className="text-xs text-muted-foreground">
                            {t("checks.summary", { fail: count("fail"), warn: count("warn") })}
                        </span>
                    ) : (
                        <Skeleton className="h-3.5 w-36" />
                    )}
                </div>
                <Button size="sm" variant="outline" onClick={runAll} disabled={!done || fixing}>
                    <RefreshCw />
                    {t("checks.runAll")}
                </Button>
            </CardHeader>
            <CardBody className="p-0">
                {note ? (
                    <p
                        className={`px-4 pt-3 text-sm ${note.ok ? "text-success" : "text-danger"}`}
                        role="status"
                    >
                        {t(note.ok ? "fix.done" : "fix.failed")}
                    </p>
                ) : null}
                <ul className="divide-y divide-border">
                    {ids.map((id) => (
                        <CheckRow
                            key={id}
                            id={id}
                            check={results[id] ?? null}
                            busy={fixing}
                            onFix={fix}
                        />
                    ))}
                </ul>
            </CardBody>
        </Card>
    );
}

function SpeedCard({ initial }: { initial: SpeedResult | null }) {
    const t = useTranslations("diagnostics");
    const [result, setResult] = useState(initial);
    const [running, setRunning] = useState(false);
    const [error, setError] = useState<string | null>(null);

    const run = async () => {
        setRunning(true);
        setError(null);
        try {
            const outcome = await runSpeedTestAction();
            if (outcome.ok) setResult(outcome.result);
            else if (outcome.reason === "busy") setError(t("speed.busy"));
            else
                setError(
                    t("speed.limited", {
                        minutes: Math.max(1, Math.ceil(outcome.retryAfterMs / 60_000))
                    })
                );
        } catch {
            setError(t("speed.failed"));
        } finally {
            setRunning(false);
        }
    };

    const figure = (value: number | null | undefined, key: "speed.mbps" | "speed.ms") =>
        value === null || value === undefined ? t("speed.none") : t(key, { value });

    const stats: Array<{ label: string; value: string }> = [
        { label: t("speed.download"), value: figure(result?.downloadMbps, "speed.mbps") },
        { label: t("speed.upload"), value: figure(result?.uploadMbps, "speed.mbps") },
        { label: t("speed.latency"), value: figure(result?.latencyMs, "speed.ms") }
    ];

    return (
        <Card>
            <CardHeader className="flex-row flex-wrap items-center justify-between gap-2">
                <div className="flex min-w-0 flex-1 flex-col gap-0.5">
                    <CardTitle>{t("speed.heading")}</CardTitle>
                    <span className="text-xs text-muted-foreground">{t("speed.description")}</span>
                </div>
                <Button size="sm" variant="outline" onClick={run} disabled={running}>
                    <Gauge />
                    {running ? t("speed.running") : t("speed.run")}
                </Button>
            </CardHeader>
            <CardBody className="flex flex-col gap-3">
                <dl className="grid grid-cols-3 gap-3">
                    {stats.map((stat) => (
                        <div key={stat.label} className="flex min-w-0 flex-col gap-0.5">
                            <dt
                                className="truncate text-xs text-muted-foreground"
                                title={stat.label}
                            >
                                {stat.label}
                            </dt>
                            <dd className="truncate text-sm font-medium tabular-nums">
                                {running ? <Skeleton className="h-4 w-16" /> : stat.value}
                            </dd>
                        </div>
                    ))}
                </dl>
                {error ? (
                    <p className="text-sm text-danger" role="status">
                        {error}
                    </p>
                ) : null}
                <p className="text-xs text-muted-foreground">
                    {result ? (
                        <>
                            {t("speed.lastRun")} <RelativeTime iso={result.at} />
                        </>
                    ) : (
                        t("speed.never")
                    )}
                </p>
            </CardBody>
        </Card>
    );
}

interface BundlePreview {
    readonly files: string[];
    readonly config: { values: Record<string, string>; withheld: string[] };
}

function BundleCard() {
    const t = useTranslations("diagnostics");
    const [preview, setPreview] = useState<BundlePreview | null>(null);
    const [failed, setFailed] = useState(false);
    const [downloading, setDownloading] = useState(false);
    const [downloadError, setDownloadError] = useState<string | null>(null);

    useEffect(() => {
        let live = true;
        fetch("/api/admin/diagnostics/bundle?preview=1", { cache: "no-store" })
            .then((response) =>
                response.ok ? (response.json() as Promise<BundlePreview>) : Promise.reject()
            )
            .then((data) => live && setPreview(data))
            .catch(() => live && setFailed(true));
        return () => {
            live = false;
        };
    }, []);

    const download = async () => {
        setDownloading(true);
        setDownloadError(null);
        try {
            const response = await fetch("/api/admin/diagnostics/bundle", { cache: "no-store" });
            if (response.status === 429) {
                const seconds = Number(response.headers.get("Retry-After")) || 60;
                setDownloadError(
                    t("bundle.limited", { minutes: Math.max(1, Math.ceil(seconds / 60)) })
                );
                return;
            }
            if (!response.ok) throw new Error(`bundle answered ${response.status}`);
            const name = /filename="([^"]+)"/.exec(
                response.headers.get("Content-Disposition") ?? ""
            )?.[1];
            const url = URL.createObjectURL(await response.blob());
            const anchor = document.createElement("a");
            anchor.href = url;
            anchor.download = name ?? "polaris-support.zip";
            anchor.click();
            setTimeout(() => URL.revokeObjectURL(url), 40_000);
        } catch {
            setDownloadError(t("bundle.failed"));
        } finally {
            setDownloading(false);
        }
    };

    return (
        <Card>
            <CardHeader className="flex-row flex-wrap items-center justify-between gap-2">
                <div className="flex min-w-0 flex-1 flex-col gap-0.5">
                    <CardTitle>{t("bundle.heading")}</CardTitle>
                    <span className="text-xs text-muted-foreground">{t("bundle.description")}</span>
                </div>
                <Button size="sm" onClick={download} disabled={downloading}>
                    <Download />
                    {downloading ? t("bundle.preparing") : t("bundle.download")}
                </Button>
            </CardHeader>
            <CardBody className="flex flex-col gap-3">
                {downloadError ? (
                    <p className="text-sm text-danger" role="status">
                        {downloadError}
                    </p>
                ) : null}
                <h3 className="text-xs font-medium uppercase text-muted-foreground">
                    {t("bundle.contents")}
                </h3>
                <ul className="flex flex-col gap-1">
                    {BUNDLE_FILES.map((file) => (
                        <li key={file.name} className="flex min-w-0 flex-wrap gap-x-2 text-sm">
                            <code className="text-xs">{file.name}</code>
                            <span className="min-w-0 text-muted-foreground">{t(file.key)}</span>
                        </li>
                    ))}
                </ul>
                {failed ? <p className="text-sm text-danger">{t("bundle.loadFailed")}</p> : null}
                {!preview && !failed ? (
                    <Skeleton className="h-16 w-full" aria-label={t("bundle.loading")} />
                ) : null}
                {preview ? (
                    <div className="flex flex-col gap-2">
                        <h3 className="text-xs font-medium text-muted-foreground">
                            {t("bundle.included")}
                        </h3>
                        <ul className="flex flex-col gap-0.5">
                            {Object.entries(preview.config.values).map(([key, value]) => (
                                <li key={key} className="flex min-w-0 gap-2 text-xs">
                                    <code className="shrink-0">{key}</code>
                                    <span
                                        className="min-w-0 truncate text-muted-foreground"
                                        title={value}
                                    >
                                        {value}
                                    </span>
                                </li>
                            ))}
                        </ul>
                        {preview.config.withheld.length > 0 ? (
                            <>
                                <h3 className="text-xs font-medium text-muted-foreground">
                                    {t("bundle.withheld")}
                                </h3>
                                <p className="break-words text-xs">
                                    <code>{preview.config.withheld.join(", ")}</code>
                                </p>
                            </>
                        ) : null}
                    </div>
                ) : null}
            </CardBody>
        </Card>
    );
}

export function DiagnosticsView({
    checks,
    initialSpeed
}: {
    checks: CheckId[];
    initialSpeed: SpeedResult | null;
}) {
    return (
        <div className="flex flex-col gap-4">
            <ChecksCard ids={checks} />
            <SpeedCard initial={initialSpeed} />
            <BundleCard />
        </div>
    );
}
