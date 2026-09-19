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

import { describeAccount, accountHost } from "@/lib/accounts";
import { useEffect, useRef, useState, type ReactNode } from "react";
import { firstName, greetingFor, initials, tintFor } from "@polaris/core/faces";
import { askBackground, type Request, type VaultStatus } from "@/lib/messages";

/** The sections the home screen offers. */
export type Section = "home" | "vault";

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
            return window.localStorage.getItem(SECTION_KEY) === "vault" ? "vault" : "home";
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
    return (
        <span
            className={square ? "face square" : "face"}
            style={{ ...style, background: tintFor(tint) }}
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
    const [open, setOpen] = useState(false);
    const [refused, setRefused] = useState<string | null>(null);
    if (status.organizations.length === 0) return null;

    const own = status.linkedAccount?.name ?? "Your account";
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
                aria-label={`Working in ${current?.name ?? own}`}
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
                <p className="menu-label">Working in</p>
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

/**
 * The account's face, and what the account can do from it.
 *
 * Where the dashboard keeps them: switching to another account signed in here,
 * adding one, opening Polaris, and ending this browser's connection - the same
 * act as Disconnect on the account's Sessions screen.
 */
function AccountMenu({
    status,
    onChange
}: {
    status: VaultStatus;
    onChange: () => Promise<void>;
}): React.JSX.Element {
    const [open, setOpen] = useState(false);
    const [refused, setRefused] = useState<string | null>(null);
    const name = status.linkedAccount?.name ?? "Your account";
    const tint = status.linkedAccount?.id ?? name;
    const others = status.accounts.filter((one) => one.id !== status.activeId);

    const act = async (request: Request): Promise<void> => {
        setOpen(false);
        const reply = await askBackground(request);
        setRefused(reply.ok ? null : reply.error);
        await onChange();
    };

    return (
        <div className="anchor">
            <button
                className="avatar-button"
                aria-haspopup="menu"
                aria-expanded={open}
                aria-label={`${name}, account menu`}
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
                            <span className="muted small">{accountHost(status.server)}</span>
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
                        <span className="menu-text">Open Polaris</span>
                    </button>
                ) : null}
                {others.map((one) => (
                    <button
                        key={one.id}
                        className="menu-item"
                        role="menuitem"
                        onClick={() => void act({ kind: "switchAccount", id: one.id })}
                    >
                        <span className="menu-text">Switch to {describeAccount(one)}</span>
                        <span className="muted small">{accountHost(one.origin)}</span>
                    </button>
                ))}
                {status.activeId ? (
                    <button
                        className="menu-item"
                        role="menuitem"
                        onClick={() => void act({ kind: "addAccount" })}
                    >
                        <span className="menu-text">Add another account</span>
                    </button>
                ) : null}
                <hr />
                <button
                    className="menu-item danger"
                    role="menuitem"
                    onClick={() => void act({ kind: "unlink" })}
                >
                    <span className="menu-text">Disconnect this browser</span>
                </button>
            </Menu>
            {refused ? <p className="problem">{refused}</p> : null}
        </div>
    );
}

/** The greeting, the shelf and the face, as the dashboard's header has them. */
export function TopBar({
    status,
    onChange
}: {
    status: VaultStatus;
    onChange: () => Promise<void>;
}): React.JSX.Element {
    const name = status.linkedAccount?.name ? firstName(status.linkedAccount.name) : "";
    const hello = greetingFor(new Date());
    return (
        <div className="topbar">
            <div className="topbar-left">
                <p className="hello">{name ? `${hello}, ${name}` : hello}</p>
                <ShelfPicker status={status} onChange={onChange} />
            </div>
            <AccountMenu status={status} onChange={onChange} />
        </div>
    );
}

/** What the vault is doing, in the words the home screen says it in. */
export function vaultState(status: VaultStatus): string {
    if (!status.canVault) return "This account has no vault";
    if (!status.connected || !status.polarisSession) return "Not connected yet";
    if (!status.unlocked) return "Locked";
    return "Open";
}

/** The home screen: what this extension can do, one row per section. */
export function Home({
    status,
    onOpen
}: {
    status: VaultStatus;
    onOpen: (section: Section) => void;
}): React.JSX.Element {
    return (
        <main>
            <h2>Apps</h2>
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
                            <span className="strong">Vault</span>
                            <span className="muted small">{vaultState(status)}</span>
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
    return (
        <div className="section-bar">
            <button
                className="back"
                aria-label="Back to the home screen"
                title="Back"
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
