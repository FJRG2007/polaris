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
                                            className={listening ? "chip" : "ghost"}
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
            <div className="row" role="radiogroup" aria-label={label}>
                {options.map((option) => (
                    <button
                        key={option.value}
                        className="chip"
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

const firefoxBrowser = (): boolean => polar.isFirefox(browser);

export function Settings({ canPolar = true }: { canPolar?: boolean }): React.JSX.Element {
    const t = useWords();
    const [all, setAll] = useState<Command[] | null>(null);
    const [recording, setRecording] = useState<string | null>(null);
    const [refused, setRefused] = useState(false);
    const [panelScope, setPanelScope] = useState<polar.PanelScope>("all");
    const [chatScope, setChatScope] = useState<polar.ChatScope>("shared");
    const firefox = firefoxBrowser();

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

    const hintKey: WordKey = firefox ? "settings.shortcutsFirefox" : "settings.shortcutsChromium";
    return (
        <main className="settings">
            <section aria-labelledby="settings-shortcuts">
                <h2 id="settings-shortcuts">{t("settings.shortcuts")}</h2>
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
            </section>
            {canPolar ? (
                <section aria-labelledby="settings-polar">
                    <h2 id="settings-polar">{t("polar.title")}</h2>
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
                </section>
            ) : null}
        </main>
    );
}
