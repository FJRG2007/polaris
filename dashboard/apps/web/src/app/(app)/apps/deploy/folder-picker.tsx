"use client";

/**
 * Folder browser for the volume form: navigate a NAS connection's directories and
 * pick one as the volume source, instead of typing a path. Folders only - files
 * are never a mount source. Listing goes through listNasFoldersAction, which is
 * owner-scoped on the server.
 */

import { useEffect, useState } from "react";
import { ArrowUp, Folder, Loader2 } from "lucide-react";
import { Button, Dialog, DialogContent, DialogHeader, DialogTitle } from "@polaris/ui";
import { listNasFoldersAction } from "./actions";

export function FolderPicker({
    connectionId,
    open,
    onOpenChange,
    onPick
}: {
    connectionId: string;
    open: boolean;
    onOpenChange: (open: boolean) => void;
    onPick: (path: string) => void;
}) {
    const [path, setPath] = useState("");
    const [folders, setFolders] = useState<string[]>([]);
    const [error, setError] = useState<string | null>(null);
    const [busy, setBusy] = useState(false);

    async function load(next: string) {
        setBusy(true);
        setError(null);
        const result = await listNasFoldersAction(connectionId, next);
        if (result.error) setError(result.error);
        else {
            setFolders(result.folders);
            setPath(next);
        }
        setBusy(false);
    }

    useEffect(() => {
        if (open) void load("");
        // eslint-disable-next-line react-hooks/exhaustive-deps
    }, [open, connectionId]);

    function up() {
        const parts = path.split("/").filter(Boolean);
        parts.pop();
        void load(parts.join("/"));
    }

    return (
        <Dialog open={open} onOpenChange={onOpenChange}>
            <DialogContent className="max-w-md">
                <DialogHeader>
                    <DialogTitle>Choose a folder</DialogTitle>
                </DialogHeader>
                <div className="flex items-center gap-2">
                    <Button variant="ghost" size="sm" onClick={up} disabled={busy || !path} title="Up">
                        <ArrowUp className="size-4" />
                    </Button>
                    <span className="truncate text-xs text-muted-foreground">/{path}</span>
                    {busy && <Loader2 className="ml-auto size-4 animate-spin text-muted-foreground" />}
                </div>
                {error && <p className="text-xs text-red-400">{error}</p>}
                <div className="max-h-72 overflow-auto rounded-md border border-border/60">
                    {folders.length === 0 && !busy && <p className="p-3 text-xs text-muted-foreground">No sub-folders here.</p>}
                    {folders.map((name) => (
                        <button
                            key={name}
                            type="button"
                            onClick={() => void load(path ? `${path}/${name}` : name)}
                            className="flex w-full items-center gap-2 border-b border-border/40 px-3 py-1.5 text-left text-sm transition-colors last:border-0 hover:bg-muted"
                        >
                            <Folder className="size-4 shrink-0 text-sky-400" /> {name}
                        </button>
                    ))}
                </div>
                <div className="flex items-center justify-end gap-2">
                    <Button variant="ghost" size="sm" onClick={() => onOpenChange(false)}>
                        Cancel
                    </Button>
                    <Button
                        size="sm"
                        onClick={() => {
                            onPick(path);
                            onOpenChange(false);
                        }}
                    >
                        Use this folder
                    </Button>
                </div>
            </DialogContent>
        </Dialog>
    );
}
