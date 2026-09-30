/**
 * The Polaris servers this browser knows: which one is in front, and the way to
 * another.
 *
 * Until this, the address typed on the first run was the only one there was,
 * and nothing on screen showed it or offered to change it. Now every server is a
 * row: pressing one puts it in front, and the pencil and the bin rename and
 * remove it. What a switch does is the worker's (`bringServer`) - the account on
 * that server that was set aside last comes back, or its "connect this browser"
 * when nobody is signed in there yet - so each server keeps its own session.
 *
 * Asking the browser for an address is done here, from the press, and nowhere
 * else: a permission request that does not come from a user gesture is refused,
 * and the worker has none. On Chromium every page is already granted, so the
 * request answers at once without a prompt; Firefox asks.
 */

import { useWords } from "./words";
import { BinMark, PencilMark } from "./marks";
import { useEffect, useRef, useState } from "react";
import { looksLikeAddress, readOrigin } from "@/lib/address";
import { askBackground, type Request, type VaultStatus } from "@/lib/messages";
import {
    describeServer,
    normalizeServerName,
    serverNameProblem,
    SERVER_NAME_MAX,
    type ServerRef
} from "@/lib/servers";

/** Ask the browser for one address, from the press that wants it. */
async function grant(origin: string): Promise<boolean> {
    try {
        return await browser.permissions.request({ origins: [`${origin}/*`] });
    } catch {
        return false;
    }
}

export function ServersPanel({
    status,
    onChange
}: {
    status: VaultStatus;
    onChange: () => Promise<void>;
}): React.JSX.Element {
    const t = useWords();
    const [busy, setBusy] = useState(false);
    const [refused, setRefused] = useState<string | null>(null);
    const [renaming, setRenaming] = useState<string | null>(null);
    const [removing, setRemoving] = useState<ServerRef | null>(null);
    // A rename shows at once and is undone if the worker refuses it.
    const [named, setNamed] = useState<Record<string, string | null>>({});

    const shown = status.servers.map((one) =>
        one.origin in named ? { ...one, name: named[one.origin] ?? null } : one
    );

    const act = async (request: Request): Promise<boolean> => {
        setBusy(true);
        setRefused(null);
        const reply = await askBackground(request);
        setBusy(false);
        if (!reply.ok) {
            setRefused(reply.error);
            return false;
        }
        await onChange();
        return true;
    };

    const switchTo = async (server: ServerRef): Promise<void> => {
        if (server.active || busy) return;
        // First, before anything else is awaited: the press is what lets it ask.
        if (!(await grant(server.origin))) {
            setRefused(t("errors.noPermission"));
            return;
        }
        await act({ kind: "switchServer", origin: server.origin });
    };

    const rename = async (server: ServerRef, typed: string): Promise<void> => {
        const name = normalizeServerName(typed);
        setRenaming(null);
        setNamed((was) => ({ ...was, [server.origin]: name }));
        const done = await act({ kind: "renameServer", origin: server.origin, name: name ?? "" });
        setNamed((was) => {
            const next = { ...was };
            delete next[server.origin];
            return next;
        });
        if (!done) setRenaming(server.origin);
    };

    return (
        <>
            <ul className="servers" aria-label={t("servers.listLabel")}>
                {shown.map((server) => (
                    <li key={server.origin} className="server-row">
                        {renaming === server.origin ? (
                            <RenameForm
                                server={server}
                                onSave={(typed) => void rename(server, typed)}
                                onCancel={() => setRenaming(null)}
                            />
                        ) : (
                            <>
                                <button
                                    className="server"
                                    disabled={busy && !server.active}
                                    aria-current={server.active ? "true" : undefined}
                                    title={server.active ? server.origin : t("shell.switchTo", { name: describeServer(server) })}
                                    onClick={() => void switchTo(server)}
                                >
                                    <span className="server-text">
                                        <span className="shown strong">{describeServer(server)}</span>
                                        <span className="muted small server-where">
                                            {server.name ? (
                                                <span className="server-host" title={server.origin}>
                                                    {server.host}
                                                </span>
                                            ) : null}
                                            <span>{t("servers.accounts", { count: server.accounts })}</span>
                                        </span>
                                    </span>
                                    {server.active ? <span className="badge">{t("servers.inUse")}</span> : null}
                                </button>
                                <div className="acts">
                                    <button
                                        className="icon"
                                        disabled={busy}
                                        aria-label={t("servers.renameLabel", { name: describeServer(server) })}
                                        title={t("servers.rename")}
                                        onClick={() => setRenaming(server.origin)}
                                    >
                                        <PencilMark />
                                    </button>
                                    <button
                                        className="icon"
                                        disabled={busy}
                                        aria-label={t("servers.removeLabel", { name: describeServer(server) })}
                                        title={t("servers.remove")}
                                        onClick={() => setRemoving(server)}
                                    >
                                        <BinMark />
                                    </button>
                                </div>
                            </>
                        )}
                    </li>
                ))}
            </ul>
            {refused ? <p className="problem">{refused}</p> : null}
            <AddServer
                known={status.servers}
                busy={busy}
                onAdd={async (typed) => act({ kind: "addServer", typed })}
                onRefused={setRefused}
            />
            {removing ? (
                <ConfirmRemove
                    server={removing}
                    onCancel={() => setRemoving(null)}
                    onConfirm={async () => {
                        const server = removing;
                        setRemoving(null);
                        await act({ kind: "removeServer", origin: server.origin });
                    }}
                />
            ) : null}
        </>
    );
}

/** Renaming one row in place. Empty gives the row its host back. */
function RenameForm({
    server,
    onSave,
    onCancel
}: {
    server: ServerRef;
    onSave: (typed: string) => void;
    onCancel: () => void;
}): React.JSX.Element {
    const t = useWords();
    const [typed, setTyped] = useState(server.name ?? "");
    const name = normalizeServerName(typed);
    const problem = serverNameProblem(name);
    const unchanged = name === server.name;
    const blocked = unchanged || problem !== null;

    const save = (): void => {
        if (!blocked) onSave(typed);
    };

    return (
        <div className="rename">
            <input
                autoFocus
                value={typed}
                placeholder={server.host}
                aria-label={t("servers.nameLabel", { host: server.host })}
                aria-invalid={problem !== null}
                autoCapitalize="words"
                spellCheck={false}
                onChange={(event) => setTyped(event.target.value)}
                onKeyDown={(event) => {
                    if (event.key === "Enter") save();
                    if (event.key === "Escape") {
                        event.stopPropagation();
                        onCancel();
                    }
                }}
            />
            {problem ? (
                <p className="problem inline">{t("errors.serverNameTooLong", { max: SERVER_NAME_MAX })}</p>
            ) : null}
            <div className="rename-acts">
                <button className="ghost" onClick={onCancel}>
                    {t("popup.cancel")}
                </button>
                <button
                    aria-disabled={blocked}
                    title={unchanged ? t("servers.unchanged") : undefined}
                    onClick={save}
                >
                    {t("servers.save")}
                </button>
            </div>
        </div>
    );
}

/** Adding another server: its address, then the same permission the first one
 *  needed, asked for from the press. */
function AddServer({
    known,
    busy,
    onAdd,
    onRefused
}: {
    known: readonly ServerRef[];
    busy: boolean;
    onAdd: (typed: string) => Promise<boolean>;
    onRefused: (error: string | null) => void;
}): React.JSX.Element {
    const t = useWords();
    const [open, setOpen] = useState(false);
    const [typed, setTyped] = useState("");
    const origin = readOrigin(typed);
    const already = origin !== null && known.some((one) => one.origin === origin);
    const usable = looksLikeAddress(typed) && !already && !busy;

    const add = async (): Promise<void> => {
        if (!usable || !origin) return;
        onRefused(null);
        if (!(await grant(origin))) {
            onRefused(t("errors.noPermission"));
            return;
        }
        if (await onAdd(typed)) {
            setTyped("");
            setOpen(false);
        }
    };

    if (!open) {
        return (
            <div className="row">
                <button className="ghost" onClick={() => setOpen(true)}>
                    {t("servers.add")}
                </button>
            </div>
        );
    }
    return (
        <div className="row add-server">
            <p className="muted small">{t("popup.connect.hint")}</p>
            <input
                autoFocus
                value={typed}
                // i18n-ignore an example address, the same in every language
                placeholder="polaris.example.com"
                inputMode="url"
                autoCapitalize="none"
                autoCorrect="off"
                spellCheck={false}
                aria-invalid={already}
                onChange={(event) => setTyped(event.target.value)}
                onKeyDown={(event) => {
                    if (event.key === "Enter") void add();
                    if (event.key === "Escape") setOpen(false);
                }}
            />
            {already ? <p className="problem inline">{t("servers.already")}</p> : null}
            <div className="rename-acts">
                <button className="ghost" onClick={() => setOpen(false)}>
                    {t("popup.cancel")}
                </button>
                <button aria-disabled={!usable} onClick={() => void add()}>
                    {t("servers.addButton")}
                </button>
            </div>
            <p className="muted small">{t("popup.connect.permission")}</p>
        </div>
    );
}

/**
 * The question before a server is removed, in the popup's own design.
 *
 * Named, with what it costs: removing a server signs out of every account on it
 * here and ends their connections. Cancel has the focus, Escape and a press
 * outside close it, and focus goes back to the bin that opened it.
 */
function ConfirmRemove({
    server,
    onCancel,
    onConfirm
}: {
    server: ServerRef;
    onCancel: () => void;
    onConfirm: () => Promise<void>;
}): React.JSX.Element {
    const t = useWords();
    const box = useRef<HTMLDivElement | null>(null);
    const cancel = useRef<HTMLButtonElement | null>(null);

    useEffect(() => {
        const opener = document.activeElement as HTMLElement | null;
        cancel.current?.focus();
        return () => opener?.focus();
    }, []);

    const keep = (event: React.KeyboardEvent): void => {
        if (event.key === "Escape") {
            event.stopPropagation();
            onCancel();
            return;
        }
        if (event.key !== "Tab") return;
        const buttons = box.current?.querySelectorAll("button");
        if (!buttons || buttons.length === 0) return;
        const first = buttons[0]!;
        const last = buttons[buttons.length - 1]!;
        if (event.shiftKey && document.activeElement === first) {
            event.preventDefault();
            last.focus();
        } else if (!event.shiftKey && document.activeElement === last) {
            event.preventDefault();
            first.focus();
        }
    };

    const name = describeServer(server);
    return (
        <div className="dialog-backdrop" onMouseDown={(event) => event.target === event.currentTarget && onCancel()}>
            <div
                ref={box}
                className="dialog"
                role="alertdialog"
                aria-modal="true"
                aria-labelledby="remove-server-title"
                aria-describedby="remove-server-body"
                onKeyDown={keep}
            >
                <p id="remove-server-title" className="strong">
                    {t("servers.removeTitle", { name })}
                </p>
                <p id="remove-server-body" className="muted small">
                    {server.accounts > 0
                        ? t("servers.removeSignsOut", { count: server.accounts })
                        : t("servers.removeOnlyList")}
                </p>
                <div className="rename-acts">
                    <button ref={cancel} className="ghost" onClick={onCancel}>
                        {t("popup.cancel")}
                    </button>
                    <button className="danger" onClick={() => void onConfirm()}>
                        {t("servers.removeLabel", { name })}
                    </button>
                </div>
            </div>
        </div>
    );
}

/**
 * The servers, folded under one line, for the screens before an account is in
 * front - where somebody who has just added a server needs the way back to the
 * one they came from.
 */
export function ServersFold({
    status,
    onChange
}: {
    status: VaultStatus;
    onChange: () => Promise<void>;
}): React.JSX.Element | null {
    const t = useWords();
    const [open, setOpen] = useState(false);
    if (status.servers.length === 0) return null;
    return (
        <div className="fold">
            <div className="row">
                <span className="muted small">{t("servers.count", { count: status.servers.length })}</span>
                <div className="acts">
                    <button className="ghost" aria-expanded={open} onClick={() => setOpen(!open)}>
                        {open ? t("generator.hide") : t("shell.servers")}
                    </button>
                </div>
            </div>
            {open ? <ServersPanel status={status} onChange={onChange} /> : null}
        </div>
    );
}
