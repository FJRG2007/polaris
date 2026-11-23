"use client";

/**
 * Media auto-download, on this device: when photos, videos and documents of
 * recent messages are fetched ahead of time, how much space they may take, how
 * much they take now, and a way to empty it.
 *
 * Every row says what it changes as well as what it is called: "Videos - Wi-Fi
 * only" on its own does not tell anybody that the choice is about saving them
 * ahead of time, or that a video still plays when it is opened.
 */

import { SettingRow } from "./setting-row";
import { formatBytes } from "@polaris/core";
import { useConfirm } from "@/components/confirm-dialog";
import { useCallback, useEffect, useState } from "react";
import * as rules from "@/lib/chat/offline/media-download";
import { useTranslations } from "@/components/i18n/i18n-provider";
import { Button, Card, CardBody, CardHeader, CardTitle, Select } from "@polaris/ui";
import { clearMedia, mediaUsage, setMediaPrefs, useMediaPrefs } from "../media-download";

const KINDS: readonly rules.MediaKind[] = ["photos", "videos", "files"];
const WHEN: readonly rules.DownloadWhen[] = ["always", "wifi", "never"];
const MB = 1024 * 1024;

export function MediaDownloadCard() {
    const t = useTranslations("chat");
    const prefs = useMediaPrefs();
    const [confirm, confirmDialog] = useConfirm();
    const [used, setUsed] = useState<number | null>(null);
    const [clearing, setClearing] = useState(false);

    const measure = useCallback(() => {
        void mediaUsage()
            .then((usage) => setUsed(usage.bytes))
            .catch(() => setUsed(0));
    }, []);
    useEffect(measure, [measure]);

    const clear = async (): Promise<void> => {
        const sure = await confirm({
            title: t("chatSettings.media.clearTitle"),
            description: t("chatSettings.media.clearBody"),
            confirmLabel: t("chatSettings.media.clear"),
            danger: true
        });
        if (!sure) return;
        setClearing(true);
        await clearMedia().catch(() => undefined);
        setClearing(false);
        measure();
    };

    const capBytes = prefs.capMb * MB;
    const share = used === null ? 0 : Math.min(100, Math.round((used / capBytes) * 100));

    return (
        <Card>
            <CardHeader>
                <CardTitle>{t("chatSettings.media.title")}</CardTitle>
            </CardHeader>
            <CardBody className="flex flex-col gap-4">
                <div className="flex flex-col gap-1">
                    <p className="text-sm text-muted-foreground">{t("chatSettings.media.body")}</p>
                    <p className="text-sm text-muted-foreground">{t("chatSettings.media.whenHint")}</p>
                </div>
                {KINDS.map((kind) => (
                    <SettingRow
                        key={kind}
                        id={`chat-media-${kind}`}
                        label={t(`chatSettings.media.${kind}`)}
                        hint={t(`chatSettings.media.${kind}Hint`)}
                    >
                        <Select
                            className="h-8 w-48 max-w-full"
                            value={prefs[kind]}
                            aria-label={t(`chatSettings.media.${kind}`)}
                            aria-describedby={`chat-media-${kind}-hint`}
                            onValueChange={(value) => {
                                if (value === prefs[kind]) return;
                                setMediaPrefs({ ...prefs, [kind]: value as rules.DownloadWhen });
                            }}
                            options={WHEN.map((when) => ({
                                value: when,
                                label: t(`chatSettings.media.${when}`)
                            }))}
                        />
                    </SettingRow>
                ))}
                <SettingRow
                    id="chat-media-cap"
                    label={t("chatSettings.media.cap")}
                    hint={t("chatSettings.media.capHint")}
                >
                    <Select
                        className="h-8 w-48 max-w-full"
                        value={String(prefs.capMb)}
                        aria-label={t("chatSettings.media.cap")}
                        aria-describedby="chat-media-cap-hint"
                        onValueChange={(value) => {
                            const capMb = Number(value);
                            if (capMb === prefs.capMb) return;
                            setMediaPrefs({ ...prefs, capMb });
                            // Lowering the limit trims what is kept; measure
                            // again once that has had a moment.
                            setTimeout(measure, 500);
                        }}
                        options={rules.MEDIA_CAPS_MB.map((mb) => ({
                            value: String(mb),
                            label: formatBytes(mb * MB)
                        }))}
                    />
                </SettingRow>
                <div className="flex flex-col gap-2 border-t border-border pt-4">
                    <SettingRow
                        id="chat-media-used"
                        label={t("chatSettings.media.usedTitle")}
                        hint={
                            used === null
                                ? t("chatSettings.media.measuring")
                                : t("chatSettings.media.used", {
                                      used: formatBytes(used),
                                      cap: formatBytes(capBytes)
                                  })
                        }
                    >
                        <Button
                            variant="secondary"
                            size="sm"
                            disabled={clearing || !used}
                            onClick={() => void clear()}
                        >
                            {t("chatSettings.media.clear")}
                        </Button>
                    </SettingRow>
                    <div
                        role="meter"
                        aria-labelledby="chat-media-used-label"
                        aria-describedby="chat-media-used-hint"
                        aria-valuemin={0}
                        aria-valuemax={capBytes}
                        aria-valuenow={used ?? 0}
                        className="h-1.5 w-full overflow-hidden rounded-full bg-muted"
                    >
                        <div
                            className={`h-full rounded-full transition-[width] ${share >= 90 ? "bg-warning" : "bg-primary"}`}
                            style={{ width: `${share}%` }}
                        />
                    </div>
                </div>
            </CardBody>
            {confirmDialog}
        </Card>
    );
}
