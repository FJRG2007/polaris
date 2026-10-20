"use client";

/**
 * Back up and restore: the saved settings downloaded as one file, and a file
 * read back with what it would change shown first. Loading it fills the form;
 * nothing is applied until Save.
 */

import { useState } from "react";
import { Download, Upload } from "lucide-react";
import type { NamespaceKey } from "@/lib/i18n/types";
import { useDnsBlocker } from "./dns-blocker-context";
import * as transfer from "@/lib/dns-blocker/transfer";
import { useTranslations } from "@/components/i18n/i18n-provider";
import { useChooseFiles } from "@/components/file-picker/use-choose-files";
import { Button, Card, CardBody, CardHeader, CardTitle } from "@polaris/ui";

export function DnsTransferCard() {
    const t = useTranslations("dnsBlocker");
    const { saved, dirty, loadForm } = useDnsBlocker();
    const [chooseFiles, chooser] = useChooseFiles();
    const [preview, setPreview] = useState<transfer.DnsImport | null>(null);
    const [notice, setNotice] = useState<string | null>(null);
    const [failed, setFailed] = useState<string | null>(null);

    const field = (key: string) => {
        const label = `transfer.fields.${key}` as NamespaceKey<"dnsBlocker">;
        return t.has(label) ? t(label) : key;
    };

    const download = () => {
        const now = new Date();
        const url = URL.createObjectURL(
            new Blob([transfer.exportSettings(saved, now)], { type: "application/json" })
        );
        const link = document.createElement("a");
        link.href = url;
        link.download = transfer.exportFileName(now);
        link.click();
        URL.revokeObjectURL(url);
    };

    const read = (file: File | undefined) => {
        setNotice(null);
        if (!file) return;
        if (file.size > transfer.DNS_IMPORT_MAX_BYTES) {
            setPreview({ ok: false, error: "notExport", fields: [] }); // i18n-ignore a key the screen says
            return;
        }
        void file.text().then(
            (text) => setPreview(transfer.readImport(text, saved)),
            () => setPreview({ ok: false, error: "notJson", fields: [] }) // i18n-ignore a key the screen says
        );
    };

    const load = () => {
        if (!preview?.ok) return;
        loadForm(preview.settings);
        setPreview(null);
        setNotice(t("transfer.loaded"));
    };

    return (
        <Card>
            <CardHeader>
                <CardTitle>{t("transfer.title")}</CardTitle>
                <p className="text-xs text-muted-foreground">{t("transfer.intro")}</p>
            </CardHeader>
            <CardBody className="flex flex-col gap-3">
                <div className="flex flex-wrap gap-2">
                    <Button variant="outline" onClick={download}>
                        <Download className="size-4 shrink-0" />
                        {t("transfer.export")}
                    </Button>
                    <Button
                        variant="outline"
                        onClick={() => {
                            setFailed(null);
                            void chooseFiles({
                                accept: "application/json,.json",
                                onFailed: setFailed
                            }).then(([file]) => read(file));
                        }}
                    >
                        <Upload className="size-4 shrink-0" />
                        {t("transfer.import")}
                    </Button>
                    {chooser}
                </div>
                {notice ? <p className="text-sm text-success-ink">{notice}</p> : null}
                {failed ? <p className="text-sm text-danger-ink">{failed}</p> : null}
                {preview && !preview.ok ? (
                    <p className="text-sm text-danger-ink">
                        {preview.error === "invalid"
                            ? t("transfer.invalid", {
                                  fields: preview.fields.map(field).join(", ")
                              })
                            : t(`transfer.${preview.error}`)}
                    </p>
                ) : null}
                {preview?.ok ? (
                    <div className="flex min-w-0 flex-col gap-2 rounded-md border p-3">
                        {preview.changed.length === 0 ? (
                            <p className="text-sm text-muted-foreground">{t("transfer.same")}</p>
                        ) : (
                            <>
                                <p className="text-sm">{t("transfer.changes")}</p>
                                <ul className="flex flex-wrap gap-1.5">
                                    {preview.changed.map((key) => (
                                        <li
                                            key={key}
                                            className="rounded-md bg-muted px-2 py-0.5 text-xs"
                                        >
                                            {field(key)}
                                        </li>
                                    ))}
                                </ul>
                                {dirty ? (
                                    <p className="text-xs text-warning-ink">
                                        {t("transfer.dropsEdits")}
                                    </p>
                                ) : null}
                            </>
                        )}
                        <div className="flex flex-wrap gap-2">
                            {preview.changed.length > 0 ? (
                                <Button size="sm" onClick={load}>
                                    {t("transfer.load")}
                                </Button>
                            ) : null}
                            <Button size="sm" variant="ghost" onClick={() => setPreview(null)}>
                                {t("transfer.cancel")}
                            </Button>
                        </div>
                    </div>
                ) : null}
            </CardBody>
        </Card>
    );
}
