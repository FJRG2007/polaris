"use client";

/**
 * Taking the document out.
 *
 * Two kinds of item, and the difference is invisible to whoever presses them.
 * Most formats are written on the server and downloaded through an ordinary
 * link, so the file starts saving with no page transition and nothing held in
 * memory on the way. A drawing is made here instead, by the canvas that is
 * already showing it - see `export-slot`.
 *
 * **Print is the last item, and it is how a document becomes a PDF.** Every
 * operating system prints to PDF, the browser has the layout engine, and a
 * hand-rolled PDF writer would produce something worse than the thing it was
 * made from. Saying "Print" rather than offering a PDF that is not as good is
 * the honest version.
 *
 * **A document that came from Google can go back to it.** Not over the file it
 * came from - Polaris may only write the files it created - but to a Google copy
 * made on the first save and updated on every one after. Only for the person
 * whose account brought it in; see `lib/office/google.ts`.
 */

import * as core from "@polaris/core";
import { useTranslations } from "@/components/i18n/i18n-provider";
import { useEffect, useState } from "react";
import { Cloud, Download, ExternalLink, Printer } from "lucide-react";
import { useBrowserExporter } from "./export-slot";
import { officeGoogleLinkAction, saveToGoogleAction } from "./google-actions";
import type { OfficeGoogleLink } from "@/lib/office/google";
import {
    Button,
    DropdownMenu,
    DropdownMenuContent,
    DropdownMenuItem,
    DropdownMenuSeparator,
    DropdownMenuTrigger,
    useToast
} from "@polaris/ui";

export function ExportMenu({
    documentId,
    kind,
    title
}: {
    documentId: string;
    kind: core.OfficeKind;
    title: string;
}) {
    const t = useTranslations("office");
    const toast = useToast();
    const exporter = useBrowserExporter();
    const formats = core.OFFICE_EXPORTS[kind] as readonly string[];
    const [google, setGoogle] = useState<OfficeGoogleLink | null>(null);
    const [saving, setSaving] = useState(false);
    const savesToGoogle = kind === "doc" || kind === "sheet";

    useEffect(() => {
        if (!savesToGoogle) return;
        let live = true;
        void officeGoogleLinkAction(documentId).then((answer) => {
            if (live) setGoogle(answer.link ?? null);
        });
        return () => {
            live = false;
        };
    }, [documentId, savesToGoogle]);

    async function saveToGoogle(): Promise<void> {
        if (saving) return;
        setSaving(true);
        const answer = await saveToGoogleAction(documentId);
        setSaving(false);
        if (answer.error || !answer.link) {
            toast.show({ title: answer.error ?? t("google.errors.failed") });
            return;
        }
        const link = answer.link;
        setGoogle((held) => (held ? { ...held, copyLink: link, savedAt: new Date().toISOString() } : held));
        toast.show({
            title: t("google.saved"),
            body: t("google.openCopy"),
            onPress: () => window.open(link, "_blank", "noopener,noreferrer")
        });
    }

    /** A drawing, made here and saved. The link is built, clicked and thrown
     *  away in the same breath: a blob URL left behind is a copy of the drawing
     *  held in memory for as long as the tab is open. */
    async function saveHere(format: string): Promise<void> {
        if (!exporter) return;
        const blob = await exporter(format).catch(() => null);
        if (!blob) {
            toast.show({ title: t("export.thatCouldNotBeMade") });
            return;
        }
        const url = URL.createObjectURL(blob);
        const link = document.createElement("a");
        link.href = url;
        link.download = core.exportFilename(title, format);
        link.click();
        URL.revokeObjectURL(url);
    }

    return (
        <DropdownMenu>
            <DropdownMenuTrigger asChild>
                <Button size="sm" variant="secondary">
                    <Download className="size-4 shrink-0" aria-hidden />
                    {t("export.export")}
                </Button>
            </DropdownMenuTrigger>
            <DropdownMenuContent align="end">
                {formats.map((format) =>
                    core.exportedInBrowser(format) ? (
                        <DropdownMenuItem
                            key={format}
                            disabled={!exporter}
                            onSelect={() => void saveHere(format)}
                        >
                            {core.OFFICE_EXPORT_LABELS[format] ?? format}
                        </DropdownMenuItem>
                    ) : (
                        <DropdownMenuItem key={format} asChild>
                            <a
                                href={`/api/office/${encodeURIComponent(documentId)}/export?as=${format}`}
                                download
                            >
                                {core.OFFICE_EXPORT_LABELS[format] ?? format}
                            </a>
                        </DropdownMenuItem>
                    )
                )}
                {google ? (
                    <>
                        <DropdownMenuSeparator />
                        <DropdownMenuItem
                            disabled={!google.mine || saving}
                            title={google.mine ? undefined : t("google.notYours")}
                            onSelect={() => void saveToGoogle()}
                        >
                            <Cloud className="size-4 shrink-0" aria-hidden />
                            {t("google.saveBack")}
                        </DropdownMenuItem>
                        {google.copyLink ? (
                            <DropdownMenuItem asChild>
                                <a href={google.copyLink} target="_blank" rel="noopener noreferrer">
                                    <ExternalLink className="size-4 shrink-0" aria-hidden />
                                    {t("google.openInGoogle")}
                                </a>
                            </DropdownMenuItem>
                        ) : null}
                    </>
                ) : null}
                <DropdownMenuSeparator />
                <DropdownMenuItem onSelect={() => window.print()}>
                    <Printer className="size-4 shrink-0" aria-hidden />
                    {t("export.printOrSaveAsPdf")}
                </DropdownMenuItem>
            </DropdownMenuContent>
        </DropdownMenu>
    );
}
