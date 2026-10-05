"use client";

/**
 * Bringing a Google Doc or Sheet in.
 *
 * Opens on whatever this person has linked. With no Google client on this
 * Polaris it says who can add one; with no account linked for Drive it offers
 * the button that links one, and comes back here. The list is Google's own,
 * newest first, searched by name, and a press on a row is the import.
 */

import * as core from "@polaris/core";
import { useRouter } from "next/navigation";
import { useCallback, useEffect, useState } from "react";
import { RelativeTime } from "@/components/relative-time";
import { useTranslations } from "@/components/i18n/i18n-provider";
import {
    ExternalLink,
    FileText,
    Loader2,
    Presentation,
    RefreshCw,
    Search,
    Table2
} from "lucide-react";
import {
    Button,
    Dialog,
    DialogContent,
    DialogDescription,
    DialogHeader,
    DialogTitle,
    EmptyState,
    Input,
    Select,
    Skeleton,
    useToast
} from "@polaris/ui";
import {
    importGoogleFileAction,
    listGoogleFilesAction,
    officeGoogleStateAction
} from "./google-actions";
import type { GoogleOfficeFile, OfficeGoogleAccount } from "@/lib/office/google";

/** Where linking Google for Office starts. It returns to `/office`. */
export const OFFICE_GOOGLE_LINK = "/api/connections/google/link?scope=office";

const MIME_ICONS: Record<GoogleOfficeFile["mime"], typeof FileText> = {
    "application/vnd.google-apps.document": FileText,
    "application/vnd.google-apps.spreadsheet": Table2,
    "application/vnd.google-apps.presentation": Presentation
};

type State =
    | { status: "loading" }
    | { status: "unavailable" }
    | { status: "ready"; accounts: OfficeGoogleAccount[] };

export function GoogleImportDialog({
    orgId,
    onClose
}: {
    /** The shelf being worked from, as the upload import sends it. */
    orgId: string | null;
    onClose: () => void;
}) {
    const t = useTranslations("office");
    const router = useRouter();
    const toast = useToast();
    const [state, setState] = useState<State>({ status: "loading" });
    const [accountId, setAccountId] = useState<string | null>(null);
    const [search, setSearch] = useState("");
    const [files, setFiles] = useState<GoogleOfficeFile[] | null>(null);
    const [next, setNext] = useState<string | null>(null);
    const [failure, setFailure] = useState<{ error: string; relink: boolean } | null>(null);
    const [more, setMore] = useState(false);
    const [opening, setOpening] = useState<string | null>(null);

    useEffect(() => {
        let live = true;
        void officeGoogleStateAction().then((answer) => {
            if (!live) return;
            if (answer.error || !answer.available) {
                setState({ status: "unavailable" });
                return;
            }
            const accounts = answer.accounts ?? [];
            setState({ status: "ready", accounts });
            setAccountId(accounts.find((account) => account.canImport)?.id ?? null);
        });
        return () => {
            live = false;
        };
    }, []);

    const usable =
        state.status === "ready" ? state.accounts.filter((account) => account.canImport) : [];

    const load = useCallback(
        async (page: string | null) => {
            if (!accountId) return;
            const answer = await listGoogleFilesAction({
                connectionId: accountId,
                search,
                pageToken: page
            });
            if (answer.error) {
                setFailure({ error: answer.error, relink: Boolean(answer.relink) });
                if (!page) setFiles([]);
                return;
            }
            setFailure(null);
            setFiles((held) => [...(page ? (held ?? []) : []), ...(answer.files ?? [])]);
            setNext(answer.next ?? null);
        },
        [accountId, search]
    );

    // Searched as they type, after a beat, like the document list.
    useEffect(() => {
        if (!accountId) return;
        setFiles(null);
        const timer = setTimeout(() => void load(null), search ? 300 : 0);
        return () => clearTimeout(timer);
    }, [accountId, load, search]);

    async function open(file: GoogleOfficeFile): Promise<void> {
        if (!accountId || opening) return;
        setOpening(file.id);
        const answer = await importGoogleFileAction({
            connectionId: accountId,
            fileId: file.id,
            orgId
        });
        setOpening(null);
        if (answer.error || !answer.id || !answer.kind) {
            toast.show({ title: answer.error ?? t("google.errors.failed") });
            return;
        }
        onClose();
        router.push(core.officeDocumentPath(answer.kind, answer.id));
    }

    return (
        <Dialog open onOpenChange={(open) => (open ? undefined : onClose())}>
            <DialogContent className="max-w-lg">
                <DialogHeader>
                    <DialogTitle>{t("google.importTitle")}</DialogTitle>
                    <DialogDescription>{t("google.importBody")}</DialogDescription>
                </DialogHeader>

                {state.status === "loading" ? (
                    <Skeleton className="h-9 w-full" />
                ) : state.status === "unavailable" ? (
                    <p className="text-sm text-foreground-muted">{t("google.unavailable")}</p>
                ) : usable.length === 0 ? (
                    <div className="space-y-3">
                        <p className="text-sm text-foreground-muted">
                            {state.accounts.length > 0
                                ? t("google.reauthorize")
                                : t("google.connectFirst")}
                        </p>
                        <Button asChild size="sm">
                            <a href={OFFICE_GOOGLE_LINK}>
                                <ExternalLink className="size-4 shrink-0" aria-hidden />
                                {t("google.connect")}
                            </a>
                        </Button>
                    </div>
                ) : (
                    <div className="flex min-w-0 flex-col gap-3">
                        <div className="flex flex-wrap items-center gap-2">
                            {usable.length > 1 ? (
                                <Select
                                    className="w-full sm:w-52"
                                    aria-label={t("google.account")}
                                    value={accountId ?? ""}
                                    onValueChange={(value) => setAccountId(value)}
                                    options={usable.map((account) => ({
                                        value: account.id,
                                        label: account.label
                                    }))}
                                />
                            ) : (
                                <p
                                    className="min-w-0 truncate text-sm text-foreground-muted"
                                    title={usable[0]?.label}
                                >
                                    {usable[0]?.label}
                                </p>
                            )}
                            <div className="relative min-w-0 flex-1">
                                <Search
                                    className="pointer-events-none absolute left-2 top-1/2 size-4 shrink-0 -translate-y-1/2 text-foreground-subtle"
                                    aria-hidden
                                />
                                <Input
                                    className="pl-8"
                                    value={search}
                                    placeholder={t("google.search")}
                                    aria-label={t("google.search")}
                                    onChange={(event) => setSearch(event.target.value)}
                                />
                            </div>
                        </div>

                        {failure ? (
                            <div className="space-y-2" role="alert">
                                <p className="text-sm text-danger">{failure.error}</p>
                                {failure.relink ? (
                                    <Button asChild size="sm" variant="secondary">
                                        <a href={OFFICE_GOOGLE_LINK}>{t("google.connect")}</a>
                                    </Button>
                                ) : (
                                    <Button
                                        size="sm"
                                        variant="secondary"
                                        onClick={() => void load(null)}
                                    >
                                        <RefreshCw className="size-4 shrink-0" aria-hidden />
                                        {t("google.retry")}
                                    </Button>
                                )}
                            </div>
                        ) : null}

                        {files === null ? (
                            <ul className="flex flex-col gap-1" aria-hidden>
                                {[0, 1, 2, 3].map((row) => (
                                    <li key={row} className="flex items-center gap-3 px-2 py-2">
                                        <Skeleton className="size-5 shrink-0 rounded" />
                                        <Skeleton className="h-3.5 flex-1" />
                                    </li>
                                ))}
                            </ul>
                        ) : files.length === 0 && !failure ? (
                            <EmptyState
                                icon={<FileText className="size-5 shrink-0" aria-hidden />}
                                title={search ? t("google.noMatch") : t("google.none")}
                            />
                        ) : (
                            <ul className="-mx-2 flex max-h-80 flex-col gap-0.5 overflow-y-auto">
                                {files.map((file) => {
                                    const Icon = MIME_ICONS[file.mime];
                                    return (
                                        <li key={file.id}>
                                            <button
                                                type="button"
                                                className="flex w-full min-w-0 items-center gap-3 rounded-md px-2 py-2 text-left hover:bg-option-hover disabled:cursor-not-allowed disabled:opacity-60"
                                                disabled={!file.importable || opening !== null}
                                                title={
                                                    file.importable
                                                        ? file.name
                                                        : t("google.slidesLater")
                                                }
                                                onClick={() => void open(file)}
                                            >
                                                {opening === file.id ? (
                                                    <Loader2
                                                        className="size-4 shrink-0 animate-spin"
                                                        aria-hidden
                                                    />
                                                ) : (
                                                    <Icon
                                                        className="size-4 shrink-0 text-foreground-muted"
                                                        aria-hidden
                                                    />
                                                )}
                                                <span className="min-w-0 flex-1">
                                                    <span
                                                        className="block truncate text-sm"
                                                        title={file.name}
                                                    >
                                                        {file.name}
                                                    </span>
                                                    {file.importable ? null : (
                                                        <span className="block truncate text-xs text-foreground-subtle">
                                                            {t("google.slidesLater")}
                                                        </span>
                                                    )}
                                                </span>
                                                {file.modifiedAt ? (
                                                    <span className="shrink-0 text-xs text-foreground-subtle">
                                                        <RelativeTime iso={file.modifiedAt} />
                                                    </span>
                                                ) : null}
                                            </button>
                                        </li>
                                    );
                                })}
                            </ul>
                        )}

                        {next ? (
                            <Button
                                size="sm"
                                variant="ghost"
                                disabled={more}
                                onClick={() => {
                                    setMore(true);
                                    void load(next).finally(() => setMore(false));
                                }}
                            >
                                {more ? (
                                    <Loader2 className="size-4 shrink-0 animate-spin" aria-hidden />
                                ) : null}
                                {t("google.more")}
                            </Button>
                        ) : null}
                    </div>
                )}
            </DialogContent>
        </Dialog>
    );
}
