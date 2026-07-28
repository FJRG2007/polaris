"use client";

/**
 * Authenticator (TOTP) enrollment and removal. Both run through better-auth's
 * browser client, which owns the plugin's endpoints, so the secret is never
 * handled by Polaris code and never reaches a server action.
 *
 * Enrollment is deliberately three steps - password, then the secret, then a code
 * that proves the authenticator actually works. The factor is only armed after
 * that last step, so a mis-copied secret cannot lock anyone out. Backup codes are
 * shown once, in the same breath, because that is the only moment they exist -
 * hence the copy, download and print controls sitting right next to them.
 */

import { useState, type FormEvent } from "react";
import { Copy, Download, Printer } from "lucide-react";
import { QRCodeSVG } from "qrcode.react";
import {
    Button,
    Dialog,
    DialogContent,
    DialogDescription,
    DialogHeader,
    DialogTitle,
    DropdownMenu,
    DropdownMenuContent,
    DropdownMenuItem,
    DropdownMenuTrigger,
    Input
} from "@polaris/ui";
import { authClient } from "@/lib/auth-client";
import {
    backupCodesFile,
    backupCodesHtml,
    BACKUP_CODE_FORMATS,
    type BackupCodeFormat
} from "@/lib/backup-codes";
import { Feedback } from "./setting-card";

/** The `secret` query parameter of an otpauth:// URI, for manual entry. */
function secretFromUri(uri: string): string {
    try {
        return new URL(uri).searchParams.get("secret") ?? "";
    } catch {
        return "";
    }
}

/** Format a base32 secret in groups of four so it can be typed without losing place. */
function groupSecret(secret: string): string {
    return secret.replace(/(.{4})/g, "$1 ").trim();
}

/** Hand a generated file to the browser as a download. */
function download(codes: string[], format: BackupCodeFormat): void {
    const file = backupCodesFile(codes, format);
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
function printCodes(codes: string[]): void {
    const frame = document.createElement("iframe");
    frame.setAttribute("aria-hidden", "true");
    frame.style.cssText = "position:fixed;width:0;height:0;border:0;visibility:hidden";
    frame.srcdoc = backupCodesHtml(codes);
    frame.onload = () => {
        frame.contentWindow?.print();
        // Outlives the print dialog, which is modal on the frame's window.
        setTimeout(() => frame.remove(), 60_000);
    };
    document.body.append(frame);
}

export function EnableTwoFactorDialog({
    open,
    onOpenChange,
    onDone
}: {
    open: boolean;
    onOpenChange: (open: boolean) => void;
    onDone: () => void;
}) {
    const [step, setStep] = useState<"password" | "verify">("password");
    const [totpUri, setTotpUri] = useState("");
    const [backupCodes, setBackupCodes] = useState<string[]>([]);
    const [busy, setBusy] = useState(false);
    const [error, setError] = useState<string | null>(null);

    function reset() {
        setStep("password");
        setTotpUri("");
        setBackupCodes([]);
        setError(null);
        setBusy(false);
    }

    async function onPassword(event: FormEvent<HTMLFormElement>) {
        event.preventDefault();
        const password = String(new FormData(event.currentTarget).get("password") ?? "");
        setBusy(true);
        setError(null);
        const { data, error: enableError } = await authClient.twoFactor.enable({ password });
        setBusy(false);
        if (enableError || !data) {
            setError(enableError?.message ?? "Could not start setup. Check your password.");
            return;
        }
        setTotpUri(data.totpURI);
        setBackupCodes(data.backupCodes);
        setStep("verify");
    }

    async function onVerify(event: FormEvent<HTMLFormElement>) {
        event.preventDefault();
        const code = String(new FormData(event.currentTarget).get("code") ?? "");
        setBusy(true);
        setError(null);
        const { error: verifyError } = await authClient.twoFactor.verifyTotp({ code });
        setBusy(false);
        if (verifyError) {
            setError("That code did not match. Check the clock on your device and try again.");
            return;
        }
        onOpenChange(false);
        reset();
        onDone();
    }

    const secret = secretFromUri(totpUri);

    return (
        <Dialog
            open={open}
            onOpenChange={(next) => {
                onOpenChange(next);
                if (!next) reset();
            }}
        >
            <DialogContent className="max-w-md">
                <DialogHeader>
                    <DialogTitle>Set up an authenticator</DialogTitle>
                    <DialogDescription>
                        {step === "password"
                            ? "Confirm your password to generate a new secret."
                            : "Add the secret to your authenticator app, then enter the code it shows."}
                    </DialogDescription>
                </DialogHeader>

                {step === "password" ? (
                    <form onSubmit={onPassword} className="flex flex-col gap-3">
                        <label className="flex flex-col gap-1 text-sm">
                            Password
                            <Input name="password" type="password" required autoComplete="current-password" />
                        </label>
                        <Feedback error={error} />
                        <div className="flex justify-end gap-2">
                            <Button type="button" variant="ghost" onClick={() => onOpenChange(false)}>
                                Cancel
                            </Button>
                            <Button type="submit" disabled={busy}>
                                {busy ? "Working..." : "Continue"}
                            </Button>
                        </div>
                    </form>
                ) : (
                    <form onSubmit={onVerify} className="flex flex-col gap-3">
                        <div className="flex flex-col items-center gap-2">
                            {/* Fixed light colors: a QR has to stay readable in dark mode. */}
                            <div className="rounded-md bg-white p-3">
                                <QRCodeSVG value={totpUri} size={148} bgColor="#ffffff" fgColor="#000000" />
                            </div>
                            <span className="text-xs text-muted-foreground">
                                Scan this with your authenticator, or use the key below.
                            </span>
                        </div>

                        <div className="flex flex-col gap-1">
                            <span className="text-xs text-muted-foreground">Setup key</span>
                            <div className="flex items-center gap-2">
                                <code className="flex-1 break-all rounded-md border border-border bg-muted/30 px-3 py-2 font-mono text-sm">
                                    {groupSecret(secret)}
                                </code>
                                <Button
                                    type="button"
                                    variant="ghost"
                                    size="icon"
                                    aria-label="Copy setup key"
                                    onClick={() => void navigator.clipboard.writeText(secret)}
                                >
                                    <Copy className="size-4" />
                                </Button>
                            </div>
                            <a href={totpUri} className="text-xs text-primary underline-offset-2 hover:underline">
                                Open in an authenticator app
                            </a>
                        </div>

                        <div className="flex flex-col gap-1">
                            <span className="text-xs text-muted-foreground">
                                Backup codes - each works once, store them somewhere safe. They are not shown again.
                            </span>
                            <div className="grid grid-cols-2 gap-1 rounded-md border border-border bg-muted/30 p-2 font-mono text-xs">
                                {backupCodes.map((code) => (
                                    <span key={code}>{code}</span>
                                ))}
                            </div>
                            <div className="flex flex-wrap gap-1">
                                <Button
                                    type="button"
                                    variant="ghost"
                                    size="sm"
                                    onClick={() => void navigator.clipboard.writeText(backupCodes.join("\n"))}
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
                                                onSelect={() => download(backupCodes, entry.format)}
                                            >
                                                {entry.label}
                                            </DropdownMenuItem>
                                        ))}
                                    </DropdownMenuContent>
                                </DropdownMenu>
                                <Button
                                    type="button"
                                    variant="ghost"
                                    size="sm"
                                    onClick={() => printCodes(backupCodes)}
                                >
                                    <Printer className="size-4" />
                                    Print
                                </Button>
                            </div>
                        </div>

                        <label className="flex flex-col gap-1 text-sm">
                            Code from your app
                            <Input
                                name="code"
                                inputMode="numeric"
                                maxLength={6}
                                placeholder="000000"
                                autoComplete="one-time-code"
                                required
                            />
                        </label>
                        <Feedback error={error} />
                        <div className="flex justify-end gap-2">
                            <Button type="button" variant="ghost" onClick={() => onOpenChange(false)}>
                                Cancel
                            </Button>
                            <Button type="submit" disabled={busy}>
                                {busy ? "Verifying..." : "Turn on"}
                            </Button>
                        </div>
                    </form>
                )}
            </DialogContent>
        </Dialog>
    );
}

export function DisableTwoFactorDialog({
    open,
    onOpenChange,
    onDone
}: {
    open: boolean;
    onOpenChange: (open: boolean) => void;
    onDone: () => void;
}) {
    const [busy, setBusy] = useState(false);
    const [error, setError] = useState<string | null>(null);

    async function onSubmit(event: FormEvent<HTMLFormElement>) {
        event.preventDefault();
        const password = String(new FormData(event.currentTarget).get("password") ?? "");
        setBusy(true);
        setError(null);
        const { error: disableError } = await authClient.twoFactor.disable({ password });
        setBusy(false);
        if (disableError) {
            setError(disableError.message ?? "Could not turn it off. Check your password.");
            return;
        }
        onOpenChange(false);
        onDone();
    }

    return (
        <Dialog open={open} onOpenChange={onOpenChange}>
            <DialogContent className="max-w-sm">
                <DialogHeader>
                    <DialogTitle>Turn off the authenticator</DialogTitle>
                    <DialogDescription>
                        Your account will be protected by its password alone. Your backup codes stop working.
                    </DialogDescription>
                </DialogHeader>
                <form onSubmit={onSubmit} className="flex flex-col gap-3">
                    <label className="flex flex-col gap-1 text-sm">
                        Password
                        <Input name="password" type="password" required autoComplete="current-password" />
                    </label>
                    <Feedback error={error} />
                    <div className="flex justify-end gap-2">
                        <Button type="button" variant="ghost" onClick={() => onOpenChange(false)}>
                            Cancel
                        </Button>
                        <Button type="submit" variant="danger" disabled={busy}>
                            {busy ? "Working..." : "Turn off"}
                        </Button>
                    </div>
                </form>
            </DialogContent>
        </Dialog>
    );
}
