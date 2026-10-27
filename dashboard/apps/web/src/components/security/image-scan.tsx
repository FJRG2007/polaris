"use client";

/**
 * One image scan as every dashboard screen draws it - a Deploy service's
 * Vulnerabilities tab and Management > Polaris images: the severity counts,
 * when it ran, and its findings in the shared vulnerability table, or the
 * sentence for a scan that has not finished. Words from the `imageScans`
 * namespace, which the page around it hands down.
 */

import { relativeTime } from "@/lib/relative-time";
import { useDisplayFormat } from "@/components/display-format";
import { useTranslations } from "@/components/i18n/i18n-provider";
import type { Counted, ImageFindingRow, ImageScanView } from "@/lib/security/image-findings";
import { Badge, TagList, VulnerabilityTable, type VulnerabilityTableLabels } from "@polaris/ui";

const COUNTED = ["critical", "high", "medium", "low"] as const satisfies readonly Counted[];
const ERRORS = new Set([
    "failed",
    "notFound",
    "notRunning",
    "noApp",
    "scanError",
    "scannerFailed",
    "reportUnreadable",
    "lost",
    "timeout",
    "imageMissing",
    "noRoom",
    "daemonOutdated",
    "noDaemon"
]);

/** The message key for a scan's or an action's error; anything unknown is generic. Pure. */
export function imageScanErrorKey(error: string | null | undefined): string {
    return error && ERRORS.has(error) ? `errors.${error}` : "errors.failed";
}

/** Whether a scan is still waiting or running. Pure. */
export function scanBusy(scan: ImageScanView | null | undefined): boolean {
    return scan?.state === "queued" || scan?.state === "running";
}

export function useImageScanLabels(): VulnerabilityTableLabels {
    const t = useTranslations("imageScans");
    return {
        failed: t("failed"),
        tryAgain: t("tryAgain"),
        none: t("none"),
        filters: t("filters"),
        fixedOnly: t("fixedOnly"),
        vulnerability: t("vulnerability"),
        severity: t("severity"),
        package: t("package"),
        fix: t("fix"),
        layer: t("layer"),
        noMatch: t("noMatch"),
        noFix: t("noFix"),
        severityName: (severity) => t(`level.${severity}` as never),
        openAdvisory: (id) => t("openAdvisory", { id })
    };
}

/** A finished scan's counts as chips; "No known vulnerabilities" when all are zero. */
export function SeverityCounts({ scan }: { scan: ImageScanView }) {
    const t = useTranslations("imageScans");
    const found = COUNTED.filter((severity) => scan.counts[severity] > 0);
    return (
        <TagList>
            {found.map((severity) => (
                <Badge
                    key={severity}
                    variant={
                        severity === "medium"
                            ? "warning"
                            : severity === "low"
                              ? "neutral"
                              : "danger"
                    }
                >
                    {t(`level.${severity}`)} {scan.counts[severity]}
                </Badge>
            ))}
            {found.length === 0 ? <Badge variant="success">{t("clean")}</Badge> : null}
        </TagList>
    );
}

/** When a scan ran, or where it is, in one short line. */
export function ScanWhen({ scan }: { scan: ImageScanView }) {
    const t = useTranslations("imageScans");
    const format = useDisplayFormat();
    if (scan.state === "queued") return <>{t("waiting")}</>;
    if (scan.state === "running") return <>{t("scanning")}</>;
    return <>{t("scannedAt", { when: relativeTime(scan.finishedAt ?? scan.createdAt, format) })}</>;
}

/**
 * A scan's findings, or what stands in for them: nothing scanned yet, a scan
 * still going, a scan that failed. `findings` is null while being read.
 */
export function ImageScanFindings({
    scan,
    findings,
    failed = false,
    loading = false,
    onRetry,
    notYet
}: {
    scan: ImageScanView | null;
    findings: readonly ImageFindingRow[] | null;
    failed?: boolean;
    /** The scan itself is still being read: rows shaped like the table. */
    loading?: boolean;
    onRetry?: () => void;
    /** The sentence for an image nobody scanned yet. */
    notYet?: string;
}) {
    const t = useTranslations("imageScans");
    const labels = useImageScanLabels();
    if (failed) {
        return <VulnerabilityTable labels={labels} findings={[]} failed onRetry={onRetry} />;
    }
    if (loading) return <VulnerabilityTable labels={labels} findings={null} />;
    if (!scan) return <p className="text-xs text-muted-foreground">{notYet ?? t("notYet")}</p>;
    if (scan.state === "queued" || scan.state === "running") {
        return (
            <p className="text-xs text-muted-foreground">
                <ScanWhen scan={scan} />
            </p>
        );
    }
    if (scan.state === "failed") {
        return (
            <p className="text-xs text-danger-ink">{t(imageScanErrorKey(scan.error) as never)}</p>
        );
    }
    return <VulnerabilityTable labels={labels} findings={findings} />;
}
