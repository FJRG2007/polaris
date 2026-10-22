/**
 * Polar on the home screen: the row that opens it beside the page. Its
 * shortcut is listed and changed in Settings, with the extension's others.
 *
 * On a tab of a Polaris this browser knows, the page already carries Polar, so
 * the row opens that one instead of a second copy beside it.
 */

import { useWords } from "./words";
import * as polar from "@/lib/polar-panel";
import { useEffect, useState } from "react";
import { askBackground, type VaultStatus } from "@/lib/messages";

interface Front {
    readonly id?: number;
    readonly windowId?: number;
    readonly url?: string;
}

/** The Polaris deployments a status names: the one in front and the saved ones. */
export function originsOf(status: Pick<VaultStatus, "server" | "servers">): string[] {
    return [...(status.server ? [status.server] : []), ...status.servers.map((one) => one.origin)];
}

export function PolarRow({
    status
}: {
    status: Pick<VaultStatus, "server" | "servers">;
}): React.JSX.Element {
    const t = useWords();
    const [front, setFront] = useState<Front>({});
    const [scope, setScope] = useState<polar.PanelScope>("all");

    useEffect(() => {
        // Looked up now, not on the click: the panel opens only inside the
        // click itself, with nothing awaited before it.
        void browser.tabs
            ?.query?.({ active: true, currentWindow: true })
            .then(([tab]) => setFront({ id: tab?.id, windowId: tab?.windowId, url: tab?.url }))
            .catch(() => undefined);
        void polar
            .readScopes(browser)
            .then((scopes) => setScope(scopes.panel))
            .catch(() => undefined);
    }, []);

    const open = (): void => {
        if (polar.isPolarisTab(front.url, originsOf(status)) && front.id !== undefined) {
            polar.sendToPolarisTab(browser, front.id, polar.polarisCommand({}));
            window.close();
            return;
        }
        if (polar.openPolarFor(browser, front, scope)) window.close();
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
                <svg className="chevron-right" viewBox="0 0 24 24" aria-hidden="true">
                    <path d="m9 18 6-6-6-6" />
                </svg>
            </button>
        </li>
    );
}

/**
 * The sites Polar may always use in this browser (`lib/polar-browser.ts`),
 * each withdrawn in one press. Nothing to switch on: Polar asks for a site the
 * first time it needs it. Hidden while no site is allowed always.
 */
export function PolarBrowserRow(): React.JSX.Element | null {
    const t = useWords();
    const [state, setState] = useState<{ sites: readonly string[] } | null>(null);
    const [error, setError] = useState<string | null>(null);

    useEffect(() => {
        void askBackground({ kind: "polarBrowser" })
            .then((reply) => {
                if (reply.ok && "polarBrowser" in reply) setState(reply.polarBrowser);
            })
            .catch(() => undefined);
    }, []);

    /** Sends a change; on a refusal or no answer, puts `previous` back and says why. */
    const send = (
        request: Parameters<typeof askBackground>[0],
        previous: { sites: readonly string[] }
    ) => {
        setError(null);
        void askBackground(request)
            .then((reply) => {
                if (reply.ok && "polarBrowser" in reply) return setState(reply.polarBrowser);
                setState(previous);
                setError(reply.ok ? t("errors.serverSilent") : reply.error);
            })
            .catch(() => {
                setState(previous);
                setError(t("errors.serverSilent"));
            });
    };

    if (!state || state.sites.length === 0) return null;
    return (
        <li className="section-row">
            <div className="section-text" style={{ padding: "8px 12px 4px" }}>
                <span className="strong">{t("polar.browserSitesTitle")}</span>
                <span className="muted small">{t("polar.browserSitesHint")}</span>
            </div>
            <ul style={{ listStyle: "none", margin: 0, padding: "0 12px 8px" }}>
                {state.sites.map((site) => (
                    <li
                        key={site}
                        className="small"
                        style={{ display: "flex", alignItems: "center", gap: 8, minHeight: 28 }}
                    >
                        <span
                            style={{
                                minWidth: 0,
                                flex: 1,
                                overflow: "hidden",
                                textOverflow: "ellipsis",
                                whiteSpace: "nowrap"
                            }}
                            title={site}
                        >
                            {site}
                        </span>
                        <button
                            className="link"
                            aria-label={t("polar.browserForgetSite", { site })}
                            title={t("polar.browserForgetSite", { site })}
                            onClick={() => {
                                // Gone at once, put back if the worker did not take it.
                                setState({ sites: state.sites.filter((entry) => entry !== site) });
                                send({ kind: "forgetPolarSites", site }, state);
                            }}
                        >
                            {t("polar.browserForget")}
                        </button>
                    </li>
                ))}
            </ul>
            {error ? (
                <p
                    className="muted small"
                    role="alert"
                    style={{ padding: "0 12px 8px", margin: 0 }}
                >
                    {error}
                </p>
            ) : null}
        </li>
    );
}
