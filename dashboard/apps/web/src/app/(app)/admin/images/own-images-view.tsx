"use client";

/**
 * Polaris's own images, one row each with the newest scan's counts; a row
 * opens its findings, and "Scan again" queues that image. A link with
 * `?scan=<id>` (an alert's) opens that image's findings straight away.
 */

import * as actions from "./actions";
import { Loader2, Package } from "lucide-react";
import { useSearchParams } from "next/navigation";
import { useCallback, useEffect, useState } from "react";
import { useTranslations } from "@/components/i18n/i18n-provider";
import { Button, Card, CardBody, EmptyState, Skeleton } from "@polaris/ui";
import type { ImageFindingRow, OwnImage } from "@/lib/security/image-findings";
import {
    ImageScanFindings,
    imageScanErrorKey,
    ScanWhen,
    scanBusy,
    SeverityCounts
} from "@/components/security/image-scan";

type Findings = { scanId: string; rows: ImageFindingRow[] | null; failed: boolean };

export function OwnImagesView() {
    const t = useTranslations("imageScans");
    const admin = useTranslations("admin");
    const linked = useSearchParams()?.get("scan") ?? null;
    const [images, setImages] = useState<OwnImage[] | null>(null);
    const [failed, setFailed] = useState(false);
    const [open, setOpen] = useState<string | null>(null);
    const [findings, setFindings] = useState<Findings | null>(null);
    const [pending, setPending] = useState<string | null>(null);
    const [message, setMessage] = useState<{ text: string; error: boolean } | null>(null);

    const load = useCallback(async () => {
        const result = await actions.ownImagesAction().catch(() => ({ error: "failed" }) as const);
        if ("error" in result) return setFailed(true);
        setFailed(false);
        setImages(result.images);
    }, []);

    const readFindings = useCallback(async (scanId: string) => {
        setFindings({ scanId, rows: null, failed: false });
        const result = await actions
            .ownImageFindingsAction(scanId)
            .catch(() => ({ error: "failed" }) as const);
        setFindings(
            "error" in result
                ? { scanId, rows: [], failed: true }
                : { scanId, rows: result.findings, failed: false }
        );
    }, []);

    useEffect(() => {
        void load();
    }, [load]);

    // The image an alert linked to opens once the list has arrived.
    useEffect(() => {
        if (!images || !linked) return;
        const image = images.find((row) => row.scan.id === linked);
        if (!image) return;
        setOpen(image.ref);
        if (image.scan.state === "done") void readFindings(image.scan.id);
    }, [images, linked, readFindings]);

    const busy = images?.some((image) => scanBusy(image.scan));
    useEffect(() => {
        if (!busy) return;
        const timer = setInterval(() => void load(), 8000);
        return () => clearInterval(timer);
    }, [busy, load]);

    async function scanAgain(image: OwnImage) {
        setPending(image.ref);
        setMessage(null);
        const result = await actions
            .scanOwnImageAction(image.scan.id)
            .catch(() => ({ error: "failed" }) as const);
        setPending(null);
        if ("error" in result) {
            setMessage({ text: t(imageScanErrorKey(result.error) as never), error: true });
            return;
        }
        setMessage({ text: t("queued"), error: false });
        await load();
    }

    function toggle(image: OwnImage) {
        if (open === image.ref) return setOpen(null);
        setOpen(image.ref);
        if (image.scan.state === "done") void readFindings(image.scan.id);
    }

    if (failed && !images) {
        return (
            <EmptyState
                icon={<Package />}
                title={t("failed")}
                action={<Button onClick={() => void load()}>{t("tryAgain")}</Button>}
            />
        );
    }
    if (images && images.length === 0) {
        return (
            <EmptyState
                icon={<Package />}
                title={admin("images.emptyTitle")}
                description={admin("images.emptyBody")}
            />
        );
    }

    return (
        <Card>
            <CardBody className="flex flex-col gap-1">
                {message && (
                    <p
                        className={`text-xs ${message.error ? "text-danger-ink" : "text-muted-foreground"}`}
                        role="status"
                    >
                        {message.text}
                    </p>
                )}
                <ul className="flex flex-col">
                    {images === null
                        ? [0, 1, 2].map((row) => (
                              <li
                                  key={row}
                                  className="flex items-center gap-3 border-t border-border py-2 first:border-t-0"
                              >
                                  <Skeleton className="h-4 w-56 max-w-full" />
                                  <Skeleton className="ml-auto h-6 w-20" />
                              </li>
                          ))
                        : images.map((image) => {
                              const expanded = open === image.ref;
                              const shown = findings?.scanId === image.scan.id ? findings : null;
                              return (
                                  <li
                                      key={image.ref}
                                      className="flex flex-col gap-2 border-t border-border py-2 first:border-t-0"
                                  >
                                      <div className="flex min-w-0 flex-wrap items-center gap-x-3 gap-y-1">
                                          <div className="min-w-0 flex-1">
                                              <span
                                                  className="block truncate font-mono text-sm font-medium"
                                                  title={
                                                      image.imageId
                                                          ? `${image.ref}\n${image.imageId}`
                                                          : image.ref
                                                  }
                                              >
                                                  {image.ref}
                                              </span>
                                              <span
                                                  className="block truncate text-xs text-muted-foreground"
                                                  title={image.users.join(", ")}
                                              >
                                                  {image.users.length > 0
                                                      ? `${image.users.join(", ")} - `
                                                      : null}
                                                  <ScanWhen scan={image.scan} />
                                              </span>
                                          </div>
                                          {image.scan.state === "done" && (
                                              <SeverityCounts scan={image.scan} />
                                          )}
                                          <div className="ml-auto flex shrink-0 items-center gap-1">
                                              <Button
                                                  size="xs"
                                                  variant="ghost"
                                                  aria-expanded={expanded}
                                                  onClick={() => toggle(image)}
                                              >
                                                  {expanded ? t("hide") : t("details")}
                                              </Button>
                                              <Button
                                                  size="xs"
                                                  variant="outline"
                                                  disabled={
                                                      pending === image.ref || scanBusy(image.scan)
                                                  }
                                                  onClick={() => void scanAgain(image)}
                                              >
                                                  {pending === image.ref && (
                                                      <Loader2
                                                          className="size-3 animate-spin"
                                                          aria-hidden
                                                      />
                                                  )}
                                                  {t("scanAgain")}
                                              </Button>
                                          </div>
                                      </div>
                                      {expanded && (
                                          <ImageScanFindings
                                              scan={image.scan}
                                              findings={shown?.rows ?? null}
                                              failed={shown?.failed ?? false}
                                              onRetry={() => void readFindings(image.scan.id)}
                                          />
                                      )}
                                  </li>
                              );
                          })}
                </ul>
            </CardBody>
        </Card>
    );
}
