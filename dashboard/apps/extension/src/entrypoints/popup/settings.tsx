/**
 * The extension's settings: its keyboard shortcuts, drawn the way Polaris's own
 * shortcuts page draws them (a box per group, a row per action, the keys as
 * caps at the end), and where Polar opens.
 *
 * The browser owns the shortcuts, so what is listed is what it answers now
 * (`commands.getAll`), never what the manifest suggested. Chromium changes them
 * only in its own shortcuts screen, which "Change" opens; Firefox lets an
 * extension set one, so there "Change" records the next key press in place.
 */

import { useWords } from "./words";
import * as polar from "@/lib/polar-panel";
import * as filling from "@/lib/page-filling";
import { askBackground } from "@/lib/messages";
import { useEffect, useState } from "react";
import type { WordKey, Words } from "@/lib/words";
import { chromiumBrowser } from "@/lib/browser-name";

interface Command {
    readonly name?: string;
    readonly shortcut?: string;
}

interface Commands {
    getAll(): Promise<Command[]>;
    update?(details: { name: string; shortcut: string }): Promise<void>;
}

/** Read when used, never while drawing: a test draws this with no browser. */
const commands = (): Commands => browser.commands as unknown as Commands;

/** One action in the shortcuts list. */
export interface ShortcutRow {
    readonly name: string;
    readonly label: string;
    readonly keys: string;
}

/** A group of actions, as the account page groups them. */
export interface ShortcutGroup {
    readonly id: string;
    readonly title: string;
    readonly rows: readonly ShortcutRow[];
}

/** The actions this extension has keys for, grouped and titled, with the keys
 *  the browser answers to now (empty for none). Polar's only for an account
 *  that may use it. */
export function shortcutGroups(
    all: readonly Command[],
    t: Words,
    withPolar = true
): ShortcutGroup[] {
    const keys = (name: string): string => all.find((one) => one.name === name)?.shortcut ?? "";
    const groups: ShortcutGroup[] = [
        {
            id: "vault",
            title: t("shell.vault"),
            rows: [{ name: "fill-login", label: t("menu.fill"), keys: keys("fill-login") }]
        },
        {
            id: "polar",
            title: t("polar.title"),
            rows: [
                {
                    name: polar.OPEN_POLAR,
                    label: t("settings.togglePolar"),
                    keys: keys(polar.OPEN_POLAR)
                }
            ]
        }
    ];
    return withPolar ? groups : groups.filter((group) => group.id !== "polar");
}

/** A binding as key caps: "Ctrl+Shift+L" is three, a Mac's "⌘⇧L" is one each. */
export function keyCaps(binding: string): string[] {
    if (binding.includes("+")) return binding.split("+").filter(Boolean);
    return [...binding];
}

export function KeyCaps({ binding }: { binding: string }): React.JSX.Element {
    return (
        <span className="key-caps">
            {keyCaps(binding).map((cap, at) => (
                <kbd key={at} className="key-cap">
                    {cap}
                </kbd>
            ))}
        </span>
    );
}

/** Whether a binding is the one Polaris itself opens Polar with. */
export function matchesPolaris(binding: string): boolean {
    const plain = binding.replace(/\s/g, "").toLowerCase();
    return ["ctrl+j", "command+j", "⌘j"].includes(plain);
}

/** The shortcuts list, the way the account page draws one. */
export function ShortcutSheet({
    groups,
    firefox,
    recording,
    onChange,
    onKey,
    onStop,
    t
}: {
    groups: readonly ShortcutGroup[];
    firefox: boolean;
    recording: string | null;
    onChange: (name: string) => void;
    onKey: (name: string, event: React.KeyboardEvent) => void;
    onStop: () => void;
    t: Words;
}): React.JSX.Element {
    return (
        <div className="sheet">
            {groups.map((group) => (
                <section key={group.id} aria-label={group.title} className="sheet-group">
                    <h4 className="sheet-title">{group.title}</h4>
                    <ul className="sheet-box">
                        {group.rows.map((row) => {
                            const listening = recording === row.name;
                            const hint =
                                row.name === polar.OPEN_POLAR &&
                                !firefox &&
                                !matchesPolaris(row.keys)
                                    ? t("settings.polarisKeys", { keys: polar.POLARIS_SHORTCUT })
                                    : null;
                            return (
                                <li key={row.name} className="sheet-row" data-shortcut={row.name}>
                                    <span className="sheet-label">
                                        <span className="sheet-name">{row.label}</span>
                                        {hint ? <span className="muted small">{hint}</span> : null}
                                    </span>
                                    <span className="sheet-keys">
                                        {row.keys ? (
                                            <KeyCaps binding={row.keys} />
                                        ) : (
                                            <span className="muted small">
                                                {t("settings.none")}
                                            </span>
                                        )}
                                        <button
                                            className={listening ? "chip choice" : "ghost"}
                                            aria-label={
                                                listening
                                                    ? t("polar.pressKeys")
                                                    : t("settings.changeFor", { action: row.label })
                                            }
                                            title={
                                                listening
                                                    ? t("polar.pressKeys")
                                                    : t("settings.changeFor", { action: row.label })
                                            }
                                            onClick={() =>
                                                listening ? onStop() : onChange(row.name)
                                            }
                                            onKeyDown={
                                                listening
                                                    ? (event) => onKey(row.name, event)
                                                    : undefined
                                            }
                                            onBlur={listening ? onStop : undefined}
                                        >
                                            {listening ? t("polar.pressKeys") : t("polar.change")}
                                        </button>
                                    </span>
                                </li>
                            );
                        })}
                    </ul>
                </section>
            ))}
        </div>
    );
}

/**
 * One block of Settings: its heading, then everything under it inside the
 * popup's gutter. Every section goes through this, so nothing in Settings can
 * sit against the popup's edge while its heading is indented.
 */
export function SettingsSection({
    id,
    title,
    children
}: {
    id: string;
    title: string;
    children: React.ReactNode;
}): React.JSX.Element {
    return (
        <section className="settings-section" aria-labelledby={id}>
            <h2 id={id}>{title}</h2>
            <div className="settings-body">{children}</div>
        </section>
    );
}

/** A choice of two, as the popup's chips draw one, with a line saying what it does. */
function Choice<T extends string>({
    label,
    value,
    options,
    disabled,
    hint,
    onChange
}: {
    label: string;
    value: T;
    options: readonly { value: T; label: string }[];
    disabled?: boolean;
    hint: string;
    onChange: (value: T) => void;
}): React.JSX.Element {
    return (
        <div className="setting">
            <span className="strong small">{label}</span>
            <div className="settings-options" role="radiogroup" aria-label={label}>
                {options.map((option) => (
                    <button
                        key={option.value}
                        className="chip choice"
                        role="radio"
                        aria-checked={value === option.value}
                        aria-pressed={value === option.value}
                        aria-disabled={disabled || undefined}
                        onClick={() => {
                            if (!disabled && option.value !== value) onChange(option.value);
                        }}
                    >
                        {option.label}
                    </button>
                ))}
            </div>
            <p className="muted small">{hint}</p>
        </div>
    );
}

/**
 * "Fill in from the vault" on web pages, and the sites it was switched off for.
 *
 * Drawn from what it is given so a test can draw it; `Settings` reads and writes
 * the browser's storage and tells the worker, which registers or removes the
 * inline script there and then.
 */
export function PageFillingSheet({
    on,
    blocked,
    note,
    onTurn,
    onUnblock,
    t
}: {
    on: boolean;
    blocked: readonly string[];
    note: string | null;
    onTurn: (on: boolean) => void;
    onUnblock: (host: string) => void;
    t: Words;
}): React.JSX.Element {
    return (
        <>
            <Choice
                label={t("settings.fillOnPages")}
                value={on ? "on" : "off"}
                options={[
                    { value: "on", label: t("settings.on") },
                    { value: "off", label: t("settings.off") }
                ]}
                hint={t(on ? "settings.fillOnHint" : "settings.fillOffHint")}
                onChange={(value) => onTurn(value === "on")}
            />
            {note ? <p className="muted small">{note}</p> : null}
            <div className="setting">
                <span className="strong small">{t("settings.offSites")}</span>
                {blocked.length === 0 ? (
                    <p className="muted small">{t("settings.noOffSites")}</p>
                ) : (
                    <ul className="sheet-box">
                        {blocked.map((host) => (
                            <li key={host} className="sheet-row" data-blocked={host}>
                                <span className="sheet-name" title={host}>
                                    {host}
                                </span>
                                <button
                                    className="ghost"
                                    aria-label={t("settings.turnBackOnFor", { host })}
                                    onClick={() => onUnblock(host)}
                                >
                                    {t("settings.turnBackOn")}
                                </button>
                            </li>
                        ))}
                    </ul>
                )}
            </div>
        </>
    );
}

const firefoxBrowser = (): boolean => polar.isFirefox(browser);

export function Settings({ canPolar = true }: { canPolar?: boolean }): React.JSX.Element {
    const t = useWords();
    const [all, setAll] = useState<Command[] | null>(null);
    const [recording, setRecording] = useState<string | null>(null);
    const [refused, setRefused] = useState(false);
    const [panelScope, setPanelScope] = useState<polar.PanelScope>("all");
    const [chatScope, setChatScope] = useState<polar.ChatScope>("shared");
    const [pages, setPages] = useState<filling.PageFilling | null>(null);
    const [pagesNote, setPagesNote] = useState<string | null>(null);
    const firefox = firefoxBrowser();
    // Manifest v2 has no `scripting`, so Firefox draws nothing inside pages to
    // switch off.
    const inlinePossible = Boolean(browser.scripting?.registerContentScripts);

    const read = (): void =>
        void commands()
            .getAll()
            .then(setAll)
            .catch(() => setAll([]));

    useEffect(() => {
        read();
        void polar
            .readScopes(browser)
            .then((scopes) => {
                setPanelScope(scopes.panel);
                setChatScope(scopes.chat);
            })
            .catch(() => undefined);
        void filling
            .readPageFilling(browser)
            .then(setPages)
            .catch(() => setPages({ on: true, blocked: [] }));
        // Back from the browser's shortcuts screen is a focus: read the truth again.
        window.addEventListener("focus", read);
        return () => window.removeEventListener("focus", read);
    }, []);

    const change = (name: string): void => {
        setRefused(false);
        if (commands().update) return setRecording(name);
        const brand = chromiumBrowser(
            (navigator as { userAgentData?: { brands?: { brand: string }[] } }).userAgentData
                ?.brands ?? [],
            navigator.userAgent
        );
        void browser.tabs.create({ url: polar.shortcutsPage(brand) });
    };

    const onKey = (name: string, event: React.KeyboardEvent): void => {
        if (event.key === "Escape") return setRecording(null);
        if (event.key === "Tab") return;
        event.preventDefault();
        const shortcut = polar.shortcutFrom(event, /mac/i.test(navigator.platform));
        if (!shortcut) return;
        commands()
            .update?.({ name, shortcut })
            .then(() => {
                setRecording(null);
                read();
            })
            .catch(() => setRefused(true));
    };

    const choosePanel = (value: polar.PanelScope): void => {
        setPanelScope(value);
        void polar.saveScope(browser, "panel", value).catch(() => setPanelScope(panelScope));
    };
    const chooseChat = (value: polar.ChatScope): void => {
        setChatScope(value);
        void polar.saveScope(browser, "chat", value).catch(() => setChatScope(chatScope));
    };

    const turnPages = (on: boolean): void => {
        if (!pages || pages.on === on) return;
        const before = pages;
        setPages({ ...pages, on });
        setPagesNote(null);
        void filling
            .savePageFilling(browser, on)
            .then(() => askBackground({ kind: "startInline" }))
            .then(() => setPagesNote(on ? null : t("popup.sites.reloadOpen")))
            .catch(() => setPages(before));
    };
    const unblock = (host: string): void => {
        if (!pages) return;
        const before = pages;
        setPages({ ...pages, blocked: pages.blocked.filter((entry) => entry !== host) });
        void filling
            .unblockHost(browser, host)
            .then((left) => setPages((now) => (now ? { ...now, blocked: left } : now)))
            .catch(() => setPages(before));
    };

    const hintKey: WordKey = firefox ? "settings.shortcutsFirefox" : "settings.shortcutsChromium";
    return (
        <main className="settings">
            <SettingsSection id="settings-shortcuts" title={t("settings.shortcuts")}>
                <p className="muted small">{t(hintKey)}</p>
                {all === null ? (
                    <div className="sheet-box skeleton" aria-hidden="true" />
                ) : (
                    <ShortcutSheet
                        groups={shortcutGroups(all, t, canPolar)}
                        firefox={firefox}
                        recording={recording}
                        onChange={change}
                        onKey={onKey}
                        onStop={() => setRecording(null)}
                        t={t}
                    />
                )}
                {refused ? <p className="problem">{t("polar.shortcutRefused")}</p> : null}
            </SettingsSection>
            {inlinePossible ? (
                <SettingsSection id="settings-pages" title={t("settings.pages")}>
                    {pages === null ? (
                        <div className="sheet-box skeleton" aria-hidden="true" />
                    ) : (
                        <PageFillingSheet
                            on={pages.on}
                            blocked={pages.blocked}
                            note={pagesNote}
                            onTurn={turnPages}
                            onUnblock={unblock}
                            t={t}
                        />
                    )}
                </SettingsSection>
            ) : null}
            {canPolar ? (
                <SettingsSection id="settings-polar" title={t("polar.title")}>
                    <Choice
                        label={t("settings.openIn")}
                        value={firefox ? "all" : panelScope}
                        disabled={firefox}
                        options={[
                            { value: "all", label: t("settings.allTabs") },
                            { value: "tab", label: t("settings.oneTab") }
                        ]}
                        hint={
                            firefox
                                ? t("settings.firefoxSidebar")
                                : t(
                                      panelScope === "all"
                                          ? "settings.allTabsHint"
                                          : "settings.oneTabHint"
                                  )
                        }
                        onChange={choosePanel}
                    />
                    <Choice
                        label={t("settings.chat")}
                        value={chatScope}
                        options={[
                            { value: "shared", label: t("settings.sharedChat") },
                            { value: "tab", label: t("settings.tabChat") }
                        ]}
                        hint={t(
                            chatScope === "shared"
                                ? "settings.sharedChatHint"
                                : "settings.tabChatHint"
                        )}
                        onChange={chooseChat}
                    />
                </SettingsSection>
            ) : null}
        </main>
    );
}
