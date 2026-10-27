"use client";

/**
 * What the scans found in the image a service runs now: the counts, when it
 * was scanned, every finding with its fix, and "Scan now" for whoever may
 * deploy it. Polls while a scan is waiting or running; a failed read offers to
 * try again.
 */

import { Button } from "@polaris/ui";
import { Loader2 } from "lucide-react";
import { useProjectCan } from "./access-context";
import { useCallback, useEffect, useState } from "react";
import { useTranslations } from "@/components/i18n/i18n-provider";
import type { ImageFindingRow, ImageScanView } from "@/lib/security/image-findings";
import { scanServiceImageAction, serviceImageFindingsAction } from "./image-scan-actions";
import {
    ImageScanFindings,
    imageScanErrorKey,
    ScanWhen,
    scanBusy,
    SeverityCounts
} from "@/components/security/image-scan";

type Loaded =
    | { status: "loading" }
    | { status: "failed" }
    | {
          status: "ready";
          image: string | null;
          scan: ImageScanView | null;
          findings: ImageFindingRow[];
      };

export function ImageVulnerabilitiesPanel({ applicationId }: { applicationId: string }) {
    const t = useTranslations("imageScans");
    const can = useProjectCan();
    const [loaded, setLoaded] = useState<Loaded>({ status: "loading" });
    const [pending, setPending] = useState(false);
    const [message, setMessage] = useState<{ text: string; error: boolean } | null>(null);

    const read = useCallback(
        async (quiet = false) => {
            if (!quiet) setLoaded({ status: "loading" });
            const result = await serviceImageFindingsAction(applicationId).catch(
                () => ({ error: "failed" }) as const
            );
            if ("error" in result) {
                if (!quiet) setLoaded({ status: "failed" });
                return;
            }
            setLoaded({ status: "ready", ...result });
        },
        [applicationId]
    );

    useEffect(() => {
        void read();
    }, [read]);

    const scan = loaded.status === "ready" ? loaded.scan : null;
    const busy = scanBusy(scan);
    useEffect(() => {
        if (!busy) return;
        const timer = setInterval(() => void read(true), 8000);
        return () => clearInterval(timer);
    }, [busy, read]);

    async function scanNow() {
        setPending(true);
        setMessage(null);
        const result = await scanServiceImageAction(applicationId).catch(
            () => ({ error: "failed" }) as const
        );
        setPending(false);
        if ("error" in result) {
            setMessage({ text: t(imageScanErrorKey(result.error) as never), error: true });
            return;
        }
        setMessage({ text: t("queued"), error: false });
        await read(true);
    }

    const image = loaded.status === "ready" ? loaded.image : null;
    const mayScan = can("deploy.run");
    return (
        <section className="flex flex-col gap-2" aria-label={t("title")}>
            <div className="flex min-w-0 flex-wrap items-center gap-x-2 gap-y-1">
                <h3 className="text-xs font-semibold uppercase tracking-wide text-muted-foreground">
                    {t("title")}
                </h3>
                {image && (
                    <span
                        className="min-w-0 flex-1 truncate font-mono text-xs text-muted-foreground"
                        title={image}
                    >
                        {image}
                    </span>
                )}
                {loaded.status === "ready" && (
                    <Button
                        size="xs"
                        variant="outline"
                        className="ml-auto shrink-0"
                        disabled={!mayScan || pending || busy || !image}
                        title={
                            !mayScan ? t("noScanRight") : !image ? t("notRunningHint") : undefined
                        }
                        onClick={() => void scanNow()}
                    >
                        {pending && <Loader2 className="size-3 animate-spin" aria-hidden />}
                        {scan ? t("scanAgain") : t("scanNow")}
                    </Button>
                )}
            </div>
            {scan?.state === "done" && (
                <div className="flex min-w-0 flex-wrap items-center gap-2 text-xs text-muted-foreground">
                    <SeverityCounts scan={scan} />
                    <span>
                        <ScanWhen scan={scan} />
                    </span>
                </div>
            )}
            {message && (
                <p
                    className={`text-xs ${message.error ? "text-danger-ink" : "text-muted-foreground"}`}
                    role="status"
                >
                    {message.text}
                </p>
            )}
            <ImageScanFindings
                scan={scan}
                findings={loaded.status === "ready" ? loaded.findings : null}
                failed={loaded.status === "failed"}
                loading={loaded.status === "loading"}
                onRetry={() => void read()}
                notYet={image ? t("notYet") : t("notRunningHint")}
            />
        </section>
    );
}
