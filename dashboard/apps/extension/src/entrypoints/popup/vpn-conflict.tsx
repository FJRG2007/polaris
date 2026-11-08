/**
 * The VPN's card for a proxy Polaris does not hold: which extension holds it,
 * with the button that disables it, or - where the browser's administrator set
 * it - who to ask, since no button here changes that.
 *
 * Naming the extension takes the optional `management` permission, asked for on
 * the press of "Show which one" and kept after that. The browser only says that
 * some other extension is in control, so every enabled one that may set a proxy
 * is listed.
 */

import type { Words } from "@/lib/words";
import { useEffect, useState } from "react";
import type { ConflictExtension, ProxyConflict } from "@/lib/vpn";

type Listenable = { addListener(listener: () => void): void; removeListener(listener: () => void): void };

/**
 * Calls `changed` whenever the proxy's holder may have changed: the setting
 * itself, or an extension turned on, off, added or removed. `key` re-subscribes
 * once the management events exist, which is only after their permission.
 */
export function useProxyWatch(changed: () => void, key: string): void {
    useEffect(() => {
        if (import.meta.env?.BROWSER === "firefox") return;
        const api = (globalThis as { browser?: unknown }).browser as {
            proxy?: { settings?: { onChange?: Listenable } };
            management?: Partial<Record<"onEnabled" | "onDisabled" | "onInstalled" | "onUninstalled", Listenable>>;
        } | undefined;
        const events = [
            api?.proxy?.settings?.onChange,
            api?.management?.onEnabled,
            api?.management?.onDisabled,
            api?.management?.onInstalled,
            api?.management?.onUninstalled
        ].filter((event): event is Listenable => typeof event?.addListener === "function");
        const listener = (): void => changed();
        for (const event of events) event.addListener(listener);
        return () => {
            for (const event of events) event.removeListener(listener);
        };
        // `changed` is the panel's reload, the same for the popup's lifetime.
        // eslint-disable-next-line react-hooks/exhaustive-deps
    }, [key]);
}

/** An extension's own icon, or a puzzle piece where it has none or it does not load. */
function ExtensionIcon({ icon }: { icon: string | null }): React.JSX.Element {
    const [broken, setBroken] = useState(false);
    if (!icon || broken)
        return (
            <span className="vpn-conflict-icon" aria-hidden="true">
                <svg viewBox="0 0 24 24">
                    <path d="M10 3a2 2 0 0 1 4 0v2h4a1 1 0 0 1 1 1v4h-2a2 2 0 0 0 0 4h2v4a1 1 0 0 1-1 1h-4v-2a2 2 0 0 0-4 0v2H6a1 1 0 0 1-1-1v-4h2a2 2 0 0 0 0-4H5V6a1 1 0 0 1 1-1h4z" />
                </svg>
            </span>
        );
    return (
        <img
            className="vpn-conflict-icon"
            src={icon}
            alt=""
            aria-hidden="true"
            onError={() => setBroken(true)}
        />
    );
}

export function ProxyConflictCard({
    conflict,
    connected,
    working,
    error,
    onFind,
    onDisable,
    onOpenExtensions,
    t
}: {
    conflict: ProxyConflict;
    connected: boolean;
    /** The id being disabled, "find" while the permission is asked, or null. */
    working: string | null;
    error: string | null;
    onFind: () => void;
    onDisable: (extension: ConflictExtension) => void;
    onOpenExtensions: () => void;
    t: Words;
}): React.JSX.Element {
    if (conflict.kind === "policy")
        return (
            <div className="vpn-conflict" role="status">
                <span className="strong small">{t("vpn.conflict.policyTitle")}</span>
                <span className="small">{t("vpn.conflict.policyHint")}</span>
            </div>
        );
    const { extensions } = conflict;
    const count = extensions && extensions.length > 1 ? extensions.length : 1;
    return (
        <div className="vpn-conflict" role="status">
            <span className="strong small">{t("vpn.conflict.title", { count })}</span>
            <span className="small">
                {t(connected ? "vpn.conflict.hintConnected" : "vpn.conflict.hint")}
            </span>
            {extensions === null ? (
                <>
                    <button
                        className="ghost"
                        aria-disabled={working !== null || undefined}
                        onClick={() => working === null && onFind()}
                    >
                        {t("vpn.conflict.find")}
                    </button>
                    <span className="muted small">{t("vpn.conflict.findHint")}</span>
                </>
            ) : extensions.length === 0 ? (
                <>
                    <span className="muted small">{t("vpn.conflict.unnamed")}</span>
                    <button className="ghost" onClick={onOpenExtensions}>
                        {t("vpn.conflict.openExtensions")}
                    </button>
                </>
            ) : (
                <ul className="vpn-conflict-list">
                    {extensions.map((extension) => (
                        <li key={extension.id} className="vpn-conflict-row">
                            <ExtensionIcon icon={extension.icon} />
                            <span className="vpn-conflict-name" title={extension.name}>
                                {extension.name}
                            </span>
                            {extension.mayDisable ? (
                                <button
                                    className="ghost"
                                    aria-disabled={working !== null || undefined}
                                    aria-label={t("vpn.conflict.disableNamed", {
                                        name: extension.name
                                    })}
                                    title={t("vpn.conflict.disableNamed", { name: extension.name })}
                                    onClick={() => working === null && onDisable(extension)}
                                >
                                    {working === extension.id ? (
                                        <span className="vpn-spinner" aria-hidden="true" />
                                    ) : null}
                                    {working === extension.id
                                        ? t("vpn.conflict.disabling")
                                        : t("vpn.conflict.disable")}
                                </button>
                            ) : (
                                <span className="badge muted" title={t("vpn.conflict.locked")}>
                                    {t("vpn.conflict.locked")}
                                </span>
                            )}
                        </li>
                    ))}
                </ul>
            )}
            {error ? (
                <span className="vpn-conflict-error small" role="alert">
                    {error}
                </span>
            ) : null}
        </div>
    );
}
