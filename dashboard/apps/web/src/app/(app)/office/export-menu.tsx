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
 */

import * as core from "@polaris/core";
import { Download, Printer } from "lucide-react";
import { useBrowserExporter } from "./export-slot";
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
    const toast = useToast();
    const exporter = useBrowserExporter();
    const formats = core.OFFICE_EXPORTS[kind] as readonly string[];

    /** A drawing, made here and saved. The link is built, clicked and thrown
     *  away in the same breath: a blob URL left behind is a copy of the drawing
     *  held in memory for as long as the tab is open. */
    async function saveHere(format: string): Promise<void> {
        if (!exporter) return;
        const blob = await exporter(format).catch(() => null);
        if (!blob) {
            toast.show({ title: "That could not be made. Try again in a moment." });
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
                    Export
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
                <DropdownMenuSeparator />
                <DropdownMenuItem onSelect={() => window.print()}>
                    <Printer className="size-4 shrink-0" aria-hidden />
                    Print, or save as PDF
                </DropdownMenuItem>
            </DropdownMenuContent>
        </DropdownMenu>
    );
}
