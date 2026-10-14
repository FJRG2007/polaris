"use client";

/**
 * The one uninstall dialog every door to it opens: the marketplace list, the
 * app's detail page and its installed dashboard.
 *
 * Uninstalling works like it does on a phone: the app goes with its data unless
 * the reader keeps the data, and the one choice that matters is said plainly.
 * Kept data stays on the machine and is listed on the storage screen, where it
 * can be freed later.
 */

import { useState } from "react";
import { Loader2 } from "lucide-react";
import { useRouter } from "next/navigation";
import type { NamespaceTranslator } from "@/lib/i18n/types";
import { useTranslations } from "@/components/i18n/i18n-provider";
import type { InstalledAppReaderView } from "@/lib/apps/install-service";
import { uninstallInstalledAppAction } from "@/app/(app)/apps/installed/[id]/actions";
import {
    Button,
    Checkbox,
    Dialog,
    DialogContent,
    DialogDescription,
    DialogHeader,
    DialogTitle
} from "@polaris/ui";

type Words = NamespaceTranslator<"marketplace">;

/**
 * What uninstalling an app says it will do when its data is kept. An app that
 * runs things of its own says what happens to those.
 */
export function uninstallDescription(t: Words, catalogId: string, name: string): string {
    if (catalogId === "game-servers") return t("uninstall.games", { name });
    if (catalogId === "home") return t("uninstall.home", { name });
    return t("uninstall.other", { name });
}

/**
 * What uninstalling says when its data goes with it. Game servers are apps of
 * their own, so that one still says to delete them first.
 */
function deletingDescription(t: Words, catalogId: string, name: string): string {
    const warning = t("detail.deleteDataWarning", { name });
    return catalogId === "game-servers" ? `${t("uninstall.games", { name })} ${warning}` : warning;
}

/**
 * What uninstalling says when its data is kept. Only an app with containers
 * leaves volumes behind, and those are what the storage screen lists.
 */
function keptDescription(
    t: Words,
    install: Pick<InstalledAppReaderView, "name" | "catalogId" | "applicationId">
): string {
    const description = uninstallDescription(t, install.catalogId, install.name);
    return install.applicationId ? `${description} ${t("uninstall.keptListed")}` : description;
}

export function UninstallDialog({
    install,
    onClose,
    onDone
}: {
    install: Pick<InstalledAppReaderView, "id" | "name" | "catalogId" | "applicationId">;
    onClose: () => void;
    /** After a finished uninstall; refreshes the page when not given. */
    onDone?: () => void;
}) {
    const t = useTranslations("marketplace");
    const tc = useTranslations("common");
    const router = useRouter();
    const [deleteData, setDeleteData] = useState(true);
    const [pending, setPending] = useState(false);
    const [failure, setFailure] = useState<string | null>(null);

    async function confirm(): Promise<void> {
        setPending(true);
        setFailure(null);
        const result = await uninstallInstalledAppAction(install.id, { deleteData }).catch(() => ({
            error: t("detail.uninstallFailed")
        }));
        setPending(false);
        if (result.error) {
            setFailure(result.error);
            return;
        }
        onClose();
        if (onDone) onDone();
        else router.refresh();
    }

    return (
        <Dialog open onOpenChange={(open) => !open && !pending && onClose()}>
            <DialogContent className="max-w-md">
                <DialogHeader>
                    <DialogTitle>{t("uninstall.title", { name: install.name })}</DialogTitle>
                    <DialogDescription>
                        {deleteData
                            ? deletingDescription(t, install.catalogId, install.name)
                            : keptDescription(t, install)}
                    </DialogDescription>
                </DialogHeader>
                <label className="flex items-start gap-2 text-sm">
                    <Checkbox
                        checked={deleteData}
                        onChange={(event) => setDeleteData(event.target.checked)}
                        disabled={pending}
                    />
                    <span>{t("detail.deleteData")}</span>
                </label>
                {failure && (
                    <p role="alert" className="text-danger text-sm">
                        {failure}
                    </p>
                )}
                <div className="flex flex-wrap justify-end gap-2">
                    <Button variant="ghost" onClick={onClose} disabled={pending}>
                        {tc("actions.cancel")}
                    </Button>
                    <Button variant="danger" onClick={() => void confirm()} disabled={pending}>
                        {pending && <Loader2 className="size-4 animate-spin" />}
                        {failure
                            ? t("uninstall.retry")
                            : deleteData
                              ? t("detail.confirmDelete")
                              : t("uninstall.keepData")}
                    </Button>
                </div>
            </DialogContent>
        </Dialog>
    );
}
