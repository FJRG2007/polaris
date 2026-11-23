"use client";

/**
 * The terminals list: the account's own (open, rename, share, sign out) and
 * the ones shared with it (open). The list refreshes every half minute so
 * online state follows; an offline terminal says what brings it back.
 */

import { useCallback, useEffect, useState } from "react";
import { MoreHorizontal, Pencil, Share2, SquareTerminal, Trash2, Eye } from "lucide-react";
import {
    Badge,
    Button,
    Dialog,
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
import { TerminalViewer } from "./terminal-viewer";
import { useConfirm } from "@/components/confirm-dialog";
import { RelativeTime } from "@/components/relative-time";
import type { TerminalView } from "@/lib/terminal/instances";
import { ShareDialog } from "@/components/access/share-dialog";
import { useTranslations } from "@/components/i18n/i18n-provider";
import { listTerminalsAction, renameTerminalAction, revokeTerminalAction } from "./actions";

const POLL_LIST_MS = 30_000;
const NAME_MAX = 60;

type Lists = { owned: TerminalView[]; shared: TerminalView[] };

export function TerminalsView({ initial, openId }: { initial: Lists; openId: string | null }) {
    const t = useTranslations("account");
    const [lists, setLists] = useState(initial);
    const [error, setError] = useState<string | null>(null);
    const [renaming, setRenaming] = useState<TerminalView | null>(null);
    const [sharing, setSharing] = useState<TerminalView | null>(null);
    const [opened, setOpened] = useState<TerminalView | null>(
        () => [...initial.owned, ...initial.shared].find((one) => one.id === openId) ?? null
    );
    const [confirm, confirmElement] = useConfirm();

    const reload = useCallback(() => {
        void listTerminalsAction()
            .then(setLists)
            .catch(() => undefined);
    }, []);
    useEffect(() => {
        const timer = setInterval(reload, POLL_LIST_MS);
        return () => clearInterval(timer);
    }, [reload]);

    const display = (terminal: TerminalView) => terminal.name ?? t("terminals.list.unnamed");

    const revoke = async (terminal: TerminalView) => {
        const ok = await confirm({
            title: t("terminals.revoke.title", { name: display(terminal) }),
            description: t("terminals.revoke.description"),
            confirmLabel: t("terminals.revoke.confirm"),
            danger: true
        });
        if (!ok) return;
        const before = lists;
        setLists((current) => ({ ...current, owned: current.owned.filter((item) => item.id !== terminal.id) }));
        const result = await revokeTerminalAction(terminal.id).catch(() => ({ error: t("terminals.errors.gone") }));
        if (result.error) {
            setLists(before);
            setError(result.error);
        }
    };

    const row = (terminal: TerminalView) => (
        <li key={terminal.id} className="flex min-w-0 items-start gap-3 px-3 py-2.5">
            <SquareTerminal className="mt-0.5 size-4 shrink-0 text-muted-foreground" aria-hidden />
            <div className="flex min-w-0 flex-1 flex-col gap-1">
                <div className="flex min-w-0 items-center gap-2">
                    <button
                        type="button"
                        className="min-w-0 truncate text-start font-medium hover:underline disabled:no-underline disabled:opacity-100"
                        title={display(terminal)}
                        disabled={!terminal.online}
                        onClick={() => setOpened(terminal)}
                    >
                        {display(terminal)}
                    </button>
                    <Badge variant={terminal.online ? "success" : "neutral"}>
                        {terminal.online ? t("terminals.list.online") : t("terminals.list.offline")}
                    </Badge>
                    {terminal.access !== "owner" ? (
                        <Badge>{terminal.access === "control" ? t("terminals.list.canControl") : t("terminals.list.canView")}</Badge>
                    ) : null}
                </div>
                <div className="flex min-w-0 flex-wrap gap-x-3 gap-y-0.5 text-xs text-muted-foreground">
                    {terminal.ownerName ? <span className="truncate">{t("terminals.list.owner", { name: terminal.ownerName })}</span> : null}
                    {terminal.os ? <span className="truncate" title={terminal.os}>{terminal.os}</span> : null}
                    {terminal.version ? <span>{t("terminals.list.version", { version: terminal.version })}</span> : null}
                    {!terminal.online ? (
                        terminal.lastSeenAt ? (
                            <span>
                                {t("terminals.list.lastSeen")} <RelativeTime iso={terminal.lastSeenAt} />
                            </span>
                        ) : (
                            <span>{t("terminals.list.neverSeen")}</span>
                        )
                    ) : null}
                </div>
                {!terminal.online ? (
                    <p className="text-xs text-muted-foreground">
                        {terminal.access === "owner"
                            ? t("terminals.list.offlineHint")
                            : terminal.ownerName
                              ? t("terminals.list.sharedOfflineHint", { name: terminal.ownerName })
                              : t("terminals.list.sharedOfflineHintNoName")}
                    </p>
                ) : null}
            </div>
            <DropdownMenu>
                <DropdownMenuTrigger asChild>
                    <Button variant="ghost" size="icon" aria-label={t("terminals.list.actions", { name: display(terminal) })}>
                        <MoreHorizontal className="size-4" aria-hidden />
                    </Button>
                </DropdownMenuTrigger>
                <DropdownMenuContent align="end">
                    <DropdownMenuItem disabled={!terminal.online} onSelect={() => setOpened(terminal)}>
                        <Eye className="size-4" aria-hidden />
                        {terminal.online ? t("terminals.open.button") : t("terminals.open.offline")}
                    </DropdownMenuItem>
                    {terminal.access === "owner" ? (
                        <>
                            <DropdownMenuItem onSelect={() => setRenaming(terminal)}>
                                <Pencil className="size-4" aria-hidden />
                                {t("terminals.rename.button")}
                            </DropdownMenuItem>
                            <DropdownMenuItem onSelect={() => setSharing(terminal)}>
                                <Share2 className="size-4" aria-hidden />
                                {t("terminals.share")}
                            </DropdownMenuItem>
                            <DropdownMenuItem onSelect={() => void revoke(terminal)} className="text-destructive">
                                <Trash2 className="size-4" aria-hidden />
                                {t("terminals.revoke.confirm")}
                            </DropdownMenuItem>
                        </>
                    ) : null}
                </DropdownMenuContent>
            </DropdownMenu>
        </li>
    );

    return (
        <div className="flex min-w-0 flex-col gap-3">
            {error ? (
                <p role="alert" className="text-sm text-destructive">
                    {error}
                </p>
            ) : null}
            {lists.owned.length === 0 ? (
                <p className="rounded-md border border-dashed border-border px-3 py-6 text-center text-sm text-muted-foreground">
                    {t("terminals.list.empty")}
                </p>
            ) : (
                <ul className="flex min-w-0 flex-col divide-y divide-border rounded-md border border-border">
                    {lists.owned.map(row)}
                </ul>
            )}
            {lists.shared.length > 0 ? (
                <section className="flex min-w-0 flex-col gap-2">
                    <h2 className="text-sm font-medium">{t("terminals.list.sharedTitle")}</h2>
                    <ul className="flex min-w-0 flex-col divide-y divide-border rounded-md border border-border">
                        {lists.shared.map(row)}
                    </ul>
                </section>
            ) : null}
            {opened ? (
                <TerminalViewer
                    terminalId={opened.id}
                    name={display(opened)}
                    access={opened.access}
                    onClose={() => setOpened(null)}
                />
            ) : null}
            {sharing ? (
                <ShareDialog
                    open
                    onOpenChange={(next) => !next && setSharing(null)}
                    subject="terminal.instance"
                    subjectId={sharing.id}
                    name={display(sharing)}
                />
            ) : null}
            {renaming ? (
                <RenameDialog
                    terminal={renaming}
                    current={display(renaming)}
                    onClose={() => setRenaming(null)}
                    onRenamed={(name) => {
                        setLists((current) => ({
                            ...current,
                            owned: current.owned.map((item) => (item.id === renaming.id ? { ...item, name } : item))
                        }));
                        setRenaming(null);
                    }}
                />
            ) : null}
            {confirmElement}
        </div>
    );
}

function RenameDialog({
    terminal,
    current,
    onClose,
    onRenamed
}: {
    terminal: TerminalView;
    current: string;
    onClose: () => void;
    onRenamed: (name: string) => void;
}) {
    const t = useTranslations("account");
    const [name, setName] = useState(current);
    const [error, setError] = useState<string | null>(null);
    const [busy, setBusy] = useState(false);
    const normalized = name.replace(/\s+/g, " ").trim();
    const unchanged = normalized === current;
    const valid = normalized.length > 0 && normalized.length <= NAME_MAX;

    const save = async () => {
        if (!valid || unchanged || busy) return;
        setBusy(true);
        const result = await renameTerminalAction(terminal.id, normalized).catch(() => ({ error: t("terminals.errors.gone") }));
        setBusy(false);
        if (result.error) setError(result.error);
        else onRenamed(normalized);
    };

    return (
        <Dialog open onOpenChange={(next) => !next && onClose()}>
            <DialogContent className="max-w-md">
                <DialogHeader>
                    <DialogTitle>{t("terminals.rename.title")}</DialogTitle>
                    <DialogDescription>{t("terminals.rename.description")}</DialogDescription>
                </DialogHeader>
                <form
                    className="flex flex-col gap-3"
                    onSubmit={(event) => {
                        event.preventDefault();
                        void save();
                    }}
                >
                    <Input
                        value={name}
                        maxLength={NAME_MAX}
                        aria-label={t("terminals.rename.label")}
                        aria-invalid={!valid && normalized.length > 0 ? true : undefined}
                        onChange={(event) => {
                            setName(event.target.value);
                            setError(null);
                        }}
                        autoFocus
                    />
                    {error ? (
                        <p role="alert" className="text-sm text-destructive">
                            {error}
                        </p>
                    ) : null}
                    <div className="flex justify-end gap-2">
                        <Button type="button" variant="ghost" onClick={onClose}>
                            {t("terminals.rename.cancel")}
                        </Button>
                        <Button type="submit" aria-disabled={!valid || unchanged || busy} disabled={busy}>
                            {t("terminals.rename.save")}
                        </Button>
                    </div>
                </form>
            </DialogContent>
        </Dialog>
    );
}
