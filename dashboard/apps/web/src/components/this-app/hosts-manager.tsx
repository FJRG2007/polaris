"use client";

/**
 * Settings > This app > Hosts, in a desktop app that manages its hosts from here
 * (`appSettings.hosts`): the hosts as a table with how each one answers, a row menu
 * to switch to, edit, copy or remove one, "Add host" in the header opening a dialog,
 * and sending the list to or taking one from another device.
 *
 * Every address is checked by the app itself, with the same schema and probe as
 * its own hosts window; the page only normalizes what is typed and reads every
 * answer through a schema (`readDesktopHost*`).
 *
 * The list draws at once from the last one this device saw (kept for the session
 * and in `localStorage`), and the app is asked in the background on mount, when
 * it says the list changed, and whenever the page comes back into view.
 */

import { QRCodeSVG } from "qrcode.react";
import { Check, Copy, MoreHorizontal, Pencil, Plus, Trash2 } from "lucide-react";
import { QrScanDialog } from "@/app/(app)/vault/qr-scan";
import { useCallback, useEffect, useRef, useState, type FormEvent } from "react";
import { useTranslations } from "@/components/i18n/i18n-provider";
import {
    Badge,
    Button,
    Card,
    CardBody,
    ConfirmDeleteDialog,
    Dialog,
    DialogContent,
    DialogDescription,
    DialogHeader,
    DialogTitle,
    DropdownMenu,
    DropdownMenuContent,
    DropdownMenuItem,
    DropdownMenuSeparator,
    DropdownMenuTrigger,
    Input,
    Textarea,
    useToast
} from "@polaris/ui";
import * as bridge from "@/lib/desktop-bridge";
import { useKeptAnswer, type KeptAnswerStore } from "@/components/this-app/app-settings-values";

/** The longest name the app keeps for a host (`SERVER_NAME_MAX` in the desktop app). */
export const HOST_NAME_MAX = 40;

/** How long typing pauses before the app is asked about an address. */
const CHECK_DELAY_MS = 400;

const STORE_KEY = "polaris.this-app.hosts";

/** The list the app gave this session, so the page opened again draws it unchanged; the device keeps the last one too. */
const hostsStore: KeptAnswerStore<bridge.DesktopHostsSnapshot> = {
    session: null,
    key: STORE_KEY,
    parse: bridge.readDesktopHosts
};

/** How each host answered this session, by origin, so a revisit shows the dots it had. */
const sessionStatus = new Map<string, bridge.DesktopHostStatus>();

/** Only for tests: forget the session's list and statuses. */
export function forgetHostsSnapshot(): void {
    hostsStore.session = null;
    sessionStatus.clear();
}

export function normalizeHostAddress(value: string): string {
    return value.trim();
}

/** The name as the app keeps it: surrounding space trimmed and inner runs collapsed; empty shows the host. */
export function normalizeHostName(value: string): string {
    return value.trim().replace(/\s+/g, " ");
}

function shownName(row: Pick<bridge.DesktopHostRow, "name" | "host" | "origin">): string {
    return row.name ?? (row.host || row.origin);
}

type AddressState =
    | { readonly kind: "empty" }
    | { readonly kind: "same" }
    | { readonly kind: "checking" }
    | { readonly kind: "ok"; readonly message: string | null }
    | { readonly kind: "bad"; readonly message: string | null };

/**
 * The app's verdict on a typed address, asked once typing pauses. An empty field
 * is incomplete, not wrong; the address a row already has needs no asking.
 */
function useAddressCheck(hosts: bridge.DesktopHosts, value: string, current: string | null = null): AddressState {
    const address = normalizeHostAddress(value);
    const [state, setState] = useState<AddressState>({ kind: "empty" });
    const asked = useRef(0);

    useEffect(() => {
        const ask = ++asked.current;
        if (!address) return setState({ kind: "empty" });
        if (current !== null && address === current) return setState({ kind: "same" });
        setState({ kind: "checking" });
        const timer = window.setTimeout(() => {
            void hosts
                .check(address)
                .catch(() => null)
                .then((raw) => {
                    if (ask !== asked.current) return;
                    const answer = bridge.readDesktopAddressCheck(raw);
                    // A null line with no verdict is a check a newer address replaced.
                    if (!answer.ok && answer.message === null && raw !== null) return;
                    setState(answer.ok ? { kind: "ok", message: answer.message } : { kind: "bad", message: answer.message });
                });
        }, CHECK_DELAY_MS);
        return () => window.clearTimeout(timer);
    }, [hosts, address, current]);

    return state;
}

function AddressLine({ state }: { state: AddressState }) {
    const t = useTranslations("appSettings");
    if (state.kind === "empty" || state.kind === "same") return null;
    if (state.kind === "checking") {
        return (
            <p className="text-xs text-muted-foreground" aria-live="polite">
                {t("hosts.checking")}
            </p>
        );
    }
    if (state.kind === "ok") {
        return (
            <p className="text-xs text-success-ink" aria-live="polite">
                {t("hosts.found")}
            </p>
        );
    }
    return (
        <p className="text-xs text-danger-ink" role="alert">
            {state.message || t("hosts.notPolaris")}
        </p>
    );
}

export function HostsManager({ hosts }: { hosts: bridge.DesktopHosts; }) {
    const t = useTranslations("appSettings");
    const toast = useToast();
    const [status, setStatus] = useState<ReadonlyMap<string, bridge.DesktopHostStatus>>(() => new Map(sessionStatus));
    const [adding, setAdding] = useState(false);
    const [editing, setEditing] = useState<bridge.DesktopHostRow | null>(null);
    const [removing, setRemoving] = useState<bridge.DesktopHostRow | null>(null);
    const [busy, setBusy] = useState<string | null>(null);

    const askStatus = useCallback(
        (rows: readonly bridge.DesktopHostRow[]) => {
            for (const row of rows) {
                void hosts
                    .status(row.origin)
                    .catch(() => null)
                    .then((raw) => {
                        const answer = bridge.readDesktopHostStatus(raw);
                        sessionStatus.set(row.origin, answer);
                        setStatus((before) => new Map(before).set(row.origin, answer));
                    });
            }
        },
        [hosts]
    );

    // The list is the app's own and local: drawn at once from the kept copy, asked again behind it, and each host's status fills in after.
    const {
        value: snapshot,
        unavailable,
        refresh,
        keep
    } = useKeptAnswer(hostsStore, () => hosts.list(), { onAnswer: (next) => askStatus(next.servers) });

    /** A switch or a removal the app refused: say so in its words, or ours. */
    const refused = useCallback(
        (error: string) => toast.show({ title: t("hosts.failed"), body: error || undefined }),
        [toast, t]
    );

    const switchTo = async (row: bridge.DesktopHostRow) => {
        setBusy(row.origin);
        const outcome = bridge.readDesktopOutcome(await hosts.switchTo(row.origin).catch(() => null));
        setBusy(null);
        if (!outcome.ok) refused(outcome.error);
    };

    const remove = async (row: bridge.DesktopHostRow) => {
        setRemoving(null);
        const before = hostsStore.session;
        // Shown gone at once; put back when the app refuses.
        if (before) keep({ ...before, servers: before.servers.filter((one) => one.origin !== row.origin) });
        const outcome = bridge.readDesktopOutcome(await hosts.remove(row.origin).catch(() => null));
        if (outcome.ok) return void refresh();
        if (before) keep(before);
        refused(outcome.error);
    };

    const copyAddress = async (row: bridge.DesktopHostRow) => {
        const ok = await navigator.clipboard?.writeText(row.origin).then(
            () => true,
            () => false
        );
        toast.show({ title: ok ? t("hosts.addressCopied") : t("hosts.failed") });
    };

    const servers = snapshot?.servers ?? [];

    return (
        <div className="flex flex-col gap-4">
            <Card>
                <CardBody className="flex flex-col gap-3">
                    {/* The one way to add a host, where every list in Polaris keeps it: the header, opening a dialog. */}
                    <div className="flex flex-wrap items-center justify-between gap-2">
                        <p className="min-w-0 text-xs text-muted-foreground">
                            {snapshot && servers.length > 0 ? t("hosts.count", { count: servers.length }) : null}
                        </p>
                        <Button size="sm" onClick={() => setAdding(true)}>
                            <Plus className="size-4" aria-hidden />
                            {t("hosts.addHost")}
                        </Button>
                    </div>
                    {snapshot?.error && (
                        <p className="text-sm text-danger-ink" role="alert">
                            {snapshot.error}
                        </p>
                    )}
                    {unavailable && !snapshot ? (
                        <div className="flex flex-wrap items-center justify-between gap-3">
                            <p className="min-w-0 text-sm text-muted-foreground">{t("unavailable")}</p>
                            <Button size="sm" variant="secondary" onClick={() => void refresh()}>
                                {t("retry")}
                            </Button>
                        </div>
                    ) : servers.length === 0 ? (
                        <p className="text-sm text-muted-foreground">{snapshot ? t("hosts.none") : t("hosts.reading")}</p>
                    ) : (
                        // The table every list in Polaris is drawn as. On a phone the state folds under the name
                        // instead of taking a column, so the row never scrolls sideways.
                        <div className="overflow-x-auto rounded-lg border border-border">
                            <table className="w-full text-sm">
                                <thead className="bg-surface/60 text-start text-xs text-muted-foreground">
                                    <tr>
                                        <th scope="col" className="w-full max-w-0 px-3 py-2 text-start font-medium">
                                            {t("hosts.columns.host")}
                                        </th>
                                        <th scope="col" className="hidden px-3 py-2 text-start font-medium sm:table-cell">
                                            {t("hosts.columns.state")}
                                        </th>
                                        <th scope="col" className="px-3 py-2">
                                            <span className="sr-only">{t("hosts.columns.actions")}</span>
                                        </th>
                                    </tr>
                                </thead>
                                <tbody>
                                    {servers.map((row) => (
                                        <HostRow
                                            key={row.origin}
                                            row={row}
                                            status={status.get(row.origin) ?? null}
                                            busy={busy === row.origin}
                                            onSwitch={() => void switchTo(row)}
                                            onEdit={() => setEditing(row)}
                                            onCopy={() => void copyAddress(row)}
                                            onRemove={() => setRemoving(row)}
                                        />
                                    ))}
                                </tbody>
                            </table>
                        </div>
                    )}
                </CardBody>
            </Card>
            <HostTransfer hosts={hosts} count={servers.length} onImported={() => void refresh()} />
            <HostAddDialog
                hosts={hosts}
                open={adding}
                onOpenChange={setAdding}
                onAdded={() => {
                    setAdding(false);
                    void refresh();
                }}
            />
            <HostEditDialog
                hosts={hosts}
                row={editing}
                onDone={(changed) => {
                    setEditing(null);
                    if (changed) void refresh();
                }}
            />
            <ConfirmDeleteDialog
                open={removing !== null}
                onOpenChange={(open) => !open && setRemoving(null)}
                name={removing ? shownName(removing) : ""}
                requireTyping={false}
                kind={t("hosts.kind")}
                title={t("hosts.removeTitle")}
                question={removing ? t("hosts.removeQuestion", { name: shownName(removing) }) : null}
                description={removing?.active ? t("hosts.removeActive") : undefined}
                confirmLabel={t("hosts.remove")}
                onConfirm={() => removing && void remove(removing)}
            />
        </div>
    );
}

const STATUS_DOT: Record<bridge.DesktopHostStatus | "checking", string> = {
    online: "bg-success",
    offline: "bg-danger",
    unknown: "bg-muted-foreground",
    checking: "bg-muted-foreground/40"
};

function HostState({ status, active }: { status: bridge.DesktopHostStatus | null; active: boolean; }) {
    const t = useTranslations("appSettings");
    const shown = status ?? "checking";
    return (
        <span className="flex min-w-0 items-center gap-2">
            <span className="flex min-w-0 items-center gap-1.5">
                <span className={`size-2 shrink-0 rounded-full ${STATUS_DOT[shown]}`} aria-hidden />
                <span className="truncate text-xs text-muted-foreground">{t(`hosts.status.${shown}`)}</span>
            </span>
            {active && <Badge variant="success">{t("hosts.current")}</Badge>}
        </span>
    );
}

function HostRow({
    row,
    status,
    busy,
    onSwitch,
    onEdit,
    onCopy,
    onRemove
}: {
    row: bridge.DesktopHostRow;
    status: bridge.DesktopHostStatus | null;
    busy: boolean;
    onSwitch: () => void;
    onEdit: () => void;
    onCopy: () => void;
    onRemove: () => void;
}) {
    const t = useTranslations("appSettings");
    const name = shownName(row);
    return (
        <tr className="border-t border-border hover:bg-card-hover">
            <td className="max-w-0 px-3 py-2 align-top">
                <span className="block truncate font-medium" title={name}>
                    {name}
                </span>
                <span className="block truncate text-xs text-muted-foreground" title={row.origin}>
                    {row.origin}
                </span>
                <span className="mt-1 flex sm:hidden">
                    <HostState status={status} active={row.active} />
                </span>
            </td>
            <td className="hidden whitespace-nowrap px-3 py-2 align-top sm:table-cell">
                <HostState status={status} active={row.active} />
            </td>
            <td className="px-3 py-2 align-top">
                <span className="flex justify-end">
                    <DropdownMenu>
                        <DropdownMenuTrigger asChild>
                            <Button
                                size="icon"
                                variant="ghost"
                                aria-label={t("hosts.menuFor", { name })}
                                title={t("hosts.more")}
                                aria-busy={busy || undefined}
                            >
                                <MoreHorizontal className="size-4" />
                            </Button>
                        </DropdownMenuTrigger>
                        <DropdownMenuContent align="end" className="w-48">
                            {row.active ? null : (
                                <DropdownMenuItem disabled={busy} onSelect={onSwitch}>
                                    <Check className="size-3.5" />
                                    {t("hosts.useThis")}
                                </DropdownMenuItem>
                            )}
                            <DropdownMenuItem onSelect={onEdit}>
                                <Pencil className="size-3.5" />
                                {t("hosts.edit")}
                            </DropdownMenuItem>
                            <DropdownMenuItem onSelect={onCopy}>
                                <Copy className="size-3.5" />
                                {t("hosts.copyAddress")}
                            </DropdownMenuItem>
                            <DropdownMenuSeparator />
                            <DropdownMenuItem variant="danger" onSelect={onRemove}>
                                <Trash2 className="size-3.5" />
                                {t("hosts.remove")}
                            </DropdownMenuItem>
                        </DropdownMenuContent>
                    </DropdownMenu>
                </span>
            </td>
        </tr>
    );
}

/** The address and name fields both dialogs share, with the name's own limit. */
function HostFields({
    address,
    name,
    onAddress,
    onName,
    check,
    idPrefix
}: {
    address: string;
    name: string;
    onAddress: (value: string) => void;
    onName: (value: string) => void;
    check: AddressState;
    idPrefix: string;
}) {
    const t = useTranslations("appSettings");
    const nameLong = normalizeHostName(name).length > HOST_NAME_MAX;
    return (
        <div className="flex flex-col gap-3">
            <div className="flex min-w-0 flex-col gap-1">
                <label htmlFor={`${idPrefix}-address`} className="text-xs text-muted-foreground">
                    {t("hosts.address")} *
                </label>
                <Input
                    id={`${idPrefix}-address`}
                    value={address}
                    onChange={(event) => onAddress(event.target.value)}
                    placeholder={t("hosts.addressPlaceholder")}
                    inputMode="url"
                    autoComplete="off"
                    spellCheck={false}
                    maxLength={2048}
                    aria-invalid={check.kind === "bad" || undefined}
                />
                <AddressLine state={check} />
            </div>
            <div className="flex min-w-0 flex-col gap-1">
                <label htmlFor={`${idPrefix}-name`} className="text-xs text-muted-foreground">
                    {t("hosts.name")}
                </label>
                <Input
                    id={`${idPrefix}-name`}
                    value={name}
                    onChange={(event) => onName(event.target.value)}
                    placeholder={t("hosts.namePlaceholder")}
                    autoComplete="off"
                    maxLength={200}
                    aria-invalid={nameLong || undefined}
                />
                {nameLong && (
                    <p className="text-xs text-danger-ink" role="alert">
                        {t("hosts.nameTooLong", { max: HOST_NAME_MAX })}
                    </p>
                )}
            </div>
        </div>
    );
}

function HostAddDialog({
    hosts,
    open,
    onOpenChange,
    onAdded
}: {
    hosts: bridge.DesktopHosts;
    open: boolean;
    onOpenChange: (open: boolean) => void;
    onAdded: () => void;
}) {
    const t = useTranslations("appSettings");
    const [address, setAddress] = useState("");
    const [name, setName] = useState("");
    const [pending, setPending] = useState(false);
    const [error, setError] = useState<string | null>(null);
    const check = useAddressCheck(hosts, address);
    const ready = check.kind === "ok" && normalizeHostName(name).length <= HOST_NAME_MAX && !pending;

    const add = async (event: FormEvent) => {
        event.preventDefault();
        if (!ready) return;
        setPending(true);
        setError(null);
        const outcome = bridge.readDesktopOutcome(
            await hosts.add(normalizeHostAddress(address), normalizeHostName(name)).catch(() => null)
        );
        setPending(false);
        if (!outcome.ok) return setError(outcome.error || t("hosts.failed"));
        setAddress("");
        setName("");
        onAdded();
    };

    return (
        <Dialog open={open} onOpenChange={(next) => !pending && onOpenChange(next)}>
            <DialogContent className="max-w-md">
                <DialogHeader>
                    <DialogTitle>{t("hosts.addTitle")}</DialogTitle>
                    <DialogDescription>{t("hosts.addDescription")}</DialogDescription>
                </DialogHeader>
                <form className="flex flex-col gap-3" onSubmit={(event) => void add(event)}>
                    <HostFields
                        address={address}
                        name={name}
                        onAddress={(value) => {
                            setAddress(value);
                            setError(null);
                        }}
                        onName={setName}
                        check={check}
                        idPrefix="host-add"
                    />
                    {error && (
                        <p className="text-xs text-danger-ink" role="alert">
                            {error}
                        </p>
                    )}
                    <div className="flex justify-end gap-2">
                        <Button type="button" variant="ghost" disabled={pending} onClick={() => onOpenChange(false)}>
                            {t("hosts.cancel")}
                        </Button>
                        <Button type="submit" aria-disabled={!ready} disabled={pending} aria-busy={pending}>
                            {t("hosts.add")}
                        </Button>
                    </div>
                </form>
            </DialogContent>
        </Dialog>
    );
}

function HostEditDialog({
    hosts,
    row,
    onDone
}: {
    hosts: bridge.DesktopHosts;
    row: bridge.DesktopHostRow | null;
    onDone: (changed: boolean) => void;
}) {
    const t = useTranslations("appSettings");
    return (
        <Dialog open={row !== null} onOpenChange={(open) => !open && onDone(false)}>
            <DialogContent className="max-w-md">
                <DialogHeader>
                    <DialogTitle>{t("hosts.editTitle")}</DialogTitle>
                    <DialogDescription>{row ? shownName(row) : ""}</DialogDescription>
                </DialogHeader>
                {/* Keyed by the row so a second host opens on its own values. */}
                {row ? <HostEdit key={row.origin} hosts={hosts} row={row} onDone={onDone} /> : null}
            </DialogContent>
        </Dialog>
    );
}

function HostEdit({ hosts, row, onDone }: { hosts: bridge.DesktopHosts; row: bridge.DesktopHostRow; onDone: (changed: boolean) => void; }) {
    const t = useTranslations("appSettings");
    const [address, setAddress] = useState(row.origin);
    const [name, setName] = useState(row.name ?? "");
    const [pending, setPending] = useState(false);
    const [error, setError] = useState<string | null>(null);
    const check = useAddressCheck(hosts, address, row.origin);
    const changed = normalizeHostAddress(address) !== row.origin || normalizeHostName(name) !== (row.name ?? "");
    const addressReady = check.kind === "same" || check.kind === "ok";
    const ready = changed && addressReady && normalizeHostName(name).length <= HOST_NAME_MAX && !pending;

    const save = async (event: FormEvent) => {
        event.preventDefault();
        if (!ready) return;
        setPending(true);
        setError(null);
        const outcome = bridge.readDesktopOutcome(
            await hosts.edit(row.origin, normalizeHostAddress(address), normalizeHostName(name)).catch(() => null)
        );
        setPending(false);
        if (!outcome.ok) return setError(outcome.error || t("hosts.failed"));
        onDone(true);
    };

    return (
        <form className="flex flex-col gap-3" onSubmit={(event) => void save(event)}>
            <HostFields
                address={address}
                name={name}
                onAddress={(value) => {
                    setAddress(value);
                    setError(null);
                }}
                onName={setName}
                check={check}
                idPrefix={`host-edit-${row.host}`}
            />
            {error && (
                <p className="text-xs text-danger-ink" role="alert">
                    {error}
                </p>
            )}
            <div className="flex justify-end gap-2">
                <Button type="button" variant="ghost" disabled={pending} onClick={() => onDone(false)}>
                    {t("hosts.cancel")}
                </Button>
                <Button type="submit" aria-disabled={!ready} disabled={pending} aria-busy={pending}>
                    {t("hosts.save")}
                </Button>
            </div>
        </form>
    );
}
function HostTransfer({ hosts, count, onImported }: { hosts: bridge.DesktopHosts; count: number; onImported: () => void }) {
    const t = useTranslations("appSettings");
    const toast = useToast();
    const [link, setLink] = useState<string | null>(null);
    const [showQr, setShowQr] = useState(false);
    const [scanning, setScanning] = useState(false);
    const [code, setCode] = useState("");
    const [pending, setPending] = useState(false);

    // The code follows the list: asked again whenever it is shown and the list changes.
    useEffect(() => {
        if (!showQr) return;
        let live = true;
        void hosts
            .link()
            .catch(() => null)
            .then((raw) => {
                if (live) setLink(bridge.readDesktopHostsLink(raw));
            });
        return () => {
            live = false;
        };
    }, [hosts, showQr, count]);

    const imported = (result: bridge.DesktopHostImport) => {
        if (!result.ok) {
            // Null is a picker somebody closed: nothing to say.
            if (result.error !== null) toast.show({ title: t("hosts.importFailed"), body: result.error || undefined });
            return false;
        }
        toast.show({
            title: t("hosts.imported", { added: result.added }),
            body:
                result.named + result.skipped > 0
                    ? t("hosts.importedMore", { named: result.named, skipped: result.skipped })
                    : undefined
        });
        onImported();
        return true;
    };

    const take = async (text: string) => {
        const value = text.trim();
        if (!value || pending) return;
        setPending(true);
        const done = imported(bridge.readDesktopHostImport(await hosts.importText(value).catch(() => null)));
        setPending(false);
        if (done) setCode("");
    };

    const copy = async () => {
        const result = bridge.readDesktopHostCopy(await hosts.copy().catch(() => null));
        toast.show({ title: result.ok ? t("hosts.copied", { count: result.count }) : t("hosts.failed") });
    };

    const save = async () => {
        const result = bridge.readDesktopHostImport(await hosts.exportFile().catch(() => null));
        if (result.ok) toast.show({ title: t("hosts.saved") });
        else if (result.error !== null) toast.show({ title: t("hosts.failed"), body: result.error || undefined });
    };

    const open = async () => imported(bridge.readDesktopHostImport(await hosts.importFile().catch(() => null)));

    return (
        <Card>
            <CardBody className="flex flex-col gap-5">
                <section className="flex flex-col gap-3">
                    <div className="min-w-0">
                        <h3 className="text-sm font-medium">{t("hosts.exportTitle")}</h3>
                        <p className="text-xs text-muted-foreground">{t("hosts.exportHint")}</p>
                    </div>
                    <div className="flex flex-wrap gap-2">
                        <Button size="sm" variant="secondary" onClick={() => setShowQr(!showQr)} disabled={count === 0}>
                            {showQr ? t("hosts.hideQr") : t("hosts.showQr")}
                        </Button>
                        <Button size="sm" variant="secondary" onClick={() => void copy()} disabled={count === 0}>
                            {t("hosts.copy")}
                        </Button>
                        <Button size="sm" variant="secondary" onClick={() => void save()} disabled={count === 0}>
                            {t("hosts.saveFile")}
                        </Button>
                    </div>
                    {showQr && count > 0 && (
                        // Fixed light colours: a QR has to stay readable in dark mode.
                        <div className="self-start rounded-md bg-white p-2">
                            {link ? (
                                <QRCodeSVG value={link} size={176} bgColor="#ffffff" fgColor="#000000" aria-label={t("hosts.qrLabel")} />
                            ) : (
                                <div className="size-[176px]" aria-busy="true" />
                            )}
                        </div>
                    )}
                </section>
                <section className="flex flex-col gap-3">
                    <div className="min-w-0">
                        <h3 className="text-sm font-medium">{t("hosts.importTitle")}</h3>
                        <p className="text-xs text-muted-foreground">{t("hosts.importHint")}</p>
                    </div>
                    <div className="flex flex-wrap gap-2">
                        <Button size="sm" variant="secondary" onClick={() => setScanning(true)}>
                            {t("hosts.scan")}
                        </Button>
                        <Button size="sm" variant="secondary" onClick={() => void open()}>
                            {t("hosts.openFile")}
                        </Button>
                    </div>
                    <form
                        className="flex flex-col gap-2"
                        onSubmit={(event) => {
                            event.preventDefault();
                            void take(code);
                        }}
                    >
                        <label htmlFor="host-import-code" className="text-xs text-muted-foreground">
                            {t("hosts.pasteLabel")}
                        </label>
                        <Textarea
                            id="host-import-code"
                            value={code}
                            onChange={(event) => setCode(event.target.value)}
                            placeholder={t("hosts.pastePlaceholder")}
                            rows={2}
                            maxLength={65536}
                            spellCheck={false}
                            className="font-mono text-xs"
                        />
                        <div>
                            <Button type="submit" size="sm" aria-disabled={!code.trim() || pending} disabled={pending} aria-busy={pending}>
                                {t("hosts.import")}
                            </Button>
                        </div>
                    </form>
                </section>
            </CardBody>
            <QrScanDialog
                open={scanning}
                onOpenChange={setScanning}
                onFound={(value) => {
                    setScanning(false);
                    void take(value);
                }}
            />
        </Card>
    );
}
