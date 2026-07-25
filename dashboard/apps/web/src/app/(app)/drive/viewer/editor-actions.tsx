"use client";

/**
 * The action bar every editable viewer shares: overwrite the file, write a named
 * copy beside it, or download the edited bytes without storing anything. Each
 * editor only supplies the exporter; write access, name validation, collisions
 * and failures are handled identically here.
 */

import { useEffect, useState } from "react";
import { Copy, Download, Save } from "lucide-react";
import { Button, Dialog, DialogContent, DialogHeader, DialogTitle, Input } from "@polaris/ui";
import {
    copyNameFor,
    downloadBytes,
    fileNameSchema,
    saveFileBytes,
    siblingNames,
    withExtension
} from "./save";
import type { EditorExport, ViewerTarget } from "./types";

export function EditorActions({
    target,
    exportAs,
    dirty,
    exportExtension,
    onSaved
}: {
    target: ViewerTarget;
    exportAs: EditorExport;
    /** Whether there is anything to write back (drives the Save button). */
    dirty: boolean;
    /** Set when the editor can only write another format ("xlsx" for a legacy .xls),
     *  which rules out overwriting the original and renames every export. */
    exportExtension?: string;
    /** Called with the written name after a successful save, to refresh the listing. */
    onSaved?: (name: string) => void;
}) {
    const [busy, setBusy] = useState<"save" | "download" | null>(null);
    const [error, setError] = useState<string | null>(null);
    const [copyOpen, setCopyOpen] = useState(false);

    const exportName = exportExtension ? withExtension(target.name, exportExtension) : target.name;
    // A format change must never overwrite the original: the copy keeps the source
    // file intact and carries the extension the editor can actually write.
    const canOverwrite = !exportExtension;

    async function overwrite() {
        setBusy("save");
        setError(null);
        const blob = await exportAs(target.name).catch(() => null);
        const message = blob
            ? await saveFileBytes(target, target.name, blob)
            : "Could not prepare this file.";
        setBusy(null);
        if (message) {
            setError(message);
            return;
        }
        onSaved?.(target.name);
    }

    async function download() {
        setBusy("download");
        setError(null);
        const blob = await exportAs(exportName).catch(() => null);
        setBusy(null);
        if (!blob) {
            setError("Could not prepare this file.");
            return;
        }
        downloadBytes(blob, exportName);
    }

    return (
        <div className="flex items-center gap-2">
            {error ? <span className="text-xs text-danger">{error}</span> : null}
            <Button size="sm" variant="ghost" onClick={download} disabled={busy !== null}>
                <Download className="size-4" />
                {busy === "download" ? "Preparing..." : "Download"}
            </Button>
            <Button
                size="sm"
                variant="ghost"
                onClick={() => setCopyOpen(true)}
                disabled={busy !== null}
            >
                <Copy className="size-4" />
                Save a copy
            </Button>
            {canOverwrite ? (
                <Button size="sm" onClick={overwrite} disabled={!dirty || busy !== null}>
                    <Save className="size-4" />
                    {busy === "save" ? "Saving..." : "Save"}
                </Button>
            ) : null}
            <SaveCopyDialog
                open={copyOpen}
                onOpenChange={setCopyOpen}
                target={target}
                exportAs={exportAs}
                defaultName={copyNameFor(target.name, exportExtension)}
                onSaved={onSaved}
            />
        </div>
    );
}

/** Name-and-save dialog for "Save a copy", including a replace warning. */
function SaveCopyDialog({
    open,
    onOpenChange,
    target,
    exportAs,
    defaultName,
    onSaved
}: {
    open: boolean;
    onOpenChange: (open: boolean) => void;
    target: ViewerTarget;
    exportAs: EditorExport;
    defaultName: string;
    onSaved?: (name: string) => void;
}) {
    const [name, setName] = useState(defaultName);
    const [taken, setTaken] = useState<Set<string>>(new Set());
    const [saving, setSaving] = useState(false);
    const [error, setError] = useState<string | null>(null);

    useEffect(() => {
        if (!open) return;
        setName(defaultName);
        setError(null);
        let alive = true;
        void siblingNames(target).then((names) => {
            if (alive) setTaken(names);
        });
        return () => {
            alive = false;
        };
    }, [open, defaultName, target]);

    const parsed = fileNameSchema.safeParse(name);
    const problem = parsed.success
        ? null
        : (parsed.error.issues[0]?.message ?? "That name is not valid");
    const replaces = parsed.success && taken.has(parsed.data.toLowerCase());

    async function submit(event: React.FormEvent) {
        event.preventDefault();
        if (!parsed.success || saving) return;
        setSaving(true);
        setError(null);
        const blob = await exportAs(parsed.data).catch(() => null);
        const message = blob
            ? await saveFileBytes(target, parsed.data, blob)
            : "Could not prepare this file.";
        setSaving(false);
        if (message) {
            setError(message);
            return;
        }
        onOpenChange(false);
        onSaved?.(parsed.data);
    }

    return (
        <Dialog open={open} onOpenChange={onOpenChange}>
            <DialogContent className="max-w-md">
                <DialogHeader>
                    <DialogTitle>Save a copy</DialogTitle>
                </DialogHeader>
                <form onSubmit={submit} className="flex flex-col gap-3">
                    <label className="flex flex-col gap-1.5 text-sm">
                        <span className="text-muted-foreground">Name</span>
                        <Input
                            autoFocus
                            value={name}
                            onChange={(event) => setName(event.target.value)}
                            spellCheck={false}
                        />
                    </label>
                    {problem ? (
                        <p className="text-xs text-danger">{problem}</p>
                    ) : replaces ? (
                        <p className="text-xs text-warning">
                            A file with this name already exists here and will be replaced.
                        </p>
                    ) : null}
                    {error ? <p className="text-xs text-danger">{error}</p> : null}
                    <div className="flex justify-end gap-2">
                        <Button
                            type="button"
                            size="sm"
                            variant="ghost"
                            onClick={() => onOpenChange(false)}
                            disabled={saving}
                        >
                            Cancel
                        </Button>
                        <Button type="submit" size="sm" disabled={!parsed.success || saving}>
                            {saving ? "Saving..." : replaces ? "Replace" : "Save copy"}
                        </Button>
                    </div>
                </form>
            </DialogContent>
        </Dialog>
    );
}
