"use client";

/**
 * Create-share dialog. Controlled by a `target` so it can be opened from a row
 * action or a right-click context menu (one dialog instance, not one per row).
 * Produces a public link with optional guardrails - password, expiry, download
 * cap, an IP/CIDR allowlist, whether downloads and previews are permitted, and
 * for folders a drop-box upload flag. The generated link is shown once with a
 * copy button; the raw token is never persisted anywhere the client can read it
 * back, so this is the only chance to copy it.
 */

import { useState, type FormEvent } from "react";
import { Check, Copy, Link2 } from "lucide-react";
import {
    Button,
    Dialog,
    DialogContent,
    DialogDescription,
    DialogHeader,
    DialogTitle,
    Input
} from "@polaris/ui";
import { GeoPicker } from "@/components/geo-picker";
import { createShareAction } from "./share-actions";

export interface ShareTarget {
    connectionId: string;
    path: string;
    name: string;
    isDir: boolean;
}

export function ShareDialog({
    target,
    onOpenChange
}: {
    target: ShareTarget | null;
    onOpenChange: (open: boolean) => void;
}) {
    const [pending, setPending] = useState(false);
    const [error, setError] = useState<string | null>(null);
    const [url, setUrl] = useState<string | null>(null);
    const [copied, setCopied] = useState(false);
    const [geoCountries, setGeoCountries] = useState<string[]>([]);
    const [geoContinents, setGeoContinents] = useState<string[]>([]);

    function handleOpenChange(next: boolean) {
        if (next) {
            setError(null);
            setUrl(null);
            setCopied(false);
            setGeoCountries([]);
            setGeoContinents([]);
        }
        onOpenChange(next);
    }

    async function onSubmit(event: FormEvent<HTMLFormElement>) {
        event.preventDefault();
        if (!target) return;
        setPending(true);
        setError(null);
        const form = new FormData(event.currentTarget);
        const maxDownloads = form.get("maxDownloads");
        const expiresAt = form.get("expiresAt");
        const password = String(form.get("password") ?? "");
        const allowedCidrs = String(form.get("allowedCidrs") ?? "")
            .split(/[\s,]+/)
            .map((value) => value.trim())
            .filter(Boolean);
        const result = await createShareAction({
            connectionId: target.connectionId,
            path: target.path,
            kind: "public",
            password: password || undefined,
            maxDownloads: maxDownloads ? Number(maxDownloads) : undefined,
            expiresAt: expiresAt ? String(expiresAt) : undefined,
            allowUpload: form.get("allowUpload") === "on",
            allowRename: form.get("allowRename") === "on",
            allowDelete: form.get("allowDelete") === "on",
            allowCreateFolder: form.get("allowCreateFolder") === "on",
            allowDownload: form.get("allowDownload") !== "off",
            allowPreview: form.get("allowPreview") !== "off",
            allowedCidrs,
            allowedCountries: geoCountries,
            allowedContinents: geoContinents
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
        <Dialog open={target !== null} onOpenChange={handleOpenChange}>
            <DialogContent>
                <DialogHeader>
                    <DialogTitle>Share {target?.isDir ? "folder" : "file"}</DialogTitle>
                    <DialogDescription className="truncate">{target?.name}</DialogDescription>
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
                            <Button type="button" onClick={() => onOpenChange(false)}>
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
                        <label className="flex flex-col gap-1 text-sm">
                            Restrict to IPs / ranges (optional)
                            <Input name="allowedCidrs" placeholder="e.g. 203.0.113.4, 10.0.0.0/24" autoComplete="off" />
                            <span className="text-xs text-muted-foreground">
                                Comma or space separated. Empty means anyone with the link.
                            </span>
                        </label>
                        <div className="flex flex-col gap-1 text-sm">
                            Restrict by location (optional)
                            <GeoPicker
                                countries={geoCountries}
                                continents={geoContinents}
                                onCountries={setGeoCountries}
                                onContinents={setGeoContinents}
                            />
                        </div>
                        <div className="flex flex-col gap-2 rounded-md border border-border p-3 text-sm">
                            <label className="flex items-center gap-2">
                                <input type="checkbox" name="allowDownload" defaultChecked className="size-4" />
                                Allow downloading
                            </label>
                            <label className="flex items-center gap-2">
                                <input type="checkbox" name="allowPreview" defaultChecked className="size-4" />
                                Allow previewing in the browser
                            </label>
                            {target?.isDir ? (
                                <>
                                    <label className="flex items-center gap-2">
                                        <input type="checkbox" name="allowUpload" className="size-4" />
                                        Allow uploading into this folder (drop box)
                                    </label>
                                    <label className="flex items-center gap-2">
                                        <input type="checkbox" name="allowCreateFolder" className="size-4" />
                                        Allow creating folders
                                    </label>
                                    <label className="flex items-center gap-2">
                                        <input type="checkbox" name="allowRename" className="size-4" />
                                        Allow renaming and moving items
                                    </label>
                                    <label className="flex items-center gap-2">
                                        <input type="checkbox" name="allowDelete" className="size-4" />
                                        Allow deleting items (permanent)
                                    </label>
                                </>
                            ) : null}
                        </div>
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
