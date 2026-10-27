"use client";

/**
 * The scan an alert is about, opened on its own above the tabs: what was
 * scanned and on which server, the outcome in one line, what to do about it,
 * and its findings opened on the advisories the alert announced, marked new,
 * with a switch to show the rest. With no scan in the link it shows the newest
 * scan that has a critical or high finding no newer scan of the same app or
 * image has replaced, folded, so the bare page - and every alert from before
 * links named a scan - still opens on what needs attention.
 */

import { X } from "lucide-react";
import * as subjects from "../model/subjects";
import * as actions from "../actions/security";
import type { Landing } from "../model/landing";
import type { SecurityTranslator } from "../lib/i18n";
import { useCallback, useEffect, useState } from "react";
import { FindingsTable, type ImageFinding } from "./findings-table";
import { Badge, Button, Card, CardBody, CopyButton, Skeleton } from "@polaris/ui";

type Focus = NonNullable<
    Extract<Awaited<ReturnType<typeof actions.focusAction>>, { ok: true }>["data"]
>;
type Submit = (
    work: () => Promise<{ ok: boolean; error?: string }>,
    done?: string
) => Promise<void>;

/** The outcome in one line: "13 issues (Critical 1, High 12). 12 of them are fixed in a newer version." */
export function verdictLine(t: SecurityTranslator, verdict: subjects.Verdict): string {
    const issues = t("verdict.issues", { count: verdict.total });
    const parts = verdict.parts
        .map((part) => `${t(`images.severity.${part.severity}`)} ${part.count}`)
        .join(", ");
    const head = parts ? `${issues} (${parts}).` : `${issues}.`;
    if (verdict.fixable === null || verdict.parts.length === 0) return head;
    const serious = verdict.parts.reduce((sum, part) => sum + part.count, 0);
    const fix =
        verdict.fixable === 0
            ? t("verdict.fixNone")
            : verdict.fixable >= serious
              ? t("verdict.fixAll")
              : t("verdict.fixSome", { count: verdict.fixable });
    return `${head} ${fix}`;
}

/** What to do next, in a sentence, or null when there is nothing to do. */
export function nextLine(
    t: SecurityTranslator,
    focus: Pick<Focus, "subject" | "name" | "source">,
    step: subjects.NextStep
): string | null {
    if (step === "none") return null;
    if (step === "wait") return t("next.wait");
    if (focus.subject === "deps") return t("next.updateDeps");
    if (focus.subject === "appImage") return t("next.updateApp", { app: focus.name });
    if (focus.source === "polaris") return t("next.updatePolaris");
    return t("next.updateImage");
}

export function FocusCard({
    t,
    landing,
    onTarget,
    onClose,
    submit
}: {
    t: SecurityTranslator;
    landing: Landing;
    /** Called once with the scan's server, so the page below shows that one. */
    onTarget: (targetId: string) => void;
    onClose: () => void;
    submit: Submit;
}) {
    const fromAlert = landing.scan !== null;
    // undefined: reading; null: nothing to show.
    const [focus, setFocus] = useState<Focus | null | undefined>(undefined);
    const [failed, setFailed] = useState(false);
    const [open, setOpen] = useState(fromAlert);
    const [findings, setFindings] = useState<ImageFinding[] | null>(null);
    const [findingsFailed, setFindingsFailed] = useState(false);
    // The scan shown: the alert's, until "Scan again" queues a newer one.
    const [shown, setShown] = useState(landing.scan);

    const load = useCallback(async () => {
        const result = await actions.focusAction({ scanId: shown });
        if (!result.ok) return setFailed(true);
        setFailed(false);
        setFocus(result.data);
    }, [shown]);
    useEffect(() => {
        void load();
    }, [load]);

    const targetId = focus?.targetId;
    useEffect(() => {
        if (targetId) onTarget(targetId);
        // Once per scan: choosing another server afterwards is the reader's call.
        // eslint-disable-next-line react-hooks/exhaustive-deps
    }, [targetId]);

    const busy = focus?.state === "queued" || focus?.state === "running";
    useEffect(() => {
        if (!busy) return;
        const timer = setInterval(() => void load(), 5000);
        return () => clearInterval(timer);
    }, [busy, load]);

    const scanId = focus?.id;
    const done = focus?.state === "done";
    const readFindings = useCallback(async () => {
        if (!scanId) return;
        setFindings(null);
        setFindingsFailed(false);
        const result = await actions.findingsAction({ scanId });
        if (!result.ok) return setFindingsFailed(true);
        setFindings(result.data);
    }, [scanId]);
    useEffect(() => {
        if (done && (open || fromAlert)) void readFindings();
        // eslint-disable-next-line react-hooks/exhaustive-deps
    }, [done, scanId]);

    if (failed && focus === undefined) {
        return (
            <Card>
                <CardBody className="flex flex-wrap items-center justify-between gap-2 text-sm">
                    <span className="text-danger">{t("focus.loadFailed")}</span>
                    <Button size="sm" variant="outline" onClick={() => void load()}>
                        {t("tryAgain")}
                    </Button>
                </CardBody>
            </Card>
        );
    }
    if (focus === undefined) {
        // Only an alert's link reserves the room; the bare page waits on nothing.
        return fromAlert ? (
            <Card>
                <CardBody className="flex flex-col gap-2" aria-busy>
                    <Skeleton className="h-5 w-64 max-w-full" />
                    <Skeleton className="h-4 w-80 max-w-full" />
                    <Skeleton className="h-24 w-full" />
                </CardBody>
            </Card>
        ) : null;
    }
    if (focus === null) {
        return fromAlert ? (
            <p role="status" className="rounded-md bg-muted px-3 py-2 text-sm">
                {t("focus.gone")}
            </p>
        ) : null;
    }

    const verdict = subjects.verdictOf(focus.summary, findings);
    const next = done ? nextLine(t, focus, subjects.nextStep(verdict)) : null;
    const queue =
        focus.imageId !== null
            ? () =>
                  actions.scanServerImageAction({
                      targetId: focus.targetId,
                      imageId: focus.imageId
                  })
            : focus.kind === "image" && focus.applicationId && !focus.appGone
              ? () =>
                    actions.scanImageAction({
                        targetId: focus.targetId,
                        applicationId: focus.applicationId
                    })
              : null;
    const rescan = queue
        ? async () => {
              const result = await queue();
              if (result.ok) setShown(result.data);
              return result;
          }
        : null;

    return (
        <Card>
            <CardBody className="flex flex-col gap-3">
                <div className="flex min-w-0 items-start justify-between gap-2">
                    <div className="min-w-0">
                        <p className="text-xs font-medium uppercase text-muted-foreground">
                            {fromAlert ? t("focus.fromAlert") : t("focus.attention")}
                        </p>
                        <h2 className="flex min-w-0 flex-wrap items-center gap-2 text-base font-semibold">
                            <span className="min-w-0 truncate" title={focus.name}>
                                {focus.name}
                            </span>
                            <Badge variant="neutral">{t(`focus.kind.${focus.subject}`)}</Badge>
                        </h2>
                        <p className="text-sm text-muted-foreground">
                            {t("focus.onServer", {
                                server: focus.serverLocal
                                    ? `${focus.serverName} (${t("thisServer")})`
                                    : focus.serverName
                            })}
                            {" - "}
                            {t("focus.scannedAt", {
                                when: new Date(focus.finishedAt ?? focus.createdAt).toLocaleString()
                            })}
                        </p>
                    </div>
                    <Button
                        size="icon"
                        variant="ghost"
                        aria-label={t("focus.close")}
                        title={t("focus.close")}
                        onClick={onClose}
                    >
                        <X className="size-4 shrink-0" aria-hidden />
                    </Button>
                </div>

                {done ? (
                    <div className="flex flex-col gap-1 text-sm">
                        <p className="font-medium">{verdictLine(t, verdict)}</p>
                        {next ? <p className="text-muted-foreground">{next}</p> : null}
                    </div>
                ) : busy ? (
                    <p className="text-sm text-muted-foreground">{t("focus.running")}</p>
                ) : (
                    <p className="text-sm text-danger">
                        {focus.error ? t(`errors.${focus.error}` as never) : t("state.failed")}
                    </p>
                )}
                {focus.appGone ? (
                    <p className="text-sm text-muted-foreground">{t("focus.appGone")}</p>
                ) : null}

                <div className="flex flex-wrap items-center gap-2">
                    {focus.appHref ? (
                        <Button asChild size="sm">
                            <a href={focus.appHref}>{t("focus.openApp")}</a>
                        </Button>
                    ) : null}
                    {focus.ownHref ? (
                        <Button asChild size="sm">
                            <a href={focus.ownHref}>{t("focus.openOwn")}</a>
                        </Button>
                    ) : null}
                    {rescan ? (
                        <Button
                            size="sm"
                            variant="outline"
                            disabled={busy}
                            onClick={() => void submit(rescan, t("queued"))}
                        >
                            {t("focus.rescan")}
                        </Button>
                    ) : null}
                    {focus.sbom ? (
                        <Button asChild size="sm" variant="ghost">
                            <a href={`/api/security/sbom/${focus.id}`}>{t("images.download")}</a>
                        </Button>
                    ) : null}
                    {done && !open ? (
                        <Button
                            size="sm"
                            variant="ghost"
                            onClick={() => {
                                setOpen(true);
                                if (findings === null) void readFindings();
                            }}
                        >
                            {t("focus.showFindings")}
                        </Button>
                    ) : null}
                    {done && open && !fromAlert ? (
                        <Button size="sm" variant="ghost" onClick={() => setOpen(false)}>
                            {t("hide")}
                        </Button>
                    ) : null}
                </div>

                {done && open ? (
                    <FindingsTable
                        t={t}
                        findings={findings}
                        failed={findingsFailed}
                        onRetry={() => void readFindings()}
                        showLayer={focus.kind === "image"}
                        highlight={landing.ids}
                    />
                ) : null}

                {focus.imageRef || focus.id ? (
                    <details className="text-sm">
                        <summary className="cursor-pointer text-muted-foreground">
                            {t("focus.technical")}
                        </summary>
                        <dl className="mt-2 grid grid-cols-[auto_minmax(0,1fr)] gap-x-3 gap-y-1">
                            {focus.imageRef ? (
                                <>
                                    <dt className="text-muted-foreground">{t("focus.imageRef")}</dt>
                                    <dd className="flex min-w-0 items-center gap-1">
                                        <span
                                            className="truncate font-mono text-xs"
                                            title={focus.imageRef}
                                        >
                                            {focus.imageRef}
                                        </span>
                                        <CopyButton value={focus.imageRef} label={focus.imageRef} />
                                    </dd>
                                </>
                            ) : null}
                            <dt className="text-muted-foreground">{t("focus.scanId")}</dt>
                            <dd className="flex min-w-0 items-center gap-1">
                                <span className="truncate font-mono text-xs" title={focus.id}>
                                    {focus.id}
                                </span>
                                <CopyButton value={focus.id} label={focus.id} />
                            </dd>
                        </dl>
                    </details>
                ) : null}
            </CardBody>
        </Card>
    );
}
