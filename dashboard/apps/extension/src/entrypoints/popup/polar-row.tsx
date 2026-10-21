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
import type { VaultStatus } from "@/lib/messages";

interface Front {
    readonly id?: number;
    readonly windowId?: number;
    readonly url?: string;
}

/** The Polaris deployments a status names: the one in front and the saved ones. */
export function originsOf(status: Pick<VaultStatus, "server" | "servers">): string[] {
    return [...(status.server ? [status.server] : []), ...status.servers.map((one) => one.origin)];
}

export function PolarRow({ status }: { status: Pick<VaultStatus, "server" | "servers"> }): React.JSX.Element {
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
