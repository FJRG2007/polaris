"use client";

/**
 * Quick send: drop files, pick how long they last and how often they may be
 * downloaded, and get a link - or send it to people here. Below, the transfers
 * still live, with what is left of each and a way to take one back early.
 *
 * Files go up one at a time to their own streamed route, so nothing is held in
 * a server action's memory and a failure names the file it happened to.
 */

import { useRouter } from "next/navigation";
import { formatBytes } from "@polaris/core";
import { useConfirm } from "@/components/confirm-dialog";
import { useChooseFiles } from "@/components/file-picker/use-choose-files";
import { findTransferPeopleAction } from "../transfer-actions";
import { useTranslations } from "@/components/i18n/i18n-provider";
import { useEffect, useState, type DragEvent } from "react";
import type { TransferView } from "@/lib/disposable-transfer-service";
import { Button, CopyButton, Input, Select, Textarea } from "@polaris/ui";
import { Clock, Download, FileUp, Send, Trash2, Upload, User, X } from "lucide-react";
import {
    createQuickSendAction,
    finishQuickSendAction,
    listQuickSendsAction,
    revokeQuickSendAction
} from "./actions";

const EXPIRIES = ["1h", "1d", "3d", "7d", "14d"] as const;
const DOWNLOADS = [1, 5, 10, 50, 0] as const;
const MAX_FILES = 50;

interface Person {
    id: string;
    name: string;
    allowed: boolean;
}

export function QuickSendView({
    initial,
    canSend,
    maxBytes
}: {
    initial: TransferView[];
    canSend: boolean;
    maxBytes: number;
}) {
    const t = useTranslations("drive");
    const router = useRouter();
    const [confirm, confirmDialog] = useConfirm();
    const [transfers, setTransfers] = useState(initial);
    const [files, setFiles] = useState<File[]>([]);
    const [expiry, setExpiry] = useState<(typeof EXPIRIES)[number]>("1d");
    const [downloads, setDownloads] = useState<number>(1);
    const [note, setNote] = useState("");
    const [people, setPeople] = useState<Person[]>([]);
    const [query, setQuery] = useState("");
    const [found, setFound] = useState<Person[]>([]);
    const [busy, setBusy] = useState<string | null>(null);
    const [error, setError] = useState<string | null>(null);
    const [made, setMade] = useState<{ url: string; notified: number; refused: number } | null>(null);
    const [dragging, setDragging] = useState(false);
    const [chooseFiles, chooser] = useChooseFiles();

    useEffect(() => setTransfers(initial), [initial]);

    // People search, debounced; a stale answer never overwrites a newer one.
    useEffect(() => {
        const text = query.trim();
        if (text.length < 2) {
            setFound([]);
            return;
        }
        let live = true;
        const timer = setTimeout(() => {
            void findTransferPeopleAction(text)
                .then((answer) => live && setFound(answer.results))
                .catch(() => live && setFound([]));
        }, 250);
        return () => {
            live = false;
            clearTimeout(timer);
        };
    }, [query]);

    const total = files.reduce((sum, file) => sum + file.size, 0);
    const tooBig = total > maxBytes;

    function addFiles(list: FileList | readonly File[] | null) {
        if (!list) return;
        setMade(null);
        setFiles((current) => [...current, ...Array.from(list)].slice(0, MAX_FILES));
    }

    function onDrop(event: DragEvent) {
        event.preventDefault();
        setDragging(false);
        addFiles(event.dataTransfer.files);
    }

    async function refreshList() {
        try {
            setTransfers(await listQuickSendsAction());
        } catch {
            router.refresh();
        }
    }

    async function submit() {
        if (files.length === 0 || tooBig || busy) return;
        setError(null);
        setBusy(t("disposable.preparing"));
        const created = await createQuickSendAction({
            expiry,
            maxDownloads: downloads,
            note: note.trim() || undefined
        }).catch(() => ({ ok: false as const, error: t("disposable.errors.generic") }));
        if (!created.ok) {
            setBusy(null);
            setError(created.error);
            return;
        }
        for (const [index, file] of files.entries()) {
            setBusy(t("disposable.uploading", { current: index + 1, total: files.length }));
            const response = await fetch(
                `/api/drive/quick-send/${created.id}/files?name=${encodeURIComponent(file.name)}`,
                {
                    method: "PUT",
                    body: file,
                    headers: { "content-type": file.type || "application/octet-stream" }
                }
            ).catch(() => null);
            if (!response?.ok) {
                const said = (await response?.json().catch(() => null)) as { error?: string } | null;
                await revokeQuickSendAction(created.id).catch(() => undefined);
                setBusy(null);
                setError(
                    t("disposable.errors.fileFailed", {
                        name: file.name,
                        reason: said?.error ?? t("disposable.errors.generic")
                    })
                );
                return;
            }
        }
        setBusy(t("disposable.finishing"));
        const finished = await finishQuickSendAction({
            id: created.id,
            recipients: people.map((person) => person.id)
        }).catch(() => ({ ok: false as const, error: t("disposable.errors.generic") }));
        setBusy(null);
        if (!finished.ok) {
            await revokeQuickSendAction(created.id).catch(() => undefined);
            setError(finished.error);
            return;
        }
        setMade(finished);
        setFiles([]);
        setNote("");
        setPeople([]);
        await refreshList();
    }

    async function revoke(transfer: TransferView) {
        const sure = await confirm({
            title: t("disposable.revokeTitle"),
            description: t("disposable.revokeBody"),
            confirmLabel: t("disposable.revoke"),
            danger: true
        });
        if (!sure) return;
        const before = transfers;
        setTransfers((current) => current.filter((row) => row.id !== transfer.id));
        const done = await revokeQuickSendAction(transfer.id).catch(() => ({ ok: false }));
        if (!done.ok) {
            setTransfers(before);
            setError(t("disposable.errors.revokeFailed"));
        }
    }

    return (
        <div className="flex min-w-0 flex-col gap-6">
            {confirmDialog}
            {chooser}
            {canSend ? (
                <section className="flex min-w-0 flex-col gap-4 rounded-md border border-border p-3 sm:p-4">
                    <div
                        onDragOver={(event) => {
                            event.preventDefault();
                            setDragging(true);
                        }}
                        onDragLeave={() => setDragging(false)}
                        onDrop={onDrop}
                        className={`flex flex-col items-center gap-2 rounded-md border border-dashed p-6 text-center ${
                            dragging ? "border-primary bg-primary/5" : "border-border"
                        }`}
                    >
                        <FileUp className="size-6 text-muted-foreground" aria-hidden />
                        <p className="text-sm">{t("disposable.dropHint")}</p>
                        <Button type="button" size="sm" variant="secondary" onClick={() =>
                                void chooseFiles({ multiple: true, onFailed: setError }).then(addFiles)
                            }>
                            <Upload className="size-4" />
                            {t("disposable.choose")}
                        </Button>
                        <p className="text-xs text-muted-foreground">
                            {t("disposable.limit", { size: formatBytes(maxBytes), count: MAX_FILES })}
                        </p>
                    </div>

                    {files.length > 0 ? (
                        <ul className="flex min-w-0 flex-col gap-1">
                            {files.map((file, index) => (
                                <li key={`${file.name}:${index}`} className="flex min-w-0 items-center gap-2 text-sm">
                                    <span className="min-w-0 flex-1 truncate" title={file.name}>
                                        {file.name}
                                    </span>
                                    <span className="shrink-0 text-xs text-muted-foreground">
                                        {formatBytes(file.size)}
                                    </span>
                                    <button
                                        type="button"
                                        className="shrink-0 rounded p-1 text-muted-foreground hover:bg-muted"
                                        aria-label={t("disposable.removeFile", { name: file.name })}
                                        title={t("disposable.removeFile", { name: file.name })}
                                        onClick={() => setFiles((current) => current.filter((_, at) => at !== index))}
                                    >
                                        <X className="size-4" />
                                    </button>
                                </li>
                            ))}
                            {tooBig ? (
                                <li className="text-xs text-destructive">
                                    {t("disposable.errors.tooLarge")}
                                </li>
                            ) : null}
                        </ul>
                    ) : null}

                    <div className="grid min-w-0 grid-cols-1 gap-3 sm:grid-cols-2">
                        <label className="flex min-w-0 flex-col gap-1 text-sm">
                            {t("disposable.expiry")}
                            <Select
                                value={expiry}
                                onValueChange={(value) => setExpiry(value as (typeof EXPIRIES)[number])}
                                options={EXPIRIES.map((value) => ({
                                    value,
                                    label: t(`disposable.expiries.${value}`)
                                }))}
                                aria-label={t("disposable.expiry")}
                            />
                        </label>
                        <label className="flex min-w-0 flex-col gap-1 text-sm">
                            {t("disposable.downloads")}
                            <Select
                                value={String(downloads)}
                                onValueChange={(value) => setDownloads(Number(value))}
                                options={DOWNLOADS.map((value) => ({
                                    value: String(value),
                                    label:
                                        value === 0
                                            ? t("disposable.unlimited")
                                            : t("disposable.downloadCount", { count: value })
                                }))}
                                aria-label={t("disposable.downloads")}
                            />
                        </label>
                    </div>

                    <div className="flex min-w-0 flex-col gap-2">
                        <label className="flex min-w-0 flex-col gap-1 text-sm">
                            {t("disposable.sendTo")}
                            <Input
                                value={query}
                                onChange={(event) => setQuery(event.target.value)}
                                placeholder={t("disposable.sendToHint")}
                            />
                        </label>
                        {found.length > 0 ? (
                            <ul className="flex max-h-48 min-w-0 flex-col overflow-y-auto overscroll-contain rounded-md border border-border">
                                {found.map((person) => (
                                    <li key={person.id}>
                                        <button
                                            type="button"
                                            disabled={!person.allowed || people.some((p) => p.id === person.id)}
                                            title={person.allowed ? undefined : t("disposable.notReceiving")}
                                            onClick={() => {
                                                setPeople((current) => [...current, person]);
                                                setQuery("");
                                            }}
                                            className="flex w-full min-w-0 items-center gap-2 px-3 py-2 text-left text-sm hover:bg-muted disabled:opacity-50"
                                        >
                                            <User className="size-4 shrink-0" aria-hidden />
                                            <span className="min-w-0 flex-1 truncate" title={person.name}>{person.name}</span>
                                            {!person.allowed ? (
                                                <span className="shrink-0 text-xs text-muted-foreground">
                                                    {t("disposable.notReceiving")}
                                                </span>
                                            ) : null}
                                        </button>
                                    </li>
                                ))}
                            </ul>
                        ) : null}
                        {people.length > 0 ? (
                            <div className="flex min-w-0 flex-wrap gap-1.5">
                                {people.map((person) => (
                                    <span
                                        key={person.id}
                                        className="inline-flex max-w-full items-center gap-1 rounded-full bg-muted px-2 py-0.5 text-xs"
                                    >
                                        <span className="truncate" title={person.name}>{person.name}</span>
                                        <button
                                            type="button"
                                            aria-label={t("disposable.removePerson", { name: person.name })}
                                            onClick={() =>
                                                setPeople((current) => current.filter((p) => p.id !== person.id))
                                            }
                                        >
                                            <X className="size-3" />
                                        </button>
                                    </span>
                                ))}
                            </div>
                        ) : null}
                        <Textarea
                            value={note}
                            maxLength={500}
                            onChange={(event) => setNote(event.target.value)}
                            placeholder={t("disposable.notePlaceholder")}
                            aria-label={t("disposable.note")}
                            rows={2}
                        />
                    </div>

                    {error ? <p className="text-sm text-destructive">{error}</p> : null}
                    {made ? (
                        <div className="flex min-w-0 flex-col gap-1 rounded-md bg-muted/40 p-3">
                            <p className="text-sm font-medium">{t("disposable.ready")}</p>
                            <div className="flex min-w-0 items-center gap-2">
                                <code className="min-w-0 flex-1 truncate text-xs" title={made.url}>
                                    {made.url}
                                </code>
                                <CopyButton value={made.url} label={t("disposable.link")} />
                            </div>
                            {made.notified + made.refused > 0 ? (
                                <p className="text-xs text-muted-foreground">
                                    {t("disposable.notified", { count: made.notified })}
                                    {made.refused > 0
                                        ? ` ${t("disposable.refused", { count: made.refused })}`
                                        : ""}
                                </p>
                            ) : null}
                        </div>
                    ) : null}

                    <div className="flex justify-end">
                        <Button
                            type="button"
                            onClick={() => void submit()}
                            disabled={files.length === 0 || tooBig || busy !== null}
                        >
                            <Send className="size-4" />
                            {busy ?? (people.length > 0 ? t("disposable.send") : t("disposable.create"))}
                        </Button>
                    </div>
                </section>
            ) : null}

            <section className="flex min-w-0 flex-col gap-2">
                <h2 className="text-sm font-semibold">{t("disposable.active")}</h2>
                {transfers.length === 0 ? (
                    <p className="text-sm text-muted-foreground">{t("disposable.empty")}</p>
                ) : (
                    <ul className="flex min-w-0 flex-col divide-y divide-border rounded-md border border-border">
                        {transfers.map((transfer) => (
                            <TransferRow key={transfer.id} transfer={transfer} onRevoke={() => void revoke(transfer)} />
                        ))}
                    </ul>
                )}
            </section>
        </div>
    );
}

function TransferRow({ transfer, onRevoke }: { transfer: TransferView; onRevoke: () => void }) {
    const t = useTranslations("drive");
    const first = transfer.files[0]?.name ?? "";
    const left = transfer.files.reduce<number | null>(
        (sum, file) => (file.downloadsLeft === null || sum === null ? null : sum + file.downloadsLeft),
        0
    );
    return (
        <li className="flex min-w-0 items-center gap-3 p-3">
            <div className="min-w-0 flex-1">
                <p className="truncate text-sm font-medium" title={transfer.files.map((file) => file.name).join("\n")}>
                    {transfer.files.length > 1
                        ? t("disposable.manyFiles", { first, count: transfer.files.length - 1 })
                        : first}
                </p>
                <p className="flex min-w-0 flex-wrap items-center gap-x-3 text-xs text-muted-foreground">
                    <span>{formatBytes(transfer.totalSize)}</span>
                    <span className="inline-flex items-center gap-1">
                        <Clock className="size-3" aria-hidden />
                        {remaining(transfer.expiresAt, t)}
                    </span>
                    <span className="inline-flex items-center gap-1">
                        <Download className="size-3" aria-hidden />
                        {left === null ? t("disposable.unlimited") : t("disposable.downloadsLeft", { count: left })}
                    </span>
                </p>
            </div>
            <CopyButton value={transfer.url} label={t("disposable.link")} />
            <Button
                type="button"
                size="sm"
                variant="ghost"
                onClick={onRevoke}
                aria-label={t("disposable.revoke")}
                title={t("disposable.revoke")}
            >
                <Trash2 className="size-4" />
            </Button>
        </li>
    );
}

/** "3 h left", "2 d left": coarse on purpose, the list is not a countdown. */
function remaining(expiresAt: string, t: ReturnType<typeof useTranslations<"drive">>): string {
    const minutes = Math.max(0, Math.round((new Date(expiresAt).getTime() - Date.now()) / 60_000));
    if (minutes < 60) return t("disposable.leftMinutes", { count: minutes });
    if (minutes < 48 * 60) return t("disposable.leftHours", { count: Math.round(minutes / 60) });
    return t("disposable.leftDays", { count: Math.round(minutes / 1440) });
}
