"use client";

/**
 * Media auto-download, on this device: when photos, videos and documents of
 * recent messages are fetched ahead of time, how much space they may take, how
 * much they take now, and a way to empty it.
 */

import { formatBytes } from "@polaris/core";
import { useCallback, useEffect, useState } from "react";
import * as rules from "@/lib/chat/offline/media-download";
import { useTranslations } from "@/components/i18n/i18n-provider";
import { Button, Card, CardBody, CardHeader, CardTitle, Select } from "@polaris/ui";
import { clearMedia, mediaUsage, setMediaPrefs, useMediaPrefs } from "./media-download";

const KINDS: readonly rules.MediaKind[] = ["photos", "videos", "files"];
const WHEN: readonly rules.DownloadWhen[] = ["always", "wifi", "never"];

export function MediaDownloadCard() {
    const t = useTranslations("account");
    const prefs = useMediaPrefs();
    const [used, setUsed] = useState<number | null>(null);
    const [clearing, setClearing] = useState(false);

    const measure = useCallback(() => {
        void mediaUsage().then((usage) => setUsed(usage.bytes));
    }, []);
    useEffect(measure, [measure]);

    const clear = async (): Promise<void> => {
        setClearing(true);
        await clearMedia();
        setClearing(false);
        measure();
    };

    return (
        <Card>
            <CardHeader>
                <CardTitle>{t("mediaDownload.title")}</CardTitle>
            </CardHeader>
            <CardBody className="flex flex-col gap-3">
                <p className="text-sm text-muted-foreground">{t("mediaDownload.body")}</p>
                {KINDS.map((kind) => (
                    <div key={kind} className="flex min-w-0 items-center justify-between gap-4">
                        <span className="min-w-0 truncate text-sm">{t(`mediaDownload.${kind}`)}</span>
                        <Select
                            value={prefs[kind]}
                            aria-label={t(`mediaDownload.${kind}`)}
                            onValueChange={(value) => {
                                if (value === prefs[kind]) return;
                                setMediaPrefs({ ...prefs, [kind]: value as rules.DownloadWhen });
                            }}
                            options={WHEN.map((when) => ({ value: when, label: t(`mediaDownload.${when}`) }))}
                        />
                    </div>
                ))}
                <div className="flex min-w-0 items-center justify-between gap-4">
                    <span className="min-w-0 truncate text-sm">{t("mediaDownload.cap")}</span>
                    <Select
                        value={String(prefs.capMb)}
                        aria-label={t("mediaDownload.cap")}
                        onValueChange={(value) => {
                            const capMb = Number(value);
                            if (capMb === prefs.capMb) return;
                            setMediaPrefs({ ...prefs, capMb });
                            setTimeout(measure, 500);
                        }}
                        options={rules.MEDIA_CAPS_MB.map((mb) => ({
                            value: String(mb),
                            label: formatBytes(mb * 1024 * 1024)
                        }))}
                    />
                </div>
                <div className="flex min-w-0 items-center justify-between gap-4">
                    <span className="min-w-0 truncate text-sm text-muted-foreground">
                        {used === null
                            ? " "
                            : t("mediaDownload.used", {
                                  used: formatBytes(used),
                                  cap: formatBytes(prefs.capMb * 1024 * 1024)
                              })}
                    </span>
                    <Button
                        variant="secondary"
                        size="sm"
                        disabled={clearing || !used}
                        onClick={() => void clear()}
                    >
                        {t("mediaDownload.clear")}
                    </Button>
                </div>
            </CardBody>
        </Card>
    );
}
