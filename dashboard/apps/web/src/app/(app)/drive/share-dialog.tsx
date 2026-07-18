"use client";

/**
 * Create-share dialog, opened per item from the file browser. Produces a public
 * link with optional guardrails (password, expiry, download cap, and - for
 * folders - a drop-box upload flag). The generated link is shown once with a
 * copy button; the raw token is never persisted anywhere the client can read it
 * back, so this is the only chance to copy it.
 */

import { useState, type FormEvent } from "react";
import { Check, Copy, Link2, Share2 } from "lucide-react";
import {
    Button,
    Dialog,
    DialogContent,
    DialogDescription,
    DialogHeader,
    DialogTitle,
    DialogTrigger,
    Input
} from "@polaris/ui";
import { createShareAction } from "./share-actions";

export function ShareButton({
    connectionId,
    path,
    name,
    isDir
}: {
    connectionId: string;
    path: string;
    name: string;
    isDir: boolean;
}) {
    const [open, setOpen] = useState(false);
    const [pending, setPending] = useState(false);
    const [error, setError] = useState<string | null>(null);
    const [url, setUrl] = useState<string | null>(null);
    const [copied, setCopied] = useState(false);

    function reset(next: boolean) {
        setOpen(next);
        if (next) {
            setError(null);
            setUrl(null);
            setCopied(false);
        }
    }

    async function onSubmit(event: FormEvent<HTMLFormElement>) {
        event.preventDefault();
        setPending(true);
        setError(null);
        const form = new FormData(event.currentTarget);
        const maxDownloads = form.get("maxDownloads");
        const expiresAt = form.get("expiresAt");
        const password = String(form.get("password") ?? "");
        const result = await createShareAction({
            connectionId,
            path,
            kind: "public",
            password: password || undefined,
            maxDownloads: maxDownloads ? Number(maxDownloads) : undefined,
            expiresAt: expiresAt ? String(expiresAt) : undefined,
            allowUpload: form.get("allowUpload") === "on"
        });
        setPending(false);
        if (result.error) {
            setError(result.error);
            return;
        }
        setUrl(result.url ?? null);
    }

    async function onCopy() {
        if (!url) return;
        await navigator.clipboard.writeText(url);
        setCopied(true);
    }

    return (
        <Dialog open={open} onOpenChange={reset}>
            <DialogTrigger asChild>
                <Button size="icon" variant="ghost" aria-label={`Share ${name}`}>
                    <Share2 className="size-4" />
                </Button>
            </DialogTrigger>
            <DialogContent>
                <DialogHeader>
                    <DialogTitle>Share {isDir ? "folder" : "file"}</DialogTitle>
                    <DialogDescription className="truncate">{name}</DialogDescription>
                </DialogHeader>

                {url ? (
                    <div className="flex flex-col gap-3">
                        <p className="text-sm text-muted-foreground">
                            Anyone with this link can access it under the limits you set. Copy it now - it is
                            shown only once.
                        </p>
                        <div className="flex items-center gap-2">
                            <Input readOnly value={url} className="font-mono text-xs" />
                            <Button type="button" size="icon" variant="secondary" onClick={onCopy}>
                                {copied ? <Check className="size-4 text-success" /> : <Copy className="size-4" />}
                            </Button>
                        </div>
                        <div className="flex justify-end">
                            <Button type="button" onClick={() => setOpen(false)}>
                                Done
                            </Button>
                        </div>
                    </div>
                ) : (
                    <form onSubmit={onSubmit} className="flex flex-col gap-3">
                        <label className="flex flex-col gap-1 text-sm">
                            Password (optional)
                            <Input name="password" type="password" placeholder="No password" autoComplete="off" />
                        </label>
                        <div className="grid grid-cols-2 gap-3">
                            <label className="flex flex-col gap-1 text-sm">
                                Max downloads
                                <Input name="maxDownloads" type="number" min="1" placeholder="Unlimited" />
                            </label>
                            <label className="flex flex-col gap-1 text-sm">
                                Expires
                                <Input name="expiresAt" type="date" />
                            </label>
                        </div>
                        {isDir ? (
                            <label className="flex items-center gap-2 text-sm">
                                <input type="checkbox" name="allowUpload" className="size-4" />
                                Allow recipients to upload into this folder
                            </label>
                        ) : null}
                        {error ? <p className="text-sm text-danger">{error}</p> : null}
                        <div className="mt-1 flex justify-end gap-2">
                            <Button type="submit" disabled={pending}>
                                <Link2 className="size-4" />
                                {pending ? "Creating..." : "Create link"}
                            </Button>
                        </div>
                    </form>
                )}
            </DialogContent>
        </Dialog>
    );
}
