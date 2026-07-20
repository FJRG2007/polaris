"use client";

/**
 * Zip actions for the current selection: bundle the selected items into a zip
 * written to the NAS, optionally AES-encrypted with a password, and optionally
 * mint a share link for the result. Self-contained - it drives generateZipAction
 * and createShareAction and shows any resulting link inline (copy to clipboard),
 * so it needs no wiring from the parent beyond the selection.
 */

import { useState, type FormEvent } from "react";
import { useRouter } from "next/navigation";
import { Check, Copy, FileArchive } from "lucide-react";
import {
    Button,
    Dialog,
    DialogClose,
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
import type { DriveEntry } from "./types";
import { generateZipAction } from "./actions";
import { createShareAction } from "./share-actions";

export function SelectionZipMenu({
    connectionId,
    entries,
    currentPath
}: {
    connectionId: string;
    entries: DriveEntry[];
    currentPath: string;
}) {
    const router = useRouter();
    const [open, setOpen] = useState(false);
    const [withLink, setWithLink] = useState(false);
    const [pending, setPending] = useState(false);
    const [error, setError] = useState<string | null>(null);
    const [link, setLink] = useState<string | null>(null);
    const [copied, setCopied] = useState(false);

    function start(makeLink: boolean) {
        setWithLink(makeLink);
        setError(null);
        setLink(null);
        setCopied(false);
        setOpen(true);
    }

    async function onSubmit(event: FormEvent<HTMLFormElement>) {
        event.preventDefault();
        setPending(true);
        setError(null);
        const form = new FormData(event.currentTarget);
        const name = String(form.get("name") ?? "archive");
        const password = String(form.get("password") ?? "");
        const paths = entries.map((entry) => entry.path);

        const result = await generateZipAction(connectionId, paths, currentPath, name, password || undefined);
        if (result.error || !result.path) {
            setPending(false);
            setError(result.error ?? "Could not create the archive");
            return;
        }

        if (withLink) {
            const share = await createShareAction({
                connectionId,
                path: result.path,
                kind: "public",
                allowDownload: true,
                allowPreview: true
            });
            setPending(false);
            if (share.error || !share.url) {
                setError(share.error ?? "Archive created, but the link failed");
                return;
            }
            setLink(share.url);
            router.refresh();
            return;
        }

        setPending(false);
        setOpen(false);
        router.refresh();
    }

    async function copyLink() {
        if (!link) return;
        await navigator.clipboard.writeText(link);
        setCopied(true);
    }

    return (
        <Dialog open={open} onOpenChange={setOpen}>
            <DropdownMenu>
                <DropdownMenuTrigger asChild>
                    <Button size="sm" variant="ghost">
                        <FileArchive className="size-4" />
                        Zip
                    </Button>
                </DropdownMenuTrigger>
                <DropdownMenuContent align="end">
                    <DropdownMenuItem onSelect={() => start(false)}>
                        <FileArchive className="size-4" />
                        Save zip to this folder
                    </DropdownMenuItem>
                    <DropdownMenuItem onSelect={() => start(true)}>
                        <FileArchive className="size-4" />
                        Save zip and create a link
                    </DropdownMenuItem>
                </DropdownMenuContent>
            </DropdownMenu>

            <DialogContent>
                <DialogHeader>
                    <DialogTitle>{withLink ? "Zip and share" : "Save as zip"}</DialogTitle>
                    <DialogDescription>
                        {entries.length} item{entries.length === 1 ? "" : "s"} into a zip in this folder. Set a password
                        to encrypt the archive itself.
                    </DialogDescription>
                </DialogHeader>

                {link ? (
                    <div className="flex flex-col gap-2">
                        <p className="text-sm text-muted-foreground">Share link (copy it now):</p>
                        <div className="flex items-center gap-2">
                            <Input readOnly value={link} className="font-mono text-xs" />
                            <Button type="button" size="icon" variant="secondary" onClick={copyLink}>
                                {copied ? <Check className="size-4" /> : <Copy className="size-4" />}
                            </Button>
                        </div>
                        <div className="mt-2 flex justify-end">
                            <DialogClose asChild>
                                <Button type="button">Done</Button>
                            </DialogClose>
                        </div>
                    </div>
                ) : (
                    <form onSubmit={onSubmit} className="flex flex-col gap-3">
                        <label className="flex flex-col gap-1 text-sm">
                            Name
                            <Input name="name" required defaultValue="archive" placeholder="archive" />
                        </label>
                        <label className="flex flex-col gap-1 text-sm">
                            Password (optional, encrypts the zip)
                            <Input name="password" type="password" autoComplete="new-password" />
                        </label>
                        {error ? <p className="text-sm text-danger">{error}</p> : null}
                        <div className="mt-2 flex justify-end gap-2">
                            <DialogClose asChild>
                                <Button type="button" variant="ghost">
                                    Cancel
                                </Button>
                            </DialogClose>
                            <Button type="submit" disabled={pending}>
                                {pending ? "Creating..." : withLink ? "Create and link" : "Create zip"}
                            </Button>
                        </div>
                    </form>
                )}
            </DialogContent>
        </Dialog>
    );
}
