/**
 * Polar on the home screen: the row that opens it beside the page, and the
 * shortcut that does the same from the keyboard.
 *
 * The browser owns the shortcut. Chromium changes it only in its own shortcuts
 * screen, so the button opens that; Firefox lets an extension set it, so there
 * the button takes the next key press in place.
 */

import { useWords } from "./words";
import * as polar from "@/lib/polar-panel";
import { useEffect, useState } from "react";
import { chromiumBrowser } from "@/lib/browser-name";

interface Commands {
    getAll(): Promise<{ name?: string; shortcut?: string }[]>;
    update?(details: { name: string; shortcut: string }): Promise<void>;
}

const firefox = (): boolean =>
    typeof (browser as unknown as polar.PanelOpeners).sidebarAction !== "undefined";

/** Read when used, never while drawing: a test draws this with no browser. */
const commands = (): Commands => browser.commands as unknown as Commands;

const commandName = (): string => (firefox() ? polar.FIREFOX_SIDEBAR : polar.OPEN_POLAR);

export function PolarRow(): React.JSX.Element {
    const t = useWords();
    const [keys, setKeys] = useState<string | null>(null);
    const [windowId, setWindowId] = useState<number | undefined>(undefined);
    const [capturing, setCapturing] = useState(false);
    const [refused, setRefused] = useState(false);

    useEffect(() => {
        // The window is looked up now, not on the click: the panel opens only
        // inside the click itself, with nothing awaited before it.
        void browser.windows?.getCurrent?.().then((current) => setWindowId(current.id));
        void commands()
            .getAll()
            .then((all) => setKeys(all.find((one) => one.name === commandName())?.shortcut ?? ""))
            .catch(() => setKeys(""));
    }, []);

    const open = (): void => {
        if (polar.openSidePanel(browser, windowId)) window.close();
    };

    const change = (): void => {
        setRefused(false);
        if (commands().update) return setCapturing(true);
        const name = chromiumBrowser(
            (navigator as { userAgentData?: { brands?: { brand: string }[] } }).userAgentData
                ?.brands ?? [],
            navigator.userAgent
        );
        void browser.tabs.create({ url: polar.shortcutsPage(name) });
    };

    const onKey = (event: React.KeyboardEvent): void => {
        if (event.key === "Escape") return setCapturing(false);
        if (event.key === "Tab") return;
        event.preventDefault();
        const mac = /mac/i.test(navigator.platform);
        const shortcut = polar.shortcutFrom(event, mac);
        if (!shortcut) return;
        commands()
            .update?.({ name: commandName(), shortcut })
            .then(() => {
                setKeys(shortcut);
                setCapturing(false);
            })
            .catch(() => setRefused(true));
    };

    return (
        <li className="section-row">
            <button className="section" onClick={open}>
                <span className="section-mark" aria-hidden="true">
                    <svg viewBox="0 0 24 24">
                        <path d="M3 6.75A3.75 3.75 0 0 1 6.75 3h10.5A3.75 3.75 0 0 1 21 6.75v7.5A3.75 3.75 0 0 1 17.25 18h-6l-4.5 3.4V18A3.75 3.75 0 0 1 3 14.25z" />
                        <path
                            d="M12 6.4q0 4.1 4.1 4.1q-4.1 0-4.1 4.1q0-4.1-4.1-4.1q4.1 0 4.1-4.1z"
                            fill="currentColor"
                            strokeWidth={1}
                        />
                    </svg>
                </span>
                <span className="section-text">
                    <span className="strong">{t("polar.title")}</span>
                    <span className="muted small">{t("polar.open")}</span>
                </span>
            </button>
            <div className="row">
                <span className="muted small grow">
                    {keys
                        ? t("polar.shortcut", { keys })
                        : keys === ""
                          ? t("polar.noShortcut")
                          : ""}
                </span>
                {capturing ? (
                    <input
                        autoFocus
                        readOnly
                        className="small"
                        aria-label={t("polar.pressKeys")}
                        placeholder={t("polar.pressKeys")}
                        onKeyDown={onKey}
                        onBlur={() => setCapturing(false)}
                    />
                ) : (
                    <button className="ghost" onClick={change}>
                        {t("polar.change")}
                    </button>
                )}
            </div>
            {refused ? <p className="problem">{t("polar.shortcutRefused")}</p> : null}
        </li>
    );
}
