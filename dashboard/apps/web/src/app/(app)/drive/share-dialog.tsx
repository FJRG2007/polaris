"use client";

/**
 * Create-share dialog. Controlled by a list of `targets` so it can be opened from
 * a row action, a right-click context menu or the toolbar (one dialog instance,
 * not one per row) - and so a multi-selection shares every item it holds rather
 * than the one that happened to be right-clicked. One set of guardrails applies
 * to all of them: password, expiry, download cap, an IP/CIDR allowlist, whether
 * downloads and previews are permitted, and for folders a drop-box upload flag.
 * Each item gets its own link, shown once with a copy button; the raw tokens are
 * never persisted anywhere the client can read them back, so this is the only
 * chance to copy them.
 */

import { Check, Copy, Link2 } from "lucide-react";
import { GeoPicker } from "@/components/geo-picker";
import { createShareAction } from "./share-actions";
import { useEffect, useState, type FormEvent } from "react";
import {
    Button,
    Dialog,
    DialogContent,
    DialogDescription,
    DialogHeader,
    DialogTitle,
    Input
} from "@polaris/ui";

export interface ShareTarget {
    connectionId: string;
    path: string;
    name: string;
    isDir: boolean;
}

/** One target's outcome: the link that was minted, or why it could not be. */
interface ShareResult {
    path: string;
    name: string;
    url?: string;
    error?: string;
}

export function ShareDialog({
    targets,
    onOpenChange
}: {
    targets: ShareTarget[] | null;
    onOpenChange: (open: boolean) => void;
}) {
    const [pending, setPending] = useState(false);
    const [error, setError] = useState<string | null>(null);
    const [results, setResults] = useState<ShareResult[] | null>(null);
    const [copied, setCopied] = useState<string | null>(null);
    const [geoCountries, setGeoCountries] = useState<string[]>([]);
    const [geoContinents, setGeoContinents] = useState<string[]>([]);

    const items = targets ?? [];
    const many = items.length > 1;
    // Folder-only permissions are offered whenever the selection holds a folder;
    // they are ignored for the files in it, which have nothing to drop into.
    const anyDir = items.some((target) => target.isDir);
    const links = (results ?? []).filter((result) => result.url);

    // The dialog opens by its targets changing, never through onOpenChange, so
    // this is the only thing that can clear the last run: without it, sharing a
    // second item shows the first one's link instead of the form.
    const targetKey = items.map((target) => `${target.connectionId}:${target.path}`).join("|");
    useEffect(() => {
        setError(null);
        setResults(null);
        setCopied(null);
        setGeoCountries([]);
        setGeoContinents([]);
    }, [targetKey]);

    async function onSubmit(event: FormEvent<HTMLFormElement>) {
        event.preventDefault();
        if (items.length === 0) return;
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
        const guardrails = {
            kind: "public" as const,
            password: password || undefined,
            maxDownloads: maxDownloads ? Number(maxDownloads) : undefined,
            expiresAt: expiresAt ? String(expiresAt) : undefined,
            allowUpload: form.get("allowUpload") === "on",
            allowRename: form.get("allowRename") === "on",
            allowDelete: form.get("allowDelete") === "on",
            allowCreateFolder: form.get("allowCreateFolder") === "on",
            allowOverwrite: form.get("allowOverwrite") === "on",
            allowDownload: form.get("allowDownload") === "on",
            allowPreview: form.get("allowPreview") === "on",
            allowedCidrs,
            allowedCountries: geoCountries,
            allowedContinents: geoContinents
        };

        // One at a time: each link is its own row, and a target that fails should
        // report against its own name rather than sink the ones that worked.
        const created: ShareResult[] = [];
        for (const target of items) {
            const result = await createShareAction({
                ...guardrails,
                connectionId: target.connectionId,
                path: target.path
            });
            created.push({
                path: target.path,
                name: target.name,
                url: result.url,
                error: result.error
            });
        }
        setPending(false);
        if (created.every((result) => result.error)) {
            setError(created[0]?.error ?? "Could not create the link.");
            return;
        }
        setResults(created);
    }

    async function onCopy(key: string, value: string) {
        await navigator.clipboard.writeText(value);
        setCopied(key);
    }

    return (
        <Dialog open={items.length > 0} onOpenChange={onOpenChange}>
            <DialogContent>
                <DialogHeader>
                    <DialogTitle>
                        {many
                            ? `Share ${items.length} items`
                            : `Share ${items[0]?.isDir ? "folder" : "file"}`}
                    </DialogTitle>
                    <DialogDescription className="truncate">
                        {many
                            ? items.map((target) => target.name).join(", ")
                            : items[0]?.name}
                    </DialogDescription>
                </DialogHeader>

                {results ? (
                    <div className="flex flex-col gap-3">
                        <p className="text-sm text-muted-foreground">
                            Anyone with {many ? "these links" : "this link"} can access{" "}
                            {many ? "them" : "it"} under the limits you set. Copy{" "}
                            {many ? "them" : "it"} now - {many ? "they are" : "it is"} shown only
                            once.
                        </p>
                        <div className="flex max-h-64 flex-col gap-2 overflow-auto">
                            {results.map((result) => (
                                <div key={result.path} className="flex flex-col gap-1">
                                    {many ? (
                                        <span className="truncate text-xs text-muted-foreground">
                                            {result.name}
                                        </span>
                                    ) : null}
                                    {result.url ? (
                                        <div className="flex items-center gap-2">
                                            <Input
                                                readOnly
                                                value={result.url}
                                                className="font-mono text-xs"
                                            />
                                            <Button
                                                type="button"
                                                size="icon"
                                                variant="secondary"
                                                onClick={() =>
                                                    onCopy(result.path, result.url ?? "")
                                                }
                                                title={`Copy the link to ${result.name}`}
                                                aria-label={`Copy the link to ${result.name}`}
                                            >
                                                {copied === result.path ? (
                                                    <Check className="size-4 text-success" />
                                                ) : (
                                                    <Copy className="size-4" />
                                                )}
                                            </Button>
                                        </div>
                                    ) : (
                                        <p className="text-sm text-danger">{result.error}</p>
                                    )}
                                </div>
                            ))}
                        </div>
                        <div className="flex justify-end gap-2">
                            {links.length > 1 ? (
                                <Button
                                    type="button"
                                    variant="secondary"
                                    onClick={() =>
                                        onCopy(
                                            "all",
                                            links.map((result) => result.url).join("\n")
                                        )
                                    }
                                >
                                    {copied === "all" ? (
                                        <Check className="size-4 text-success" />
                                    ) : (
                                        <Copy className="size-4" />
                                    )}
                                    Copy all links
                                </Button>
                            ) : null}
                            <Button type="button" onClick={() => onOpenChange(false)}>
                                Done
                            </Button>
                        </div>
                    </div>
                ) : (
                    <form onSubmit={onSubmit} className="flex flex-col gap-3">
                        {many ? (
                            <p className="text-sm text-muted-foreground">
                                Each item gets its own link under the settings below.
                            </p>
                        ) : null}
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
                            {anyDir ? (
                                <>
                                    <label className="flex items-center gap-2">
                                        <input type="checkbox" name="allowUpload" className="size-4" />
                                        Allow uploading into {many ? "the shared folders" : "this folder"} (drop box)
                                    </label>
                                    <label className="flex items-center gap-2">
                                        <input type="checkbox" name="allowOverwrite" className="size-4" />
                                        Let an upload replace a file of the same name
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
                                {pending
                                    ? "Creating..."
                                    : many
                                      ? `Create ${items.length} links`
                                      : "Create link"}
                            </Button>
                        </div>
                    </form>
                )}
            </DialogContent>
        </Dialog>
    );
}
