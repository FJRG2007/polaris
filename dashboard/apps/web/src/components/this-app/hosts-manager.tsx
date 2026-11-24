"use client";

/**
 * Settings > This app > Hosts, in a desktop app that manages its hosts from here
 * (`appSettings.hosts`): the list with how each host answers, switching, editing,
 * removing, adding, and sending the list to or taking one from another device.
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
import { QrScanDialog } from "@/app/(app)/vault/qr-scan";
import { useCallback, useEffect, useRef, useState, type FormEvent } from "react";
import { useTranslations } from "@/components/i18n/i18n-provider";
import { Badge, Button, Card, CardBody, ConfirmDeleteDialog, Input, Textarea, useToast } from "@polaris/ui";
import * as bridge from "@/lib/desktop-bridge";

/** The longest name the app keeps for a host (`SERVER_NAME_MAX` in the desktop app). */
export const HOST_NAME_MAX = 40;

/** How long typing pauses before the app is asked about an address. */
const CHECK_DELAY_MS = 400;

const STORE_KEY = "polaris.this-app.hosts";

/** The list the app gave this session, so the page opened again draws it unchanged. */
let sessionHosts: bridge.DesktopHostsSnapshot | null = null;

/** How each host answered this session, by origin, so a revisit shows the dots it had. */
const sessionStatus = new Map<string, bridge.DesktopHostStatus>();

/** Only for tests: forget the session's list and statuses. */
export function forgetHostsSnapshot(): void {
    sessionHosts = null;
    sessionStatus.clear();
}

function keptHosts(): bridge.DesktopHostsSnapshot | null {
    if (sessionHosts) return sessionHosts;
    try {
        const raw = window.localStorage.getItem(STORE_KEY);
        return raw ? bridge.readDesktopHosts(JSON.parse(raw)) : null;
    } catch {
        return null;
    }
}

function keepHosts(next: bridge.DesktopHostsSnapshot): void {
    sessionHosts = next;
    try {
        window.localStorage.setItem(STORE_KEY, JSON.stringify(next));
    } catch {
        // A private window or a full store: the session's copy still holds.
    }
}

/** The address as the app is asked about it: surrounding space dropped. */
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

export function HostsManager({ hosts }: { hosts: bridge.DesktopHosts }) {
    const t = useTranslations("appSettings");
    const toast = useToast();
    const [snapshot, setSnapshot] = useState<bridge.DesktopHostsSnapshot | null>(() => keptHosts());
    const [unavailable, setUnavailable] = useState(false);
    const [status, setStatus] = useState<ReadonlyMap<string, bridge.DesktopHostStatus>>(() => new Map(sessionStatus));
    const [editing, setEditing] = useState<string | null>(null);
    const [removing, setRemoving] = useState<bridge.DesktopHostRow | null>(null);
    const [busy, setBusy] = useState<string | null>(null);

    const keep = useCallback((next: bridge.DesktopHostsSnapshot) => {
        keepHosts(next);
        setSnapshot(next);
    }, []);

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

    const refresh = useCallback(async () => {
        const next = bridge.readDesktopHosts(await hosts.list().catch(() => null));
        if (!next) {
            if (!sessionHosts) setUnavailable(true);
            return;
        }
        setUnavailable(false);
        keep(next);
        askStatus(next.servers);
    }, [hosts, keep, askStatus]);

    useEffect(() => {
        void refresh();
        const visible = () => {
            if (document.visibilityState === "visible") void refresh();
        };
        const focused = () => void refresh();
        window.addEventListener("focus", focused);
        document.addEventListener("visibilitychange", visible);
        return () => {
            window.removeEventListener("focus", focused);
            document.removeEventListener("visibilitychange", visible);
        };
    }, [refresh]);

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
        const before = sessionHosts;
        // Shown gone at once; put back when the app refuses.
        if (before) keep({ ...before, servers: before.servers.filter((one) => one.origin !== row.origin) });
        const outcome = bridge.readDesktopOutcome(await hosts.remove(row.origin).catch(() => null));
        if (outcome.ok) return void refresh();
        if (before) keep(before);
        refused(outcome.error);
    };

    const servers = snapshot?.servers ?? [];

    return (
        <div className="flex flex-col gap-4">
            <Card>
                <CardBody className="flex flex-col gap-3">
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
                        <ul className="flex flex-col divide-y divide-border">
                            {servers.map((row) =>
                                editing === row.origin ? (
                                    <li key={row.origin} className="py-3 first:pt-0 last:pb-0">
                                        <HostEdit
                                            hosts={hosts}
                                            row={row}
                                            onDone={(changed) => {
                                                setEditing(null);
                                                if (changed) void refresh();
                                            }}
                                        />
                                    </li>
                                ) : (
                                    <HostItem
                                        key={row.origin}
                                        row={row}
                                        status={status.get(row.origin) ?? null}
                                        busy={busy === row.origin}
                                        onSwitch={() => void switchTo(row)}
                                        onEdit={() => setEditing(row.origin)}
                                        onRemove={() => setRemoving(row)}
                                    />
                                )
                            )}
                        </ul>
                    )}
                </CardBody>
            </Card>
            <HostAdd hosts={hosts} onAdded={() => void refresh()} />
            <HostTransfer hosts={hosts} count={servers.length} onImported={() => void refresh()} />
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

function HostItem({
    row,
    status,
    busy,
    onSwitch,
    onEdit,
    onRemove
}: {
    row: bridge.DesktopHostRow;
    status: bridge.DesktopHostStatus | null;
    busy: boolean;
    onSwitch: () => void;
    onEdit: () => void;
    onRemove: () => void;
}) {
    const t = useTranslations("appSettings");
    const shown = status ?? "checking";
    const label = t(`hosts.status.${shown}`);
    return (
        <li className="flex flex-wrap items-center justify-between gap-3 py-3 first:pt-0 last:pb-0">
            <div className="flex min-w-0 flex-1 items-center gap-2.5">
                <span className={`size-2 shrink-0 rounded-full ${STATUS_DOT[shown]}`} title={label} aria-hidden />
                <span className="sr-only">{label}</span>
                <div className="flex min-w-0 flex-col">
                    <span className="flex min-w-0 items-center gap-2">
                        <span className="truncate text-sm" title={shownName(row)}>
                            {shownName(row)}
                        </span>
                        {row.active && <Badge variant="success">{t("hosts.current")}</Badge>}
                    </span>
                    <span className="truncate text-xs text-muted-foreground" title={row.origin}>
                        {row.origin}
                    </span>
                </div>
            </div>
            <div className="flex shrink-0 items-center gap-2">
                {!row.active && (
                    <Button size="sm" variant="secondary" onClick={onSwitch} disabled={busy} aria-busy={busy}>
                        {t("hosts.switch")}
                    </Button>
                )}
                <Button size="sm" variant="ghost" onClick={onEdit} aria-label={t("hosts.editNamed", { name: shownName(row) })}>
                    {t("hosts.edit")}
                </Button>
                <Button size="sm" variant="ghost" onClick={onRemove} aria-label={t("hosts.removeNamed", { name: shownName(row) })}>
                    {t("hosts.remove")}
                </Button>
            </div>
        </li>
    );
}

/** The address and name fields both forms share, with the name's own limit. */
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
        <div className="grid gap-3 sm:grid-cols-2">
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

function HostAdd({ hosts, onAdded }: { hosts: bridge.DesktopHosts; onAdded: () => void }) {
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
        <Card>
            <CardBody>
                <form className="flex flex-col gap-3" onSubmit={(event) => void add(event)}>
                    <h3 className="text-sm font-medium">{t("hosts.addTitle")}</h3>
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
                    <div>
                        <Button type="submit" size="sm" aria-disabled={!ready} disabled={pending} aria-busy={pending}>
                            {t("hosts.add")}
                        </Button>
                    </div>
                </form>
            </CardBody>
        </Card>
    );
}

function HostEdit({ hosts, row, onDone }: { hosts: bridge.DesktopHosts; row: bridge.DesktopHostRow; onDone: (changed: boolean) => void }) {
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
        <form
            className="flex flex-col gap-3"
            onSubmit={(event) => void save(event)}
            onKeyDown={(event) => event.key === "Escape" && onDone(false)}
        >
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
            <div className="flex flex-wrap gap-2">
                <Button type="submit" size="sm" aria-disabled={!ready} disabled={pending} aria-busy={pending}>
                    {t("hosts.save")}
                </Button>
                <Button type="button" size="sm" variant="ghost" onClick={() => onDone(false)}>
                    {t("hosts.cancel")}
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
