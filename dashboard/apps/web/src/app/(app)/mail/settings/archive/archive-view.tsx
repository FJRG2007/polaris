"use client";

/**
 * Bringing an archive in, and taking one out.
 *
 * The import runs a batch at a time from here rather than in one call on the
 * server, and that is why there is a progress bar at all: four thousand messages
 * appended over one connection is minutes, which no request should live for. The
 * screen asks for twenty-five, draws where it got to, and asks again - so a
 * failure halfway through is a number somebody can see and start again from
 * rather than a spinner that stopped.
 *
 * The export is an ordinary link. It streams, so a large mailbox starts saving
 * immediately instead of appearing to hang while a file is built.
 */

import { sendFile } from "@/components/transfers/move-file";
import * as core from "@polaris/core";
import { Download, Upload } from "lucide-react";
import { AccountPicker } from "../account-picker";
import { refusalOf } from "@/app/(app)/mail/refusal";
import type { MailFolderView } from "@/lib/mailbox/views";
import { useCallback, useMemo, useRef, useState } from "react";
import { useLiveRead } from "@/components/use-live-resource";
import type { MailAccountView } from "@/lib/mailbox/accounts";
import { Button, EmptyState, Select, useToast } from "@polaris/ui";
import { useTranslations } from "@/components/i18n/i18n-provider";
import { exportSizeAction, importBatchAction, openImportAction } from "@/app/(app)/mail/actions";

/** The archive ceiling as the screen says it, from the number the server
 *  enforces. */
const ARCHIVE_LIMIT_MB = Math.round(core.MAIL_MAX_ARCHIVE_BYTES / (1024 * 1024));

/** Where an import has got to. Null is one that has not started. */
interface Progress {
    readonly done: number;
    readonly failed: number;
    readonly total: number;
    readonly finished: boolean;
}

export function ArchiveView({
    accounts,
    folders
}: {
    accounts: MailAccountView[];
    folders: MailFolderView[];
}) {
    const toast = useToast();
    const t = useTranslations("mailSettings");
    const tm = useTranslations("mail");
    const picker = useRef<HTMLInputElement | null>(null);
    const [accountId, setAccountId] = useState(accounts[0]?.id ?? "");
    const [busy, setBusy] = useState(false);
    const [progress, setProgress] = useState<Progress | null>(null);

    const account = accounts.find((one) => one.id === accountId) ?? accounts[0];
    const mine = useMemo(
        () => folders.filter((folder) => folder.accountId === account?.id),
        [folders, account]
    );
    const [folderId, setFolderId] = useState("");
    const target = folderId || mine.find((one) => one.role === "archive")?.id || mine[0]?.id || "";
    /** How many messages the download would carry. Null until it is known, so
     *  the line under the button appears rather than flickering through nought.
     *  Asked whenever the scope changes, because a download of a whole mailbox
     *  is the one on this screen somebody should be able to size up before
     *  starting - and kept per scope, so coming back paints the last count. */
    const scopeAccount = account?.id ?? "";
    const countExport = useCallback(async (): Promise<number> => {
        const answer = await exportSizeAction({
            accountId: scopeAccount,
            folderId: folderId || null
        });
        if (!("count" in answer)) throw new Error(answer.error);
        return answer.count;
    }, [scopeAccount, folderId]);
    const size = useLiveRead({
        load: countExport,
        cacheKey: `mail.export-size:${scopeAccount}:${folderId}`,
        enabled: scopeAccount !== ""
    });
    // A kept count whose fresh read failed is not known either: the line goes,
    // as it did when nothing was kept.
    const exportCount = size.kept && size.stale !== null ? null : size.data;

    if (!account) {
        return (
            <EmptyState
                icon={<Upload className="size-5 shrink-0" aria-hidden />}
                title={t("blocked.noMailboxTitle")}
                description={t("archive.noMailbox")}
            />
        );
    }

    async function bringIn(file: File): Promise<void> {
        if (!account || !target) return;
        // Said here as well as by the server, so a three-hundred-megabyte file is
        // refused before it is uploaded rather than after.
        if (file.size > core.MAIL_MAX_ARCHIVE_BYTES) {
            toast.show({
                title: t("archive.tooBig", { limit: ARCHIVE_LIMIT_MB })
            });
            if (picker.current) picker.current.value = "";
            return;
        }
        setBusy(true);
        setProgress(null);
        try {
            // The file goes through the same upload path an attachment does, so
            // it lands on whichever storage this Polaris was pointed at rather
            // than on whichever disk happens to be under the web server.
            const form = new FormData();
            form.set("file", file);
            // An mbox is routinely hundreds of megabytes, which makes this the one
            // upload in Polaris most worth watching - through the shared sender it
            // has a bar and can be stopped.
            const sent = await sendFile("/api/mail/uploads?kind=archive", form, {
                // Its answer comes once the archive has been read in.
                answerWithinMs: null,
                name: file.name
            });
            let stored: { upload?: { id: string }; error?: string } = {};
            try {
                stored = JSON.parse(sent.body || "{}") as typeof stored;
            } catch {
                stored = {};
            }
            if (!sent.ok || !stored.upload) {
                toast.show({ title: stored.error ?? tm("errors.fileRead") });
                return;
            }

            const where = { accountId: account.id, folderId: target, uploadId: stored.upload.id };
            const opened = await openImportAction(where);
            const said = refusalOf(opened);
            if (said) {
                toast.show({ title: said });
                return;
            }
            const total = "count" in opened ? opened.count : 0;
            if (total === 0) {
                toast.show({ title: t("archive.noMessages") });
                return;
            }

            let at = 0;
            let done = 0;
            let failed = 0;
            setProgress({ done: 0, failed: 0, total, finished: false });
            while (at < total) {
                const batch = await importBatchAction(where, at);
                const refused = refusalOf(batch);
                if (refused) {
                    toast.show({ title: refused });
                    setProgress({ done, failed, total, finished: true });
                    return;
                }
                if (!("next" in batch)) return;
                done += batch.done;
                failed += batch.failed;
                at = batch.next;
                setProgress({ done, failed, total, finished: at >= total });
            }
            toast.show({
                title: failed
                    ? t("archive.importedSomeFailed", { done, address: account.address, failed })
                    : t("archive.imported", { done, address: account.address })
            });
        } finally {
            setBusy(false);
            if (picker.current) picker.current.value = "";
        }
    }

    const exportHref = `/api/mail/export?accountId=${encodeURIComponent(account.id)}${
        folderId ? `&folderId=${encodeURIComponent(folderId)}` : ""
    }`;

    return (
        <div>
            <AccountPicker accounts={accounts} value={account.id} onChange={setAccountId} />

            <label className="mt-3 block">
                <span className="mb-1 block text-[12px] text-muted-foreground">
                    {t("archive.folder")}
                </span>
                <Select
                    value={target}
                    onValueChange={setFolderId}
                    options={mine.map((folder) => ({ value: folder.id, label: folder.name }))}
                />
            </label>

            <section className="mt-4 rounded-md border border-border">
                <div className="px-3 py-2.5">
                    <h2 className="text-[13px] font-medium">{t("archive.inTitle")}</h2>
                    <p className="mt-1 text-[12px] text-muted-foreground">
                        {t.rich("archive.inBody", {
                            limit: ARCHIVE_LIMIT_MB,
                            code: (chunks) => <code key={String(chunks)}>{chunks}</code>
                        })}
                    </p>
                    <input
                        ref={picker}
                        type="file"
                        accept=".mbox,.eml,message/rfc822,application/mbox,text/plain"
                        className="hidden"
                        onChange={(event) => {
                            const file = event.target.files?.[0];
                            if (file) void bringIn(file);
                        }}
                    />
                    <Button
                        className="mt-2"
                        size="sm"
                        variant="primary"
                        disabled={busy || !target}
                        onClick={() => picker.current?.click()}
                    >
                        <Upload className="size-4 shrink-0" aria-hidden />
                        {t("archive.choose")}
                    </Button>
                    {progress ? (
                        <div className="mt-3">
                            <div
                                className="h-1.5 w-full overflow-hidden rounded-full bg-surface"
                                role="progressbar"
                                aria-valuenow={progress.done}
                                aria-valuemin={0}
                                aria-valuemax={progress.total}
                            >
                                <div
                                    className="h-full rounded-full bg-primary transition-[width] duration-fast"
                                    style={{
                                        width: `${Math.round(
                                            ((progress.done + progress.failed) /
                                                Math.max(1, progress.total)) *
                                                100
                                        )}%`
                                    }}
                                />
                            </div>
                            <p className="mt-1 text-[12px] text-muted-foreground">
                                {t("archive.progress", {
                                    finished: progress.finished ? "yes" : "no",
                                    done: progress.done,
                                    total: progress.total,
                                    failed: progress.failed
                                })}
                            </p>
                        </div>
                    ) : null}
                </div>
                <p className="border-t border-border px-3 py-2 text-[12px] text-foreground-subtle">
                    {t("archive.twice")}
                </p>
            </section>

            <section className="mt-4 rounded-md border border-border">
                <div className="px-3 py-2.5">
                    <h2 className="text-[13px] font-medium">{t("archive.outTitle")}</h2>
                    <p className="mt-1 text-[12px] text-muted-foreground">
                        {t.rich("archive.outBody", {
                            scope: folderId ? "folder" : "mailbox",
                            code: (chunks) => <code key={String(chunks)}>{chunks}</code>
                        })}
                    </p>
                    <Button className="mt-2" size="sm" variant="secondary" asChild>
                        <a href={exportHref} download>
                            <Download className="size-4 shrink-0" aria-hidden />
                            {folderId ? t("archive.downloadFolder") : t("archive.downloadMailbox")}
                        </a>
                    </Button>
                    {exportCount !== null ? (
                        <p className="mt-1 text-[12px] text-foreground-subtle">
                            {exportCount === 0
                                ? t("archive.nothingYet")
                                : t("archive.inFile", { count: exportCount })}
                        </p>
                    ) : null}
                </div>
            </section>
        </div>
    );
}
