"use client";

/**
 * A service's dependencies, Dependabot-style: what the latest scan of the
 * lockfiles its deploys copied out found, in the same table the image scans
 * use - sortable, filtered by severity and by whether a fix exists. Loading
 * draws rows shaped like the table; a failed read offers to try again.
 */

import { relativeTime } from "@/lib/relative-time";
import { useCallback, useEffect, useState } from "react";
import { useLiveRead } from "@/components/use-live-resource";
import { useDisplayFormat } from "@/components/display-format";
import { serviceDependenciesAction } from "./dependency-actions";
import { useTranslations } from "@/components/i18n/i18n-provider";
import { VulnerabilityTable, type VulnerabilityTableLabels } from "@polaris/ui";
import type { DependencyFinding, DependencyScanView } from "@/lib/security/dependency-findings";

type Loaded =
    | { status: "loading" }
    | { status: "failed" }
    | { status: "ready"; scan: DependencyScanView | null; findings: DependencyFinding[] };

export function DependenciesPanel({ applicationId }: { applicationId: string }) {
    const t = useTranslations("deployService");
    const format = useDisplayFormat();
    const [busy, setBusy] = useState(false);

    // Read through the shared live read, so two tabs on this service ask once
    // between them while a scan is running, and a tab that comes back to it
    // paints the last table it showed straight away.
    const load = useCallback(async () => {
        const result = await serviceDependenciesAction(applicationId).catch(() => ({
            error: "failed"
        }));
        if ("error" in result && result.error) throw new Error("failed");
        const ok = result as {
            scan?: DependencyScanView | null;
            findings?: DependencyFinding[];
        };
        return { scan: ok.scan ?? null, findings: ok.findings ?? [] };
    }, [applicationId]);
    const live = useLiveRead({
        load,
        cacheKey: `deploy-dependencies:${applicationId}`,
        intervalMs: 8000,
        // Polled only while a scan is waiting or running, as before.
        paused: !busy
    });
    // A failed read over a table already on screen keeps the table; a retry
    // over nothing shows the skeleton again until it answers.
    // A kept copy whose first read failed is a failed first read: the panel
    // renders what it rendered before there was a kept copy at all.
    const firstFailed = live.kept && live.stale !== null;
    const loaded: Loaded =
        live.data && !firstFailed
            ? { status: "ready", ...live.data }
            : (live.error !== null || firstFailed) && !live.refreshing
              ? { status: "failed" }
              : { status: "loading" };
    const read = live.refresh;

    const scanning =
        loaded.status === "ready" &&
        (loaded.scan?.state === "queued" || loaded.scan?.state === "running");
    useEffect(() => {
        setBusy(scanning);
    }, [scanning]);

    const labels: VulnerabilityTableLabels = {
        failed: t("dependencies.failed"),
        tryAgain: t("dependencies.tryAgain"),
        none: t("dependencies.none"),
        filters: t("dependencies.filters"),
        fixedOnly: t("dependencies.fixedOnly"),
        vulnerability: t("dependencies.vulnerability"),
        severity: t("dependencies.severity"),
        package: t("dependencies.package"),
        fix: t("dependencies.fix"),
        layer: t("dependencies.package"),
        noMatch: t("dependencies.noMatch"),
        noFix: t("dependencies.noFix"),
        severityName: (severity) => t(`dependencies.level.${severity}` as never),
        openAdvisory: (id) => t("dependencies.openAdvisory", { id })
    };

    const scan = loaded.status === "ready" ? loaded.scan : null;
    let body;
    if (loaded.status === "failed") {
        body = (
            <VulnerabilityTable
                labels={labels}
                findings={[]}
                failed
                onRetry={() => void read()}
                showLayer={false}
            />
        );
    } else if (loaded.status === "loading") {
        body = <VulnerabilityTable labels={labels} findings={null} showLayer={false} />;
    } else if (!scan) {
        body = <p className="text-xs text-muted-foreground">{t("dependencies.notYet")}</p>;
    } else if (scan.state === "queued" || scan.state === "running") {
        body = <p className="text-xs text-muted-foreground">{t("dependencies.checking")}</p>;
    } else if (scan.state === "failed") {
        body = <p className="text-xs text-danger-ink">{t("dependencies.scanFailed")}</p>;
    } else {
        body = <VulnerabilityTable labels={labels} findings={loaded.findings} showLayer={false} />;
    }

    return (
        <section className="flex flex-col gap-2" aria-label={t("dependencies.title")}>
            <div className="flex min-w-0 flex-wrap items-baseline gap-x-2 gap-y-0.5">
                <h3 className="text-xs font-semibold uppercase tracking-wide text-muted-foreground">
                    {t("dependencies.title")}
                </h3>
                {scan?.state === "done" && (
                    <span
                        className="min-w-0 truncate text-xs text-muted-foreground"
                        title={scan.files.join(", ")}
                    >
                        {t("dependencies.readFrom", {
                            files: scan.files.slice(0, 4).join(", "),
                            when: relativeTime(scan.finishedAt ?? scan.createdAt, format)
                        })}
                        {scan.commitSha ? ` - ${scan.commitSha.slice(0, 7)}` : ""}
                    </span>
                )}
            </div>
            {body}
        </section>
    );
}
