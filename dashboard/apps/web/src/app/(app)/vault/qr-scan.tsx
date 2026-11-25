"use client";

/**
 * Reading the QR a site shows when it turns on two-factor: the shared scanner
 * (`components/qr-scan-dialog.tsx`) in the vault's words, taking a pasted
 * `otpauth://` link as well as a picture.
 */

import { useTranslations } from "@/components/i18n/i18n-provider";
import * as scan from "@/components/qr-scan-dialog";

const acceptsOtpauth = (text: string) => text.toLowerCase().startsWith("otpauth://");

function useVaultScanCopy(): scan.QrScanCopy {
    const t = useTranslations("vault");
    return {
        title: t("qr.title"),
        intro: t("qr.intro"),
        start: t("qr.start"),
        stop: t("qr.stop"),
        upload: t("qr.upload"),
        noCamera: t("qr.noCamera"),
        notFound: t("qr.notFound"),
        notPicture: t("qr.notPicture")
    };
}

export function QrScanDialog({
    open,
    onFound,
    onOpenChange
}: {
    open: boolean;
    /** What the code said, verbatim. The caller decides whether it is the kind
     *  of link it wanted. */
    onFound: (value: string) => void;
    onOpenChange: (open: boolean) => void;
}) {
    const copy = useVaultScanCopy();
    return <scan.QrScanDialog open={open} copy={copy} acceptsText={acceptsOtpauth} onFound={onFound} onOpenChange={onOpenChange} />;
}

/** The same scanner shown in place of a dialog's own content, so it never opens a second modal. */
export function QrScanPanel({ onFound, onDone }: { onFound: (value: string) => void; onDone: () => void }) {
    const copy = useVaultScanCopy();
    return <scan.QrScanPanel open copy={copy} acceptsText={acceptsOtpauth} onFound={onFound} onDone={onDone} />;
}

/** The scanner's title, for the dialog it is shown in. */
export function useQrScanTitle(): string {
    return useVaultScanCopy().title;
}
