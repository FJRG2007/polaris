"use client";

/**
 * The recycle bin: services, databases and projects deleted recently, each with
 * the date it goes for good, to bring back or delete now. Whether there is a bin
 * and for how long it keeps things is set in Deploy settings, linked from here.
 */

import Link from "next/link";
import { useRouter } from "next/navigation";
import { Settings, Trash2 } from "lucide-react";
import type { BinEntry } from "@/lib/deploy/recycle-bin";
import { useEffect, useState, useTransition } from "react";
import { useLocale, useTranslations } from "@/components/i18n/i18n-provider";
import { binItemAction, listBinAction } from "./restore-actions";
import {
    Button,
    Dialog,
    DialogContent,
    DialogDescription,
    DialogHeader,
    DialogTitle,
    Skeleton
} from "@polaris/ui";

const KIND_LABEL = {
    application: "bin.kindApplication",
    database: "bin.kindDatabase",
    project: "bin.kindProject"
} as const;

export function RecycleBinButton({ canManage }: { canManage: boolean }) {
    const t = useTranslations("deploySafety");
    const [open, setOpen] = useState(false);
    return (
        <>
            <Button variant="outline" onClick={() => setOpen(true)}>
                <Trash2 className="size-4" />
                {t("bin.open")}
            </Button>
            <Dialog open={open} onOpenChange={setOpen}>
                <DialogContent className="max-w-xl">
                    {open && <BinContents canManage={canManage} />}
                </DialogContent>
            </Dialog>
        </>
    );
}

function BinContents({ canManage }: { canManage: boolean }) {
    const t = useTranslations("deploySafety");
    const locale = useLocale();
    const router = useRouter();
    const [entries, setEntries] = useState<BinEntry[] | null>(null);
    const [binOff, setBinOff] = useState(false);
    const [error, setError] = useState<string | null>(null);
    const [confirming, setConfirming] = useState<string | null>(null);
    const [pending, startTransition] = useTransition();
    const when = new Intl.DateTimeFormat(locale, { dateStyle: "medium" });

    async function refresh() {
        const result = await listBinAction();
        if (result.error || !result.entries) {
            setError(t("bin.unavailable"));
            return;
        }
        setEntries(result.entries);
        setBinOff(result.policy?.enabled === false);
    }

    useEffect(() => {
        void refresh();
        // Loaded once per opening.
        // eslint-disable-next-line react-hooks/exhaustive-deps
    }, []);

    function act(action: "restore" | "forget", entry: BinEntry) {
        setError(null);
        startTransition(async () => {
            const previous = entries;
            // The row goes now and comes back if the server refuses.
            setEntries((current) => current?.filter((item) => item.id !== entry.id) ?? null);
            setConfirming(null);
            const result = await binItemAction(action, { kind: entry.kind, id: entry.id });
            if (result.error) {
                setEntries(previous);
                setError(result.message ?? t(action === "restore" ? "bin.binRestoreFailed" : "bin.binDeleteFailed"));
                return;
            }
            router.refresh();
        });
    }

    return (
        <>
            <DialogHeader>
                <DialogTitle>{t("bin.title")}</DialogTitle>
                <DialogDescription>{t("bin.description")}</DialogDescription>
            </DialogHeader>
            <div className="flex max-h-[60vh] min-w-0 flex-col gap-3 overflow-y-auto overscroll-contain">
                {error && (
                    <p className="rounded-md bg-danger-soft px-3 py-2 text-sm text-danger-ink">
                        {error}
                    </p>
                )}
                {binOff && (
                    <p className="rounded-md bg-muted px-3 py-2 text-sm text-muted-foreground">
                        {t("bin.off")}
                    </p>
                )}
                {entries === null && !error && (
                    <div className="flex flex-col gap-2" aria-busy>
                        {[0, 1].map((index) => (
                            <Skeleton key={index} className="h-12 w-full" />
                        ))}
                    </div>
                )}
                {entries?.length === 0 && (
                    <p className="text-sm text-muted-foreground">{t("bin.empty")}</p>
                )}
                {entries?.map((entry) => (
                    <div
                        key={`${entry.kind}:${entry.id}`}
                        className="flex min-w-0 flex-col gap-2 rounded-lg border px-3 py-2.5"
                    >
                        <div className="flex flex-wrap items-center justify-between gap-2">
                            <div className="min-w-0">
                                <p className="truncate text-sm font-medium" title={entry.name}>
                                    {entry.name}
                                </p>
                                <p className="text-xs text-muted-foreground">
                                    {t(KIND_LABEL[entry.kind])}
                                    {entry.projectName
                                        ? ` ${t("bin.inProject", { project: entry.projectName })}`
                                        : ""}
                                    {" - "}
                                    {t("bin.purgeOn", {
                                        date: when.format(new Date(entry.purgeAt))
                                    })}
                                </p>
                            </div>
                            {canManage && confirming !== entry.id && (
                                <div className="flex gap-2">
                                    <Button
                                        size="sm"
                                        variant="outline"
                                        disabled={pending}
                                        onClick={() => act("restore", entry)}
                                    >
                                        {t("bin.restore")}
                                    </Button>
                                    <Button
                                        size="sm"
                                        variant="ghost"
                                        disabled={pending}
                                        onClick={() => setConfirming(entry.id)}
                                    >
                                        {t("bin.deleteForever")}
                                    </Button>
                                </div>
                            )}
                        </div>
                        {confirming === entry.id && (
                            <div className="flex flex-wrap items-center justify-between gap-2 rounded-md bg-danger-soft px-3 py-2">
                                <p className="min-w-0 text-sm text-danger-ink">
                                    {t("bin.confirmDelete", { name: entry.name })}
                                </p>
                                <div className="flex gap-2">
                                    <Button
                                        size="sm"
                                        variant="ghost"
                                        onClick={() => setConfirming(null)}
                                    >
                                        {t("bin.cancel")}
                                    </Button>
                                    <Button
                                        size="sm"
                                        variant="danger"
                                        disabled={pending}
                                        onClick={() => act("forget", entry)}
                                    >
                                        {t("bin.deleteForever")}
                                    </Button>
                                </div>
                            </div>
                        )}
                    </div>
                ))}
            </div>
            <div className="flex justify-end border-t pt-3">
                <Button asChild size="sm" variant="ghost">
                    <Link href="/apps/deploy/settings">
                        <Settings className="size-4" />
                        {t("bin.settingsLink")}
                    </Link>
                </Button>
            </div>
        </>
    );
}
