"use client";

/**
 * Zip actions for the current selection: bundle the selected items into a zip
 * written to the NAS, optionally AES-encrypted with a password, and optionally
 * mint a share link for the result. Self-contained - it drives generateZipAction
 * and createShareAction and shows any resulting link inline (copy to clipboard),
 * so it needs no wiring from the parent beyond the selection.
 */

import type { DriveEntry } from "./types";
import { useTranslations } from "@/components/i18n/i18n-provider";
import { useRouter } from "next/navigation";
import { generateZipAction } from "./actions";
import { useState, type FormEvent } from "react";
import { createShareAction } from "./share-actions";
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

export function SelectionZipMenu({
    connectionId,
    entries,
    currentPath
}: {
    connectionId: string;
    entries: DriveEntry[];
    currentPath: string;
}) {
    const t = useTranslations("drive");
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
                    <Button size="sm" variant="ghost" title={t("zip.zip")} aria-label={t("zip.zip")}>
                        <FileArchive className="size-4" />
                        <span className="hidden sm:inline">{t("zip.zip")}</span>
                    </Button>
                </DropdownMenuTrigger>
                <DropdownMenuContent align="end">
                    <DropdownMenuItem onSelect={() => start(false)}>
                        <FileArchive className="size-4" />
                        {t("zip.saveZipToThisFolder")}
                    </DropdownMenuItem>
                    <DropdownMenuItem onSelect={() => start(true)}>
                        <FileArchive className="size-4" />
                        {t("zip.saveZipAndCreateA")}
                    </DropdownMenuItem>
                </DropdownMenuContent>
            </DropdownMenu>

            <DialogContent>
                <DialogHeader>
                    <DialogTitle>{withLink ? t("zip.zipAndShare") : t("zip.saveAsZip")}</DialogTitle>
                    <DialogDescription>
                        {entries.length} item{entries.length === 1 ? "" : "s"} into a zip in this folder. Set a password
                        to encrypt the archive itself.
                    </DialogDescription>
                </DialogHeader>

                {link ? (
                    <div className="flex flex-col gap-2">
                        <p className="text-sm text-muted-foreground">{t("zip.shareLinkCopyItNow")}</p>
                        <div className="flex items-center gap-2">
                            <Input readOnly value={link} className="font-mono text-xs" />
                            <Button type="button" size="icon" variant="secondary" onClick={copyLink}>
                                {copied ? <Check className="size-4" /> : <Copy className="size-4" />}
                            </Button>
                        </div>
                        <div className="mt-2 flex justify-end">
                            <DialogClose asChild>
                                <Button type="button">{t("zip.done")}</Button>
                            </DialogClose>
                        </div>
                    </div>
                ) : (
                    <form onSubmit={onSubmit} className="flex flex-col gap-3">
                        <label className="flex flex-col gap-1 text-sm">
                            {t("zip.name")}
                            <Input name="name" required defaultValue="archive" placeholder="archive" />
                        </label>
                        <label className="flex flex-col gap-1 text-sm">
                            {t("zip.passwordOptionalEncryptsTheZip")}
                            {/* enigma:allow-no-breach-check enigma:allow-identity-password -
                                this is the archive's own passphrase, not a credential: it
                                authenticates nothing and there is no account behind it to
                                compare against or to stuff a leaked list into. */}
                            <Input name="password" type="password" autoComplete="new-password" />
                        </label>
                        {error ? <p className="text-sm text-danger">{error}</p> : null}
                        <div className="mt-2 flex justify-end gap-2">
                            <DialogClose asChild>
                                <Button type="button" variant="ghost">
                                    {t("zip.cancel")}
                                </Button>
                            </DialogClose>
                            <Button type="submit" disabled={pending}>
                                {pending ? t("zip.creating") : withLink ? t("zip.createAndLink") : t("zip.createZip")}
                            </Button>
                        </div>
                    </form>
                )}
            </DialogContent>
        </Dialog>
    );
}
