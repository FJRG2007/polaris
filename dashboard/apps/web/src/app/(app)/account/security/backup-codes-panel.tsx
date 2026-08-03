"use client";

/**
 * A freshly minted set of backup codes, and every way of getting it off the
 * screen.
 *
 * Shown at the one moment the codes exist in plaintext - arming the
 * authenticator, or replacing the set from the Security page - so the controls
 * that save them have to be right here. There is no second chance to open this:
 * what is stored is encrypted and only ever counted, never read back.
 *
 * Shared by both of those moments rather than written twice, so a format added
 * here is offered wherever codes are handed out.
 */

import { Copy, Download, Printer } from "lucide-react";
import {
    backupCodesFile,
    backupCodesHtml,
    BACKUP_CODE_FORMATS,
    type BackupCodeFormat
} from "@/lib/backup-codes";
import {
    Button,
    DropdownMenu,
    DropdownMenuContent,
    DropdownMenuItem,
    DropdownMenuTrigger
} from "@polaris/ui";

/** Hand a generated file to the browser as a download. */
function download(codes: readonly string[], format: BackupCodeFormat, account: string): void {
    const file = backupCodesFile(codes, format, account);
    const url = URL.createObjectURL(new Blob([file.body], { type: file.type }));
    const link = document.createElement("a");
    link.href = url;
    link.download = file.name;
    link.click();
    URL.revokeObjectURL(url);
}

/**
 * Print the codes from an offscreen frame. A frame rather than a second window,
 * because a popup blocker would swallow the window and the codes are only shown
 * once - there is no second chance to get them onto paper.
 */
function printCodes(codes: readonly string[], account: string): void {
    const frame = document.createElement("iframe");
    frame.setAttribute("aria-hidden", "true");
    frame.style.cssText = "position:fixed;width:0;height:0;border:0;visibility:hidden";
    frame.srcdoc = backupCodesHtml(codes, account);
    frame.onload = () => {
        frame.contentWindow?.print();
        // Outlives the print dialog, which is modal on the frame's window.
        setTimeout(() => frame.remove(), 60_000);
    };
    document.body.append(frame);
}

export function BackupCodesPanel({
    codes,
    account,
    label
}: {
    codes: readonly string[];
    /** The account these open, carried into the file name and onto the printed
     *  page so one set of codes can be told from another. */
    account: string;
    label?: string;
}) {
    return (
        <div className="flex flex-col gap-1">
            <span className="text-xs text-muted-foreground">
                {label ??
                    "Backup codes - each works once, store them somewhere safe. They are not shown again."}
            </span>
            <div className="grid grid-cols-2 gap-1 rounded-md border border-border bg-muted/30 p-2 font-mono text-xs">
                {codes.map((code) => (
                    <span key={code}>{code}</span>
                ))}
            </div>
            <div className="flex flex-wrap gap-1">
                <Button
                    type="button"
                    variant="ghost"
                    size="sm"
                    onClick={() => void navigator.clipboard.writeText(codes.join("\n"))}
                >
                    <Copy className="size-4" />
                    Copy
                </Button>
                <DropdownMenu>
                    <DropdownMenuTrigger asChild>
                        <Button type="button" variant="ghost" size="sm">
                            <Download className="size-4" />
                            Download
                        </Button>
                    </DropdownMenuTrigger>
                    <DropdownMenuContent align="start">
                        {BACKUP_CODE_FORMATS.map((entry) => (
                            <DropdownMenuItem
                                key={entry.format}
                                onSelect={() => download(codes, entry.format, account)}
                            >
                                {entry.label}
                            </DropdownMenuItem>
                        ))}
                    </DropdownMenuContent>
                </DropdownMenu>
                <Button type="button" variant="ghost" size="sm" onClick={() => printCodes(codes, account)}>
                    <Printer className="size-4" />
                    Print
                </Button>
            </div>
        </div>
    );
}
