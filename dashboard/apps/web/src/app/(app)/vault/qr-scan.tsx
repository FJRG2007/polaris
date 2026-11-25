"use client";

/**
 * Reading the QR a site shows when it turns on two-factor: the shared scanner
 * (`components/qr-scan-dialog.tsx`) in the vault's words, taking a pasted
 * `otpauth://` link as well as a picture.
 */

import { useTranslations } from "@/components/i18n/i18n-provider";
import * as scan from "@/components/qr-scan-dialog";

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
    const t = useTranslations("vault");
    const copy: scan.QrScanCopy = {
        title: t("qr.title"),
        intro: t("qr.intro"),
        start: t("qr.start"),
        stop: t("qr.stop"),
        upload: t("qr.upload"),
        noCamera: t("qr.noCamera"),
        notFound: t("qr.notFound"),
        notPicture: t("qr.notPicture")
    };
    return (
        <scan.QrScanDialog
            open={open}
            copy={copy}
            acceptsText={(text) => text.toLowerCase().startsWith("otpauth://")}
            onFound={onFound}
            onOpenChange={onOpenChange}
        />
    );
}
