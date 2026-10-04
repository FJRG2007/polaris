/**
 * The frame around everything once this browser is connected to an account.
 *
 * The same shape as the dashboard's header, because it is the same person on the
 * same Polaris: a greeting on the left with the switch between their own shelf
 * and their organizations', and their face on the right, which is where the
 * account's own actions live. No email anywhere - the name and the face are what
 * say whose extension this is, as they do in Polaris.
 *
 * Under it is either the home screen, which lists what the extension can do, or
 * one of those sections. The vault is the first section rather than the whole
 * extension, and it has a way back out.
 */

import { grant } from "./servers";
import { useWords } from "./words";
import { describeAccount, accountHost } from "@/lib/accounts";
import { useEffect, useRef, useState, type ReactNode } from "react";
import { firstName, initials, initialsInk, tintFor } from "@polaris/core/faces";
import { describeServer, type ServerRef } from "@/lib/servers";
import { ENGLISH, type Words } from "@/lib/words";
import { askBackground, type Request, type VaultStatus } from "@/lib/messages";

/**
 * The sections the popup can show. `servers` is the hosts screen, opened from
 * the account menu rather than listed on the home screen - it is where this
 * extension points, not something it does. The value keeps its old spelling so
 * a popup that was closed on that screen opens on it again.
 */
export type Section = "home" | "vault" | "servers";

const SECTION_KEY = "polaris.section";

/**
 * Which section is open, remembered for the next time the popup opens.
 *
 * Somebody who went into the vault and closed the popup to paste a password
 * expects to come back to the vault, not to the home screen. Kept in this popup's
 * own storage and read defensively: a browser that refuses it lands on home.
 */
export function useSection(): [Section, (next: Section) => void] {
    const [section, setSection] = useState<Section>(() => {
        try {
            const held = window.localStorage.getItem(SECTION_KEY);
            return held === "vault" || held === "servers" ? held : "home";
        } catch {
            return "home";
        }
    });
    const choose = (next: Section): void => {
        setSection(next);
        try {
            window.localStorage.setItem(SECTION_KEY, next);
        } catch {
            // Remembering is a convenience; the section still opens.
        }
    };
    return [section, choose];
}

/** A face: the picture when there is one, the initials in the person's colour
 *  when there is not - the same colour the dashboard draws them in. */
export function Face({
    image,
    name,
    tint,
    size,
    square
}: {
    image: string | null;
    name: string;
    tint: string;
    size: number;
    square?: boolean;
}): React.JSX.Element {
    const [broken, setBroken] = useState(false);
    const style = { width: size, height: size, fontSize: Math.round(size * 0.4) };
    if (image && !broken) {
        return (
            <img
                className={square ? "face square" : "face"}
                src={image}
                alt=""
                style={style}
                onError={() => setBroken(true)}
            />
        );
    }
    const fill = tintFor(tint);
    return (
        <span
            className={square ? "face square" : "face"}
            style={{ ...style, background: fill, color: initialsInk(fill) }}
            aria-hidden="true"
        >
            {initials(name)}
        </span>
    );
}

/**
 * A menu that opens under its button and closes on a press outside it or Escape.
 *
 * Its own small thing rather than a library: the popup is 360 pixels and draws a
 * handful of controls, and this is the one behaviour it needs.
 */
function Menu({
    open,
    onClose,
    align,
    children
}: {
    open: boolean;
    onClose: () => void;
    align: "start" | "end";
    children: ReactNode;
}): React.JSX.Element | null {
    const box = useRef<HTMLDivElement | null>(null);
    useEffect(() => {
        if (!open) return;
        const away = (event: MouseEvent): void => {
            const parent = box.current?.parentElement;
            if (parent && !parent.contains(event.target as Node)) onClose();
        };
        const escape = (event: KeyboardEvent): void => {
            if (event.key === "Escape") onClose();
        };
        document.addEventListener("mousedown", away);
        document.addEventListener("keydown", escape);
        return () => {
            document.removeEventListener("mousedown", away);
            document.removeEventListener("keydown", escape);
        };
    }, [open, onClose]);
    if (!open) return null;
    return (
        <div ref={box} className={`menu ${align}`} role="menu">
            {children}
        </div>
    );
}

function Check(): React.JSX.Element {
    return (
        <svg className="menu-check" viewBox="0 0 24 24" aria-hidden="true">
            <path d="M20 6 9 17l-5-5" />
        </svg>
    );
}

/**
 * Which shelf is open: the account's own, or one organization's.
 *
 * Drawn only for an account that belongs to an organization, as the dashboard's
 * switch is - a switch with one position teaches nothing. What it changes is
 * what the vault lists, exactly as the shelf does on the dashboard's vault.
 */
function ShelfPicker({
    status,
    onChange
}: {
    status: VaultStatus;
    onChange: () => Promise<void>;
}): React.JSX.Element | null {
    const t = useWords();
    const [open, setOpen] = useState(false);
    const [refused, setRefused] = useState<string | null>(null);
    if (status.organizations.length === 0) return null;

    const own = status.linkedAccount?.name ?? t("shell.yourAccount");
    const current = status.organizations.find((org) => org.id === status.shelf) ?? null;
    const ownTint = status.linkedAccount?.id ?? own;

    const choose = async (orgId: string | null): Promise<void> => {
        setOpen(false);
        const reply = await askBackground({ kind: "setShelf", orgId });
        setRefused(reply.ok ? null : reply.error);
        await onChange();
    };

    return (
        <div className="anchor">
            <button
                className="shelf"
                aria-haspopup="menu"
                aria-expanded={open}
                aria-label={t("shell.workingInLabel", { name: current?.name ?? own })}
                onClick={() => setOpen(!open)}
            >
                {current ? (
                    <Face
                        image={current.face}
                        name={current.name}
                        tint={current.id}
                        size={16}
                        square
                    />
                ) : (
                    <Face image={status.face} name={own} tint={ownTint} size={16} />
                )}
                <span className="shelf-name">{current?.name ?? own}</span>
                <svg className="chevron" viewBox="0 0 24 24" aria-hidden="true">
                    <path d="m7 15 5 5 5-5M7 9l5-5 5 5" />
                </svg>
            </button>
            <Menu open={open} onClose={() => setOpen(false)} align="start">
                <p className="menu-label">{t("shell.workingIn")}</p>
                <button className="menu-item" role="menuitem" onClick={() => void choose(null)}>
                    <Face image={status.face} name={own} tint={ownTint} size={18} />
                    <span className="menu-text">{own}</span>
                    {current === null ? <Check /> : null}
                </button>
                <hr />
                {status.organizations.map((org) => (
                    <button
                        key={org.id}
                        className="menu-item"
                        role="menuitem"
                        onClick={() => void choose(org.id)}
                    >
                        <Face image={org.face} name={org.name} tint={org.id} size={18} square />
                        <span className="menu-text">{org.name}</span>
                        {current?.id === org.id ? <Check /> : null}
                    </button>
                ))}
            </Menu>
            {refused ? <p className="problem">{refused}</p> : null}
        </div>
    );
}

/** What a host's row says on hover: its whole name, and where it points. */
function hostTitle(t: Words, server: ServerRef): string {
    return server.name
        ? t("shell.hostTitle", { name: server.name, host: server.host })
        : server.origin;
}

/**
 * The Polaris hosts in the account menu: the one in front ticked, any other a
 * press away, and the screen that adds, renames and removes them under it.
 *
 * Each row is the host's name or its address, cut to the menu's width with the
 * whole of it in the tooltip.
 */
export function HostEntries({
    hosts,
    onSwitch,
    onManage
}: {
    hosts: readonly ServerRef[];
    onSwitch: (server: ServerRef) => void;
    onManage: () => void;
}): React.JSX.Element {
    const t = useWords();
    return (
        <>
            <p className="menu-label">{t("shell.host")}</p>
            {hosts.map((server) => (
                <button
                    key={server.origin}
                    className="menu-item"
                    role="menuitemradio"
                    aria-checked={server.active}
                    title={hostTitle(t, server)}
                    onClick={() => onSwitch(server)}
                >
                    <span className="menu-text">{describeServer(server)}</span>
                    {server.active ? <Check /> : null}
                </button>
            ))}
            <button className="menu-item" role="menuitem" onClick={onManage}>
                <span className="menu-text">{t("shell.manageHosts")}</span>
            </button>
        </>
    );
}

/**
 * The account's face, and what the account can do from it.
 *
 * Where the dashboard keeps them: switching to another account signed in here,
 * adding one, opening Polaris, which Polaris this browser is pointed at, and
 * ending this browser's connection - the same act as Disconnect on the
 * account's Sessions screen.
 */
function AccountMenu({
    status,
    onChange,
    onOpen
}: {
    status: VaultStatus;
    onChange: () => Promise<void>;
    onOpen: (section: Section) => void;
}): React.JSX.Element {
    const t = useWords();
    const [open, setOpen] = useState(false);
    const [refused, setRefused] = useState<string | null>(null);
    const name = status.linkedAccount?.name ?? t("shell.yourAccount");
    const tint = status.linkedAccount?.id ?? name;
    const others = status.accounts.filter((one) => one.id !== status.activeId);

    const act = async (request: Request): Promise<void> => {
        setOpen(false);
        const reply = await askBackground(request);
        setRefused(reply.ok ? null : reply.error);
        await onChange();
    };

    const switchHost = async (server: ServerRef): Promise<void> => {
        setOpen(false);
        if (server.active) return;
        // Asked before anything else is awaited: the press is what lets it ask.
        if (!(await grant(server.origin))) {
            setRefused(t("errors.noPermission"));
            return;
        }
        await act({ kind: "switchServer", origin: server.origin });
    };
    const active = status.servers.find((one) => one.active) ?? null;

    return (
        <div className="anchor">
            <button
                className="avatar-button"
                aria-haspopup="menu"
                aria-expanded={open}
                aria-label={t("shell.accountMenu", { name })}
                title={name}
                onClick={() => setOpen(!open)}
            >
                <Face image={status.face} name={name} tint={tint} size={30} />
            </button>
            <Menu open={open} onClose={() => setOpen(false)} align="end">
                <div className="menu-head">
                    <Face image={status.face} name={name} tint={tint} size={32} />
                    <div className="menu-who">
                        <span className="menu-text strong">{name}</span>
                        {status.server ? (
                            <span
                                className="menu-text muted small"
                                title={active ? hostTitle(t, active) : status.server}
                            >
                                {active ? describeServer(active) : accountHost(status.server)}
                            </span>
                        ) : null}
                    </div>
                </div>
                <hr />
                {status.server ? (
                    <button
                        className="menu-item"
                        role="menuitem"
                        onClick={() => {
                            void browser.tabs.create({ url: status.server as string });
                            window.close();
                        }}
                    >
                        <span className="menu-text">{t("shell.openPolaris")}</span>
                    </button>
                ) : null}
                <hr />
                <HostEntries
                    hosts={status.servers}
                    onSwitch={(server) => void switchHost(server)}
                    onManage={() => {
                        setOpen(false);
                        onOpen("servers");
                    }}
                />
                {others.length > 0 || status.activeId ? <hr /> : null}
                {others.map((one) => (
                    <button
                        key={one.id}
                        className="menu-item"
                        role="menuitem"
                        onClick={() => void act({ kind: "switchAccount", id: one.id })}
                    >
                        <span className="menu-text">
                            {t("shell.switchTo", { name: describeAccount(one) })}
                        </span>
                        <span className="muted small">{accountHost(one.origin)}</span>
                    </button>
                ))}
                {status.activeId ? (
                    <button
                        className="menu-item"
                        role="menuitem"
                        onClick={() => void act({ kind: "addAccount" })}
                    >
                        <span className="menu-text">{t("shell.addAccount")}</span>
                    </button>
                ) : null}
                <hr />
                <button
                    className="menu-item danger"
                    role="menuitem"
                    onClick={() => void act({ kind: "unlink" })}
                >
                    <span className="menu-text">{t("shell.disconnect")}</span>
                </button>
            </Menu>
            {refused ? <p className="problem">{refused}</p> : null}
        </div>
    );
}

/** The greeting, the shelf and the face, as the dashboard's header has them. */
export function TopBar({
    status,
    onChange,
    onOpen
}: {
    status: VaultStatus;
    onChange: () => Promise<void>;
    onOpen: (section: Section) => void;
}): React.JSX.Element {
    const t = useWords();
    const name = status.linkedAccount?.name ? firstName(status.linkedAccount.name) : "";
    return (
        <div className="topbar">
            <div className="topbar-left">
                <p className="hello">{greeting(t, new Date(), name)}</p>
                <ShelfPicker status={status} onChange={onChange} />
            </div>
            <AccountMenu status={status} onChange={onChange} onOpen={onOpen} />
        </div>
    );
}

/** The greeting for the hour, as core's `greetingFor` draws the line, with the
 *  name when there is one. */
export function greeting(t: Words, date: Date, name: string): string {
    const hour = date.getHours();
    const part = hour < 6 ? "night" : hour < 12 ? "morning" : hour < 19 ? "afternoon" : "evening";
    return t("shell.greeting", { part, hasName: name ? "yes" : "no", name });
}

/** What the vault is doing, in the words the home screen says it in. */
export function vaultState(status: VaultStatus, t: Words = ENGLISH): string {
    if (!status.canVault) return t("shell.noVault");
    if (!status.connected || !status.polarisSession) return t("shell.notConnected");
    if (!status.unlocked) return t("shell.locked");
    return t("shell.open");
}

/** The home screen: what this extension can do, one row per section. */
export function Home({
    status,
    onOpen
}: {
    status: VaultStatus;
    onOpen: (section: Section) => void;
}): React.JSX.Element {
    const t = useWords();
    return (
        <main>
            <h2>{t("shell.apps")}</h2>
            <ul>
                <li className="section-row">
                    <button className="section" onClick={() => onOpen("vault")}>
                        <span className="section-mark" aria-hidden="true">
                            <svg viewBox="0 0 24 24">
                                <rect x="3" y="11" width="18" height="11" rx="2" />
                                <path d="M7 11V7a5 5 0 0 1 10 0v4" />
                            </svg>
                        </span>
                        <span className="section-text">
                            <span className="strong">{t("shell.vault")}</span>
                            <span className="muted small">{vaultState(status, t)}</span>
                        </span>
                        <svg className="chevron-right" viewBox="0 0 24 24" aria-hidden="true">
                            <path d="m9 18 6-6-6-6" />
                        </svg>
                    </button>
                </li>
            </ul>
        </main>
    );
}

/** The line above a section, with the way back to the home screen. */
export function SectionBar({
    title,
    onBack
}: {
    title: string;
    onBack: () => void;
}): React.JSX.Element {
    const t = useWords();
    return (
        <div className="section-bar">
            <button
                className="back"
                aria-label={t("shell.backLabel")}
                title={t("shell.back")}
                onClick={onBack}
            >
                <svg viewBox="0 0 24 24" aria-hidden="true">
                    <path d="m15 18-6-6 6-6" />
                </svg>
            </button>
            <span className="strong">{title}</span>
        </div>
    );
}
