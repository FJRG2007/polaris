"use client";

import Link from "next/link";
import { useRouter } from "next/navigation";
import { ArrowLeft, ArrowUp, RotateCcw, Server, TriangleAlert } from "lucide-react";
import { Button } from "@polaris/ui";
import { useTranslations } from "@/components/i18n/i18n-provider";
import type { ListingFailure } from "./types";

/**
 * A folder that would not open.
 *
 * Drawn inside the listing region only: the breadcrumb, the toolbar and the
 * sources rail around it keep working, and the panel itself carries the way out
 * - up one folder when there is one, back to wherever the reader came from, and
 * the retry when asking again could answer differently. A refused folder used to
 * leave nothing on screen to press but the retry it does not offer.
 *
 * `detail` is the device's own words and comes back only for somebody who
 * administers this connection. It is folded away: it is the line to quote when
 * the sentence above it was not enough, not something to read first.
 */
export function ListingError({
    error,
    onRetry,
    upHref,
    serverHref
}: {
    error: ListingFailure;
    onRetry: () => void;
    /** The folder above this one, or null at the top of the source. */
    upHref: string | null;
    /** The server's page in Servers, for a refusal only root access would lift. */
    serverHref: string | null;
}) {
    const t = useTranslations("drive");
    const router = useRouter();
    return (
        <div
            role="alert"
            className="flex flex-col gap-3 rounded-lg border border-danger-edge bg-danger-soft p-4"
        >
            <div className="flex items-start gap-2.5">
                <TriangleAlert className="mt-0.5 size-4 shrink-0 text-danger" />
                <div className="min-w-0 flex-1">
                    <p className="text-sm font-medium text-danger">{error.reason}</p>
                    {error.hint ? (
                        <p className="mt-1 text-sm text-muted-foreground">{error.hint}</p>
                    ) : null}
                    {error.noRoot ? (
                        <p className="mt-1 text-sm text-muted-foreground">
                            {t("filesView.listingError.noRoot")}
                        </p>
                    ) : null}
                </div>
            </div>
            <div className="flex flex-wrap gap-2 pl-[1.625rem]">
                {upHref ? (
                    <Button size="sm" variant="secondary" asChild>
                        <Link href={upHref}>
                            <ArrowUp className="size-4" />
                            {t("filesView.listingError.up")}
                        </Link>
                    </Button>
                ) : null}
                <Button size="sm" variant="ghost" onClick={() => router.back()}>
                    <ArrowLeft className="size-4" />
                    {t("filesView.listingError.back")}
                </Button>
                {error.retryable ? (
                    <Button size="sm" variant="ghost" onClick={onRetry}>
                        <RotateCcw className="size-4" />
                        {t("filesView.retry")}
                    </Button>
                ) : null}
                {error.noRoot && serverHref ? (
                    <Button size="sm" variant="ghost" asChild>
                        <Link href={serverHref}>
                            <Server className="size-4" />
                            {t("filesView.listingError.openServer")}
                        </Link>
                    </Button>
                ) : null}
            </div>
            {error.detail ? (
                <details className="pl-[1.625rem] text-xs text-muted-foreground">
                    <summary className="cursor-pointer select-none">
                        {t("filesView.listingError.details")}
                    </summary>
                    <p className="mt-1 break-all font-mono">{error.detail}</p>
                </details>
            ) : null}
        </div>
    );
}
