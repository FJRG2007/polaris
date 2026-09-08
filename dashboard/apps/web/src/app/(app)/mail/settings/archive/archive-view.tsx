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

import * as core from "@polaris/core";
import { Download, Upload } from "lucide-react";
import { AccountPicker } from "../account-picker";
import { refusalOf } from "@/app/(app)/mail/refusal";
import type { MailFolderView } from "@/lib/mailbox/views";
import { useEffect, useMemo, useRef, useState } from "react";
import type { MailAccountView } from "@/lib/mailbox/accounts";
import { Button, EmptyState, Select, useToast } from "@polaris/ui";
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
     *  the line under the button appears rather than flickering through nought. */
    const [exportCount, setExportCount] = useState<number | null>(null);

    // Asked whenever the scope changes, because a download of a whole mailbox is
    // the one on this screen somebody should be able to size up before starting.
    useEffect(() => {
        if (!account) return;
        let current = true;
        setExportCount(null);
        void exportSizeAction({ accountId: account.id, folderId: folderId || null }).then(
            (answer) => {
                if (current && "count" in answer) setExportCount(answer.count);
            }
        );
        return () => {
            current = false;
        };
    }, [account, folderId]);

    if (!account) {
        return (
            <EmptyState
                icon={<Upload className="size-5 shrink-0" aria-hidden />}
                title="No mailbox yet"
                description="Connect one and you can bring an archive into it."
            />
        );
    }

    async function bringIn(file: File): Promise<void> {
        if (!account || !target) return;
        // Said here as well as by the server, so a three-hundred-megabyte file is
        // refused before it is uploaded rather than after.
        if (file.size > core.MAIL_MAX_ARCHIVE_BYTES) {
            toast.show({
                title: `${ARCHIVE_LIMIT_MB} MB is the most Polaris can read in one file. Split the archive and bring the parts in one after another.`
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
            const sent = await fetch("/api/mail/uploads?kind=archive", {
                method: "POST",
                body: form
            });
            const stored = (await sent.json()) as { upload?: { id: string }; error?: string };
            if (!sent.ok || !stored.upload) {
                toast.show({ title: stored.error ?? "That file could not be read." });
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
                toast.show({ title: "There are no messages in that file." });
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
                    ? `${done} messages are in ${account.address}. ${failed} could not be taken by the server.`
                    : `${done} messages are in ${account.address}.`
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
                <span className="mb-1 block text-[12px] text-muted-foreground">Folder</span>
                <Select
                    value={target}
                    onValueChange={setFolderId}
                    options={mine.map((folder) => ({ value: folder.id, label: folder.name }))}
                />
            </label>

            <section className="mt-4 rounded-md border border-border">
                <div className="px-3 py-2.5">
                    <h2 className="text-[13px] font-medium">Bring an archive in</h2>
                    <p className="mt-1 text-[12px] text-muted-foreground">
                        An <code>.mbox</code> file, or a single <code>.eml</code>, up to{" "}
                        {ARCHIVE_LIMIT_MB} MB. Every message is put on your mail server in the
                        folder above, so it is there on your phone and in everything else you read
                        this mailbox with - not only here. They arrive already read, because an
                        archive that lands as four thousand unread messages is an inbox nobody
                        opens again.
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
                        Choose a file
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
                                {progress.finished ? "Done - " : ""}
                                {progress.done} of {progress.total} imported
                                {progress.failed
                                    ? `, ${progress.failed} the server would not take`
                                    : ""}
                                .
                            </p>
                        </div>
                    ) : null}
                </div>
                <p className="border-t border-border px-3 py-2 text-[12px] text-foreground-subtle">
                    Nothing is matched against what is already in the folder, so importing the same
                    file twice puts everything in twice. That is on purpose: a message quietly
                    missing from an archive is worse than one that is there twice.
                </p>
            </section>

            <section className="mt-4 rounded-md border border-border">
                <div className="px-3 py-2.5">
                    <h2 className="text-[13px] font-medium">Take it out</h2>
                    <p className="mt-1 text-[12px] text-muted-foreground">
                        An <code>.mbox</code> of everything Polaris holds for this{" "}
                        {folderId ? "folder" : "mailbox"}, which every other mail client can read.
                        It is built from what has been synced here, with the headers Polaris keeps -
                        an archive rather than a forensic copy. To save one message exactly as its
                        server holds it, open it and use Save this message.
                    </p>
                    <Button className="mt-2" size="sm" variant="secondary" asChild>
                        <a href={exportHref} download>
                            <Download className="size-4 shrink-0" aria-hidden />
                            Download {folderId ? "this folder" : "this mailbox"}
                        </a>
                    </Button>
                    {exportCount !== null ? (
                        <p className="mt-1 text-[12px] text-foreground-subtle">
                            {exportCount === 0
                                ? "There is nothing here to download yet."
                                : `${exportCount.toLocaleString()} message${exportCount === 1 ? "" : "s"} in the file.`}
                        </p>
                    ) : null}
                </div>
            </section>
        </div>
    );
}
