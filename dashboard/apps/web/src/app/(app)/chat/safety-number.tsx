"use client";

/**
 * A one-to-one conversation's safety number (design 4.6), in its info: the 60
 * digits and a QR of them, for the two people to compare in person. Nothing
 * here is needed to chat - sealing never waits for it - it is for whoever does
 * not want to trust the server's word for whose key they seal to.
 *
 * The number is worked out in this browser from both published account keys;
 * the last one is kept in this page's memory so reopening draws at once.
 *
 * Verifying - scanning the other screen's QR here, or comparing the digits and
 * saying so - is remembered in this browser (`peer-keys.ts`) against these
 * digits, so a later key change on either side takes the mark away.
 */

import { QRCodeSVG } from "qrcode.react";
import { BadgeCheck, Copy, RotateCw, ScanLine } from "lucide-react";
import { useCallback, useEffect, useState, useSyncExternalStore } from "react";
import * as peerKeys from "@/lib/chat/e2ee/peer-keys";
import { QrScanDialog, type QrScanCopy } from "@/components/qr-scan-dialog";
import { Button, Skeleton, useToast } from "@polaris/ui";
import { useTranslations } from "@/components/i18n/i18n-provider";
import type { PairSafety } from "@/lib/chat/e2ee/account-key-client";

/** What the QR carries: a prefix, so a reader app shows what it is. */
const QR_PREFIX = "polaris-safety-number:1:";

const known = new Map<string, PairSafety>();

/** Whether `ownId` verified `digits` with `peerId` in this browser, kept current across tabs. */
export function usePeerVerified(ownId: string, peerId: string, digits: string | null): boolean {
    return useSyncExternalStore(
        peerKeys.subscribeBooks,
        () => {
            const record = peerKeys.readBook(ownId)[peerId];
            return Boolean(record?.verifiedDigits && (digits === null || record.verifiedDigits === digits));
        },
        () => false
    );
}

export function SafetyNumberView({ channelId, peerId, peerName }: { channelId: string; peerId: string; peerName: string }) {
    const t = useTranslations("chat");
    const toast = useToast();
    const key = `${channelId}:${peerId}`;
    const [safety, setSafety] = useState<PairSafety | null>(() => known.get(key) ?? null);
    const [scanning, setScanning] = useState(false);
    const [scanError, setScanError] = useState("");
    const ready = safety?.kind === "ready" ? safety : null;
    const verified = usePeerVerified(ready?.ownId ?? "", peerId, ready?.digits ?? null);

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

    const setVerified = (digits: string | null) => {
        if (!ready) return;
        peerKeys.updateBook(ready.ownId, (book) => peerKeys.verifyPeer(book, peerId, ready.peerFingerprint, digits));
    };
    const scanned = (value: string) => {
        if (!ready) return;
        if (value === QR_PREFIX + ready.digits) {
            setScanError("");
            setVerified(ready.digits);
            toast.show({ key: "chat-safety-verified", title: t("info.safetyScanMatch", { name: peerName }) });
        } else {
            setScanError(value.startsWith(QR_PREFIX) ? t("info.safetyScanMismatch", { name: peerName }) : t("info.safetyScanOther"));
        }
    };
    const scanCopy: QrScanCopy = {
        title: t("info.safetyScanTitle"),
        intro: t("info.safetyScanIntro", { name: peerName }),
        start: t("info.safetyScanStart"),
        stop: t("info.safetyScanStop"),
        upload: t("info.safetyScanUpload"),
        noCamera: t("info.safetyScanNoCamera"),
        notFound: t("info.safetyScanNotFound"),
        notPicture: t("info.safetyScanNotPicture")
    };

    return (
        <div className="flex flex-col gap-4 px-3 py-3">
            <p className="text-sm text-muted-foreground">{t("info.safetyHint", { name: peerName })}</p>
            {verified ? (
                <p className="flex items-center gap-1.5 self-center text-sm font-medium text-success">
                    <BadgeCheck className="size-4 shrink-0" />
                    {t("info.safetyVerified")}
                </p>
            ) : null}
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
            {scanError ? (
                <p role="alert" className="text-center text-sm text-danger">
                    {scanError}
                </p>
            ) : null}
            <div className="flex flex-wrap justify-center gap-2">
                <Button variant="outline" size="sm" disabled={!ready} onClick={() => setScanning(true)}>
                    <ScanLine className="size-3.5 shrink-0" />
                    {t("info.safetyScan")}
                </Button>
                <Button variant="outline" size="sm" disabled={!groups} onClick={copy}>
                    <Copy className="size-3.5 shrink-0" />
                    {t("info.safetyCopy")}
                </Button>
            </div>
            {ready ? (
                <Button
                    variant="ghost"
                    size="sm"
                    className="self-center"
                    onClick={() => setVerified(verified ? null : ready.digits)}
                >
                    {verified ? t("info.safetyUnverify") : t("info.safetyMarkVerified")}
                </Button>
            ) : null}
            <QrScanDialog
                open={scanning}
                copy={scanCopy}
                acceptsText={(text) => text.startsWith(QR_PREFIX)}
                onFound={scanned}
                onOpenChange={setScanning}
            />
        </div>
    );
}
