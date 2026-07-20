"use client";

/**
 * Create-a-drop-point dialog. A drop point is a public link that collects
 * uploads into the chosen folder. Controlled by a `target` so it can be opened
 * from the Files toolbar (the current folder) or a folder's context menu. The
 * uploader can be constrained by file type (category presets and/or manual
 * extensions), per-file size, total count, expiry, and an IP/CIDR allowlist -
 * all re-validated server-side on every upload. The generated link is shown once.
 */

import { useState, type FormEvent } from "react";
import { Check, Copy, Inbox } from "lucide-react";
import {
    Button,
    Dialog,
    DialogContent,
    DialogDescription,
    DialogHeader,
    DialogTitle,
    Input,
    Select,
    cn
} from "@polaris/ui";
import { GeoPicker } from "@/components/geo-picker";
import { ExpirySelect } from "@/components/expiry-select";
import { FILE_CATEGORIES, categoryDef, type FileCategory } from "./file-categories";
import { createFileRequestAction } from "./request-actions";

export interface RequestTarget {
    connectionId: string;
    path: string;
    /** Folder name for the dialog heading; "" for the connection root. */
    name: string;
}

/** Prefill for the create form, used when cloning an existing drop point's config. */
export interface RequestInitial {
    title?: string;
    instructions?: string;
    extensions?: string;
    maxMb?: number;
    maxFiles?: number;
    requireLogin?: boolean;
    allowedCidrs?: string;
    geoCountries?: string[];
    geoContinents?: string[];
}

export function RequestDialog({
    target,
    onOpenChange,
    connections,
    initial
}: {
    target: RequestTarget | null;
    onOpenChange: (open: boolean) => void;
    /** When the target has no connectionId, these let the user pick a destination. */
    connections?: { id: string; name: string }[];
    /** Optional values to prefill the form with (clone). */
    initial?: RequestInitial;
}) {
    const [categories, setCategories] = useState<Set<FileCategory>>(new Set());
    const [pending, setPending] = useState(false);
    const [error, setError] = useState<string | null>(null);
    const [url, setUrl] = useState<string | null>(null);
    const [copied, setCopied] = useState(false);
    const [pickConnection, setPickConnection] = useState("");
    const [pickPath, setPickPath] = useState("");
    const [geoCountries, setGeoCountries] = useState<string[]>([]);
    const [geoContinents, setGeoContinents] = useState<string[]>([]);
    const [expiry, setExpiry] = useState("");

    // Picker mode: opened from the Drop points page with no fixed folder, so the
    // user chooses which connection and folder to collect into.
    const needsPicker =
        target !== null && target.connectionId === "" && (connections?.length ?? 0) > 0;

    function handleOpenChange(next: boolean) {
        if (next) {
            setCategories(new Set());
            setError(null);
            setUrl(null);
            setCopied(false);
            setPickConnection(connections?.[0]?.id ?? "");
            setPickPath("");
            setGeoCountries(initial?.geoCountries ?? []);
            setGeoContinents(initial?.geoContinents ?? []);
            setExpiry("");
        }
        onOpenChange(next);
    }

    function toggleCategory(id: FileCategory) {
        setCategories((prev) => {
            const next = new Set(prev);
            if (next.has(id)) next.delete(id);
            else next.add(id);
            return next;
        });
    }

    async function onSubmit(event: FormEvent<HTMLFormElement>) {
        event.preventDefault();
        if (!target) return;
        setPending(true);
        setError(null);
        const form = new FormData(event.currentTarget);

        // The allowed-type gate is expressed purely as extensions: category presets
        // contribute their extension lists and the manual field adds any extras. An
        // empty result means any file type is accepted.
        const manual = String(form.get("extensions") ?? "")
            .split(/[\s,]+/)
            .map((value) => value.trim().replace(/^\./, "").toLowerCase())
            .filter(Boolean);
        const fromCategories = [...categories].flatMap((id) => categoryDef(id)?.extensions ?? []);
        const allowedExtensions = Array.from(new Set([...fromCategories, ...manual]));

        const allowedCidrs = String(form.get("allowedCidrs") ?? "")
            .split(/[\s,]+/)
            .map((value) => value.trim())
            .filter(Boolean);
        const maxFiles = form.get("maxFiles");
        const maxMb = Number(form.get("maxMb") ?? 0);

        const destinationConnectionId = needsPicker ? pickConnection : target.connectionId;
        const destinationPath = needsPicker
            ? pickPath.trim().replace(/^\/+|\/+$/g, "")
            : target.path;
        if (!destinationConnectionId) {
            setPending(false);
            setError("Choose a connection to collect into");
            return;
        }

        const result = await createFileRequestAction({
            title: String(form.get("title") ?? "").trim(),
            instructions: String(form.get("instructions") ?? "").trim() || undefined,
            destinationConnectionId,
            destinationPath,
            requireLogin: form.get("requireLogin") === "on",
            password: String(form.get("password") ?? "").trim() || undefined,
            maxSizeBytes: maxMb > 0 ? Math.floor(maxMb * 1024 * 1024) : 1024 * 1024 * 1024,
            maxFiles: maxFiles ? Number(maxFiles) : undefined,
            allowedExtensions,
            allowedMimeTypes: [],
            allowedCidrs,
            allowedCountries: geoCountries,
            allowedContinents: geoContinents,
            expiresAt: expiry || undefined
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
            <DialogContent className="max-h-[85vh] overflow-y-auto">
                <DialogHeader>
                    <DialogTitle>Request files</DialogTitle>
                    <DialogDescription className="truncate">
                        {needsPicker
                            ? "Choose where uploads should be collected."
                            : `Collect uploads into ${target?.name ? `"${target.name}"` : "this connection"}.`}
                    </DialogDescription>
                </DialogHeader>

                {url ? (
                    <div className="flex flex-col gap-3">
                        <p className="text-sm text-muted-foreground">
                            Share this link to collect files. It is shown only once - copy it now.
                        </p>
                        <div className="flex items-center gap-2">
                            <Input readOnly value={url} className="font-mono text-xs" />
                            <Button type="button" size="icon" variant="secondary" onClick={onCopy}>
                                {copied ? (
                                    <Check className="size-4 text-success" />
                                ) : (
                                    <Copy className="size-4" />
                                )}
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
                        {needsPicker ? (
                            <div className="grid grid-cols-2 gap-3">
                                <label className="flex flex-col gap-1 text-sm">
                                    Connection
                                    <Select
                                        value={pickConnection}
                                        onValueChange={setPickConnection}
                                        options={(connections ?? []).map((connection) => ({
                                            value: connection.id,
                                            label: connection.name
                                        }))}
                                    />
                                </label>
                                <label className="flex flex-col gap-1 text-sm">
                                    Destination folder
                                    <Input
                                        value={pickPath}
                                        onChange={(event) => setPickPath(event.target.value)}
                                        placeholder="Root (leave empty)"
                                        autoComplete="off"
                                    />
                                </label>
                            </div>
                        ) : null}
                        <label className="flex flex-col gap-1 text-sm">
                            Title
                            <Input
                                name="title"
                                required
                                defaultValue={initial?.title}
                                placeholder="e.g. Send me your photos"
                                autoComplete="off"
                            />
                            <span className="text-xs text-muted-foreground">
                                Uploads collect in a folder named after this drop point, under
                                &quot;Drop Points&quot;.
                            </span>
                        </label>
                        <label className="flex flex-col gap-1 text-sm">
                            Instructions (optional)
                            <textarea
                                name="instructions"
                                rows={2}
                                defaultValue={initial?.instructions}
                                placeholder="What should people upload?"
                                className="max-h-48 min-h-[2.5rem] resize-y rounded-md border border-input bg-surface px-3 py-2 text-sm"
                            />
                        </label>

                        <div className="flex flex-col gap-1.5 text-sm">
                            <span>Allowed file types</span>
                            <div className="flex flex-wrap gap-1.5">
                                {FILE_CATEGORIES.map((category) => (
                                    <button
                                        key={category.id}
                                        type="button"
                                        onClick={() => toggleCategory(category.id)}
                                        className={cn(
                                            "rounded-full border px-3 py-1 text-xs transition-colors",
                                            categories.has(category.id)
                                                ? "border-primary bg-primary/10 text-primary"
                                                : "border-border text-muted-foreground hover:bg-muted"
                                        )}
                                    >
                                        {category.label}
                                    </button>
                                ))}
                            </div>
                            <span className="text-xs text-muted-foreground">
                                Leave all off to allow any file type.
                            </span>
                        </div>
                        <label className="flex flex-col gap-1 text-sm">
                            Also allow these extensions (optional)
                            <Input
                                name="extensions"
                                defaultValue={initial?.extensions}
                                placeholder="e.g. psd, ai, sketch"
                                autoComplete="off"
                            />
                        </label>

                        <div className="grid grid-cols-2 gap-3">
                            <label className="flex flex-col gap-1 text-sm">
                                Max size (MB)
                                <Input
                                    name="maxMb"
                                    type="number"
                                    min="1"
                                    defaultValue={initial?.maxMb}
                                    placeholder="1024"
                                />
                            </label>
                            <label className="flex flex-col gap-1 text-sm">
                                Max files
                                <Input
                                    name="maxFiles"
                                    type="number"
                                    min="1"
                                    defaultValue={initial?.maxFiles}
                                    placeholder="No limit"
                                />
                            </label>
                        </div>
                        <div className="flex flex-col gap-1 text-sm">
                            Expires
                            <ExpirySelect onChange={setExpiry} />
                        </div>

                        <label className="flex flex-col gap-1 text-sm">
                            Restrict to IPs / ranges (optional)
                            <Input
                                name="allowedCidrs"
                                defaultValue={initial?.allowedCidrs}
                                placeholder="e.g. 203.0.113.4, 10.0.0.0/24"
                                autoComplete="off"
                            />
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
                        <label className="flex flex-col gap-1 text-sm">
                            Access PIN (optional)
                            <Input
                                name="password"
                                type="password"
                                placeholder="No PIN"
                                autoComplete="off"
                            />
                        </label>
                        <label className="flex items-center gap-2 text-sm">
                            <input
                                type="checkbox"
                                name="requireLogin"
                                defaultChecked={initial?.requireLogin}
                                className="size-4"
                            />
                            Require uploaders to sign in
                        </label>

                        {error ? <p className="text-sm text-danger">{error}</p> : null}
                        <div className="mt-1 flex justify-end gap-2">
                            <Button type="submit" disabled={pending}>
                                <Inbox className="size-4" />
                                {pending ? "Creating..." : "Create drop point"}
                            </Button>
                        </div>
                    </form>
                )}
            </DialogContent>
        </Dialog>
    );
}
