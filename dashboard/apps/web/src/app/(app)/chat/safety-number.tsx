"use client";

/**
 * A one-to-one conversation's safety number (design 4.6), in its info: the 60
 * digits and a QR of them, for the two people to compare in person. Nothing
 * here is needed to chat - sealing never waits for it - it is for whoever does
 * not want to trust the server's word for whose key they seal to.
 *
 * The number is worked out in this browser from both published account keys;
 * the last one is kept in this page's memory so reopening draws at once.
 */

import { QRCodeSVG } from "qrcode.react";
import { Copy, RotateCw } from "lucide-react";
import { useCallback, useEffect, useState } from "react";
import { Button, Skeleton, useToast } from "@polaris/ui";
import { useTranslations } from "@/components/i18n/i18n-provider";
import type { PairSafety } from "@/lib/chat/e2ee/account-key-client";

/** What the QR carries: a prefix, so a reader app shows what it is. */
const QR_PREFIX = "polaris-safety-number:1:";

const known = new Map<string, PairSafety>();

export function SafetyNumberView({ channelId, peerId, peerName }: { channelId: string; peerId: string; peerName: string }) {
    const t = useTranslations("chat");
    const toast = useToast();
    const key = `${channelId}:${peerId}`;
    const [safety, setSafety] = useState<PairSafety | null>(() => known.get(key) ?? null);

    const load = useCallback(() => {
        let live = true;
        // The digits take a few thousand hashes; imported here so the info page alone never loads them.
        void import("@/lib/chat/e2ee/account-key-client")
            .then((client) => client.pairSafetyNumber(channelId, peerId))
            .catch((): PairSafety => ({ kind: "unavailable" }))
            .then((answer) => {
                if (answer.kind === "ready") known.set(key, answer);
                if (live) setSafety(answer);
            });
        return () => {
            live = false;
        };
    }, [channelId, peerId, key]);

    useEffect(() => load(), [load]);

    if (safety?.kind === "no-key")
        return <p className="px-3 py-3 text-sm text-muted-foreground">{t("info.safetyNoKey", { name: peerName })}</p>;

    if (safety?.kind === "unavailable")
        return (
            <div className="flex flex-col items-start gap-2 px-3 py-3">
                <p className="text-sm text-muted-foreground">{t("info.safetyFailed")}</p>
                <Button
                    variant="outline"
                    size="sm"
                    onClick={() => {
                        setSafety(null);
                        load();
                    }}
                >
                    <RotateCw className="size-3.5 shrink-0" />
                    {t("info.safetyRetry")}
                </Button>
            </div>
        );

    const groups = safety?.kind === "ready" ? (safety.digits.match(/\d{5}/g) ?? []) : null;
    const copy = () => {
        if (safety?.kind !== "ready") return;
        void navigator.clipboard
            .writeText(groups?.join(" ") ?? safety.digits)
            .then(() => toast.show({ key: "chat-safety-copied", title: t("info.safetyCopied") }))
            .catch(() => undefined);
    };

    return (
        <div className="flex flex-col gap-4 px-3 py-3">
            <p className="text-sm text-muted-foreground">{t("info.safetyHint", { name: peerName })}</p>
            <div className="flex justify-center">
                {/* Fixed light colors: a QR has to stay readable in dark mode. */}
                <div className="rounded-md bg-white p-3">
                    {safety?.kind === "ready" ? (
                        <QRCodeSVG value={QR_PREFIX + safety.digits} size={148} bgColor="#ffffff" fgColor="#000000" />
                    ) : (
                        <Skeleton className="size-[148px]" />
                    )}
                </div>
            </div>
            <div
                className="grid grid-cols-4 gap-x-3 gap-y-2 self-center font-mono text-sm tabular-nums"
                aria-label={t("info.safetyNumber")}
                aria-busy={groups ? undefined : true}
            >
                {groups
                    ? groups.map((group, index) => <span key={index}>{group}</span>)
                    : Array.from({ length: 12 }, (_, index) => <Skeleton key={index} className="h-5 w-12" />)}
            </div>
            <Button variant="outline" size="sm" className="self-center" disabled={!groups} onClick={copy}>
                <Copy className="size-3.5 shrink-0" />
                {t("info.safetyCopy")}
            </Button>
        </div>
    );
}
