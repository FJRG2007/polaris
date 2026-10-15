"use client";

/**
 * The recycle bin: services, databases and projects deleted recently, each with
 * the date it goes for good, to bring back or delete now. An administrator also
 * sets how many days things are kept here.
 */

import { useRouter } from "next/navigation";
import { Loader2, Trash2 } from "lucide-react";
import type { BinEntry } from "@/lib/deploy/recycle-bin";
import { useEffect, useState, useTransition } from "react";
import { useLocale, useTranslations } from "@/components/i18n/i18n-provider";
import { binItemAction, listBinAction, setBinDaysAction } from "./restore-actions";
import { Button, Dialog, DialogContent, DialogDescription, DialogHeader, DialogTitle, Input, Skeleton } from "@polaris/ui";

const KIND_LABEL = { application: "bin.kindApplication", database: "bin.kindDatabase", project: "bin.kindProject" } as const;

export function RecycleBinButton({ canManage, isAdmin }: { canManage: boolean; isAdmin: boolean }) {
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
                    {open && <BinContents canManage={canManage} isAdmin={isAdmin} />}
                </DialogContent>
            </Dialog>
        </>
    );
}

function BinContents({ canManage, isAdmin }: { canManage: boolean; isAdmin: boolean }) {
    const t = useTranslations("deploySafety");
    const locale = useLocale();
    const router = useRouter();
    const [entries, setEntries] = useState<BinEntry[] | null>(null);
    const [days, setDays] = useState<number | null>(null);
    const [daysDraft, setDaysDraft] = useState("");
    const [error, setError] = useState<string | null>(null);
    const [notice, setNotice] = useState<string | null>(null);
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
        setDays(result.days ?? null);
        setDaysDraft(String(result.days ?? ""));
    }

    useEffect(() => {
        void refresh();
        // Loaded once per opening.
        // eslint-disable-next-line react-hooks/exhaustive-deps
    }, []);

    function act(action: "restore" | "forget", entry: BinEntry) {
        setError(null);
        setNotice(null);
        startTransition(async () => {
            const previous = entries;
            // The row goes now and comes back if the server refuses.
            setEntries((current) => current?.filter((item) => item.id !== entry.id) ?? null);
            setConfirming(null);
            const result = await binItemAction(action, { kind: entry.kind, id: entry.id });
            if (result.error) {
                setEntries(previous);
                setError(t(action === "restore" ? "bin.binRestoreFailed" : "bin.binDeleteFailed"));
                return;
            }
            router.refresh();
        });
    }

    const parsedDays = Number(daysDraft);
    const daysValid = Number.isInteger(parsedDays) && parsedDays >= 1 && parsedDays <= 365;

    function saveDays() {
        if (!daysValid || parsedDays === days) return;
        setError(null);
        setNotice(null);
        startTransition(async () => {
            const result = await setBinDaysAction(parsedDays);
            if (result.error) {
                setError(t("bin.daysInvalid"));
                return;
            }
            setDays(parsedDays);
            setNotice(t("bin.daysSaved"));
            await refresh();
        });
    }

    return (
        <>
            <DialogHeader>
                <DialogTitle>{t("bin.title")}</DialogTitle>
                <DialogDescription>{days !== null && t("bin.description", { days })}</DialogDescription>
            </DialogHeader>
            <div className="flex max-h-[60vh] min-w-0 flex-col gap-3 overflow-y-auto overscroll-contain">
                {error && <p className="rounded-md bg-danger-soft px-3 py-2 text-sm text-danger-ink">{error}</p>}
                {notice && <p className="rounded-md bg-success-soft px-3 py-2 text-sm text-success-ink">{notice}</p>}
                {entries === null && !error && (
                    <div className="flex flex-col gap-2" aria-busy>
                        {[0, 1].map((index) => (
                            <Skeleton key={index} className="h-12 w-full" />
                        ))}
                    </div>
                )}
                {entries?.length === 0 && <p className="text-sm text-muted-foreground">{t("bin.empty")}</p>}
                {entries?.map((entry) => (
                    <div key={`${entry.kind}:${entry.id}`} className="flex min-w-0 flex-col gap-2 rounded-lg border px-3 py-2.5">
                        <div className="flex flex-wrap items-center justify-between gap-2">
                            <div className="min-w-0">
                                <p className="truncate text-sm font-medium" title={entry.name}>
                                    {entry.name}
                                </p>
                                <p className="text-xs text-muted-foreground">
                                    {t(KIND_LABEL[entry.kind])}
                                    {entry.projectName ? ` ${t("bin.inProject", { project: entry.projectName })}` : ""}
                                    {" - "}
                                    {t("bin.purgeOn", { date: when.format(new Date(entry.purgeAt)) })}
                                </p>
                            </div>
                            {canManage && confirming !== entry.id && (
                                <div className="flex gap-2">
                                    <Button size="sm" variant="outline" disabled={pending} onClick={() => act("restore", entry)}>
                                        {t("bin.restore")}
                                    </Button>
                                    <Button size="sm" variant="ghost" disabled={pending} onClick={() => setConfirming(entry.id)}>
                                        {t("bin.deleteForever")}
                                    </Button>
                                </div>
                            )}
                        </div>
                        {confirming === entry.id && (
                            <div className="flex flex-wrap items-center justify-between gap-2 rounded-md bg-danger-soft px-3 py-2">
                                <p className="min-w-0 text-sm text-danger-ink">{t("bin.confirmDelete", { name: entry.name })}</p>
                                <div className="flex gap-2">
                                    <Button size="sm" variant="ghost" onClick={() => setConfirming(null)}>
                                        {t("bin.cancel")}
                                    </Button>
                                    <Button size="sm" variant="danger" disabled={pending} onClick={() => act("forget", entry)}>
                                        {t("bin.deleteForever")}
                                    </Button>
                                </div>
                            </div>
                        )}
                    </div>
                ))}
            </div>
            {isAdmin && days !== null && (
                <div className="flex flex-wrap items-end gap-2 border-t pt-3">
                    <label className="flex flex-col gap-1.5">
                        <span className="text-xs font-medium text-muted-foreground">{t("bin.days")}</span>
                        <span className="flex items-center gap-2">
                            <Input
                                className="w-24"
                                inputMode="numeric"
                                value={daysDraft}
                                aria-invalid={daysDraft !== "" && !daysValid}
                                onChange={(event) => setDaysDraft(event.target.value.replace(/\D/g, "").slice(0, 3))}
                            />
                            <span className="text-sm text-muted-foreground">{t("bin.daysUnit")}</span>
                        </span>
                    </label>
                    <Button size="sm" disabled={pending || !daysValid || parsedDays === days} onClick={saveDays}>
                        {pending && <Loader2 className="size-3.5 animate-spin" />}
                        {t("bin.daysSave")}
                    </Button>
                    {daysDraft !== "" && !daysValid && <p className="w-full text-xs text-danger-ink">{t("bin.daysInvalid")}</p>}
                </div>
            )}
        </>
    );
}
