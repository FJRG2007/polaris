"use client";

/**
 * The computers list and its dialogs: pair (a code to type, or scan as a QR),
 * rename, and forget. Pairing polls until the code is used, then reloads the
 * list; the list itself refreshes every half minute so online state follows.
 */

import { QRCodeSVG } from "qrcode.react";
import { CopyButton } from "@/components/copy-button";
import { useCallback, useEffect, useState } from "react";
import { useConfirm } from "@/components/confirm-dialog";
import { RelativeTime } from "@/components/relative-time";
import { useTranslations } from "@/components/i18n/i18n-provider";
import { desktopBridge, type DesktopComputer, type DesktopComputerState } from "@/lib/desktop-bridge";
import type { ComputerView } from "@/lib/computers/computer-service";
import { Laptop, MoreHorizontal, Pencil, Plus, Trash2 } from "lucide-react";
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
import {
    listComputersAction,
    openPairingAction,
    pairingWaitingAction,
    renameComputerAction,
    revokeComputerAction
} from "./actions";

const POLL_PAIRING_MS = 3_000;
const POLL_LIST_MS = 30_000;
const NAME_MAX = 60;

const PLATFORM_NAMES: Record<string, string> = {
    win32: "Windows",
    darwin: "macOS",
    linux: "Linux",
    freebsd: "FreeBSD",
    openbsd: "OpenBSD"
};

export function ComputersView({ initial }: { initial: ComputerView[] }) {
    const t = useTranslations("account");
    const [items, setItems] = useState(initial);
    const [error, setError] = useState<string | null>(null);
    const [pairing, setPairing] = useState(false);
    const [renaming, setRenaming] = useState<ComputerView | null>(null);
    const [confirm, confirmElement] = useConfirm();

    const reload = useCallback(() => {
        void listComputersAction()
            .then(setItems)
            .catch(() => undefined);
    }, []);
    useEffect(() => {
        const timer = setInterval(reload, POLL_LIST_MS);
        return () => clearInterval(timer);
    }, [reload]);

    const revoke = async (computer: ComputerView) => {
        const ok = await confirm({
            title: t("computers.revoke.title", { name: computer.name }),
            description: t("computers.revoke.description"),
            confirmLabel: t("computers.revoke.confirm"),
            danger: true
        });
        if (!ok) return;
        const before = items;
        setItems((current) => current.filter((item) => item.id !== computer.id));
        const result = await revokeComputerAction(computer.id).catch(() => ({ error: t("computers.errors.gone") }));
        if (result.error) {
            setItems(before);
            setError(result.error);
        }
    };

    return (
        <div className="flex min-w-0 flex-col gap-3">
            <ThisComputer onPaired={reload} />
            <div>
                <Button onClick={() => setPairing(true)}>
                    <Plus className="size-4" aria-hidden />
                    {t("computers.pair.button")}
                </Button>
            </div>
            {error ? (
                <p role="alert" className="text-sm text-destructive">
                    {error}
                </p>
            ) : null}
            {items.length === 0 ? (
                <p className="rounded-md border border-dashed border-border px-3 py-6 text-center text-sm text-muted-foreground">
                    {t("computers.list.empty")}
                </p>
            ) : (
                <ul className="flex min-w-0 flex-col divide-y divide-border rounded-md border border-border">
                    {items.map((computer) => (
                        <li key={computer.id} className="flex min-w-0 items-start gap-3 px-3 py-2.5">
                            <Laptop className="mt-0.5 size-4 shrink-0 text-muted-foreground" aria-hidden />
                            <div className="flex min-w-0 flex-1 flex-col gap-1">
                                <div className="flex min-w-0 items-center gap-2">
                                    <span className="min-w-0 truncate font-medium" title={computer.name}>
                                        {computer.name}
                                    </span>
                                    <Badge variant={computer.online ? "success" : "neutral"}>
                                        {computer.online ? t("computers.list.online") : t("computers.list.offline")}
                                    </Badge>
                                </div>
                                <div className="flex min-w-0 flex-wrap gap-x-3 gap-y-0.5 text-xs text-muted-foreground">
                                    {computer.platform ? (
                                        <span className="truncate">
                                            {PLATFORM_NAMES[computer.platform] ?? computer.platform}
                                            {computer.osRelease ? ` ${computer.osRelease}` : ""}
                                        </span>
                                    ) : null}
                                    {!computer.online ? (
                                        computer.lastSeenAt ? (
                                            <span>
                                                {t("computers.list.lastSeen")} <RelativeTime iso={computer.lastSeenAt} />
                                            </span>
                                        ) : (
                                            <span>{t("computers.list.neverSeen")}</span>
                                        )
                                    ) : null}
                                    {computer.runnerVersion ? (
                                        <span>{t("computers.list.version", { version: computer.runnerVersion })}</span>
                                    ) : null}
                                </div>
                                {computer.clis.length > 0 ? (
                                    <div className="flex min-w-0 flex-wrap gap-1">
                                        {computer.clis.map((cli) => (
                                            <Badge
                                                key={cli.id}
                                                title={
                                                    cli.signedIn === "no" ? t("computers.list.signedOut") : cli.version
                                                }
                                            >
                                                {cli.id}
                                                {cli.signedIn === "no" ? ` (${t("computers.list.signedOutShort")})` : ""}
                                            </Badge>
                                        ))}
                                    </div>
                                ) : null}
                            </div>
                            <DropdownMenu>
                                <DropdownMenuTrigger asChild>
                                    <Button
                                        variant="ghost"
                                        size="icon"
                                        aria-label={t("computers.list.actions", { name: computer.name })}
                                    >
                                        <MoreHorizontal className="size-4" aria-hidden />
                                    </Button>
                                </DropdownMenuTrigger>
                                <DropdownMenuContent align="end">
                                    <DropdownMenuItem onSelect={() => setRenaming(computer)}>
                                        <Pencil className="size-4" aria-hidden />
                                        {t("computers.rename.button")}
                                    </DropdownMenuItem>
                                    <DropdownMenuItem onSelect={() => void revoke(computer)} className="text-destructive">
                                        <Trash2 className="size-4" aria-hidden />
                                        {t("computers.revoke.confirm")}
                                    </DropdownMenuItem>
                                </DropdownMenuContent>
                            </DropdownMenu>
                        </li>
                    ))}
                </ul>
            )}
            {pairing ? (
                <PairDialog
                    onClose={() => setPairing(false)}
                    onPaired={() => {
                        setPairing(false);
                        reload();
                    }}
                />
            ) : null}
            {renaming ? (
                <RenameDialog
                    computer={renaming}
                    onClose={() => setRenaming(null)}
                    onRenamed={(name) => {
                        setItems((current) =>
                            current.map((item) => (item.id === renaming.id ? { ...item, name } : item))
                        );
                        setRenaming(null);
                    }}
                />
            ) : null}
            {confirmElement}
        </div>
    );
}

function PairDialog({ onClose, onPaired }: { onClose: () => void; onPaired: () => void }) {
    const t = useTranslations("account");
    const [code, setCode] = useState<{ code: string; display: string; expiresAt: string } | null>(null);
    const [error, setError] = useState<string | null>(null);
    const [expired, setExpired] = useState(false);

    const open = useCallback(() => {
        setError(null);
        setExpired(false);
        setCode(null);
        void openPairingAction()
            .then((result) => ("error" in result ? setError(result.error) : setCode(result)))
            .catch(() => setError(t("computers.errors.pair")));
    }, [t]);
    useEffect(open, [open]);

    useEffect(() => {
        if (!code || expired) return;
        const timer = setInterval(() => {
            if (Date.parse(code.expiresAt) <= Date.now()) {
                setExpired(true);
                return;
            }
            void pairingWaitingAction(code.code)
                .then((waiting) => {
                    // Gone before it expired: a computer used it.
                    if (!waiting && Date.parse(code.expiresAt) > Date.now()) onPaired();
                })
                .catch(() => undefined);
        }, POLL_PAIRING_MS);
        return () => clearInterval(timer);
    }, [code, expired, onPaired]);

    return (
        <Dialog open onOpenChange={(next) => !next && onClose()}>
            <DialogContent className="max-w-sm">
                <DialogHeader>
                    <DialogTitle>{t("computers.pair.title")}</DialogTitle>
                    <DialogDescription>{t("computers.pair.description")}</DialogDescription>
                </DialogHeader>
                <div className="flex flex-col items-center gap-3">
                    {error ? (
                        <p role="alert" className="text-sm text-destructive">
                            {error}
                        </p>
                    ) : code === null ? (
                        <div className="size-[164px] animate-pulse rounded-md bg-muted" aria-hidden />
                    ) : expired ? (
                        <p className="text-sm text-muted-foreground">{t("computers.pair.expired")}</p>
                    ) : (
                        <>
                            <div className="rounded-md bg-white p-2">
                                <QRCodeSVG value={code.code} size={148} bgColor="#ffffff" fgColor="#000000" />
                            </div>
                            <div className="flex items-center gap-2">
                                <span className="font-mono text-2xl tracking-widest">{code.display}</span>
                                <CopyButton value={code.code} />
                            </div>
                            <p className="text-xs text-muted-foreground" role="status">
                                {t("computers.pair.waiting")}
                            </p>
                        </>
                    )}
                </div>
                <div className="flex justify-end gap-2">
                    {error || expired ? <Button onClick={open}>{t("computers.pair.again")}</Button> : null}
                    <Button variant="ghost" onClick={onClose}>
                        {t("computers.pair.close")}
                    </Button>
                </div>
            </DialogContent>
        </Dialog>
    );
}

function RenameDialog({
    computer,
    onClose,
    onRenamed
}: {
    computer: ComputerView;
    onClose: () => void;
    onRenamed: (name: string) => void;
}) {
    const t = useTranslations("account");
    const [name, setName] = useState(computer.name);
    const [error, setError] = useState<string | null>(null);
    const [busy, setBusy] = useState(false);
    const trimmed = name.trim().replace(/\s+/g, " ");
    const valid = trimmed.length > 0 && trimmed.length <= NAME_MAX;
    const changed = trimmed !== computer.name;

    const save = async () => {
        if (!valid || !changed || busy) return;
        setBusy(true);
        const result = await renameComputerAction(computer.id, trimmed).catch(() => ({
            error: t("computers.errors.gone")
        }));
        setBusy(false);
        if (result.error) setError(result.error);
        else onRenamed(trimmed);
    };

    return (
        <Dialog open onOpenChange={(next) => !next && onClose()}>
            <DialogContent className="max-w-sm">
                <DialogHeader>
                    <DialogTitle>{t("computers.rename.title")}</DialogTitle>
                </DialogHeader>
                <form
                    className="flex flex-col gap-3"
                    onSubmit={(event) => {
                        event.preventDefault();
                        void save();
                    }}
                >
                    <label className="flex flex-col gap-1 text-sm">
                        <span>{t("computers.rename.label")} *</span>
                        <Input
                            value={name}
                            maxLength={NAME_MAX}
                            onChange={(event) => {
                                setName(event.target.value);
                                setError(null);
                            }}
                            autoFocus
                        />
                    </label>
                    {error ? (
                        <p role="alert" className="text-sm text-destructive">
                            {error}
                        </p>
                    ) : null}
                    <div className="flex justify-end gap-2">
                        <Button type="button" variant="ghost" onClick={onClose}>
                            {t("computers.pair.close")}
                        </Button>
                        <Button type="submit" aria-disabled={!valid || !changed || busy} disabled={busy}>
                            {t("computers.rename.save")}
                        </Button>
                    </div>
                </form>
            </DialogContent>
        </Dialog>
    );
}

const TOOL_NAMES = ["git", "node", "gh", "enigma", "claude", "codex", "opencode"] as const;

/**
 * The computer this page is open on, when it is the Polaris desktop app: pair
 * it in one press (a code is opened and handed straight to the app), and see
 * it prepare the tools sessions need, with Try again when that failed.
 */
function ThisComputer({ onPaired }: { onPaired: () => void }) {
    const t = useTranslations("account");
    const tp = useTranslations("polar");
    const [bridge, setBridge] = useState<DesktopComputer | null>(null);
    const [state, setState] = useState<DesktopComputerState | null>(null);
    const [busy, setBusy] = useState(false);
    const [error, setError] = useState<string | null>(null);

    useEffect(() => {
        const computer = desktopBridge()?.computer ?? null;
        setBridge(computer);
        if (!computer) return;
        void computer.state().then(setState).catch(() => undefined);
        return computer.onState(setState);
    }, []);

    if (!bridge) return null;

    const pair = () => {
        setBusy(true);
        setError(null);
        void openPairingAction()
            .then(async (code) => {
                if ("error" in code) return setError(code.error);
                const answer = await bridge.pair(code.code);
                if (answer.ok) onPaired();
                else setError(t(`computers.here.errors.${answer.reason}`));
            })
            .catch(() => setError(t("computers.here.errors.offline")))
            .finally(() => setBusy(false));
    };

    const preparing = state?.preparing ?? null;
    const tool = preparing ? ((TOOL_NAMES as readonly string[]).includes(preparing.tool) ? tp(`toolchain.tools.${preparing.tool as (typeof TOOL_NAMES)[number]}`) : preparing.tool) : "";
    const percent = preparing?.total ? Math.min(100, Math.floor(((preparing.received ?? 0) / preparing.total) * 100)) : null;
    const status = !state?.paired ? t("computers.here.unpaired") : t(`computers.here.state.${state.state}`);

    return (
        <section className="flex min-w-0 flex-col gap-2 rounded-md border border-border px-3 py-3">
            <div className="flex min-w-0 flex-wrap items-center gap-2">
                <Laptop className="size-4 shrink-0 text-muted-foreground" aria-hidden />
                <span className="min-w-0 truncate font-medium">{t("computers.here.title")}</span>
                <span className="min-w-0 truncate text-sm text-muted-foreground">{status}</span>
            </div>
            {preparing && preparing.step !== "ready" ? (
                <p className="text-sm text-muted-foreground" aria-live="polite">
                    {preparing.step === "failed"
                        ? tp(`toolchain.failures.${preparing.code ?? "install"}`)
                        : tp("toolchain.preparing", { tools: percent === null ? tool : tp("toolchain.preparingStep", { tool, percent }) })}
                </p>
            ) : null}
            {error ? (
                <p role="alert" className="text-sm text-destructive">
                    {error}
                </p>
            ) : null}
            <div className="flex flex-wrap gap-2">
                {!state?.paired ? (
                    <Button size="sm" disabled={busy} onClick={pair}>
                        {t("computers.here.use")}
                    </Button>
                ) : null}
                {state?.paired && preparing?.step === "failed" ? (
                    <Button size="sm" variant="outline" disabled={busy} onClick={() => void bridge.prepare()}>
                        {tp("toolchain.retry")}
                    </Button>
                ) : null}
            </div>
        </section>
    );
}
