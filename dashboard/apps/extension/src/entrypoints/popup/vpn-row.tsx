/**
 * The VPN on the home screen: where this browser leaves from, and the servers it
 * can switch to. Hidden where this Polaris has none for this account.
 */

import { useWords } from "./words";
import { useEffect, useState } from "react";
import { EVERY_SITE } from "@/lib/injection";
import type { VpnNode, VpnState } from "@/lib/vpn";
import { askBackground, type Request } from "@/lib/messages";

export function VpnRow(): React.JSX.Element | null {
    const t = useWords();
    const [state, setState] = useState<VpnState | null>(null);
    const [open, setOpen] = useState(false);
    const [busy, setBusy] = useState(false);
    const [error, setError] = useState<string | null>(null);

    useEffect(() => {
        void askBackground({ kind: "vpn" }).then((reply) => {
            if (reply.ok && "vpn" in reply) setState(reply.vpn);
        });
    }, []);

    const send = (request: Request): void => {
        setBusy(true);
        setError(null);
        void askBackground(request).then((reply) => {
            setBusy(false);
            if (reply.ok && "vpn" in reply) setState(reply.vpn);
            else setError(reply.ok ? t("errors.serverSilent") : reply.error);
        });
    };

    /** The grant has to be asked for here, inside the click: the worker cannot. */
    const connect = (nodeId: string): void => {
        setBusy(true);
        setError(null);
        void browser.permissions
            .request({ origins: [...EVERY_SITE] })
            .catch(() => false)
            .then((granted) => {
                if (granted) return send({ kind: "vpnConnect", nodeId });
                setBusy(false);
                return setError(t("vpn.refused.noSites"));
            });
    };

    if (!state || (!state.available && !state.active)) return null;
    const { active } = state;
    const label = (node: VpnNode): string =>
        node.exit === "tor" ? t("vpn.throughTor", { name: node.name }) : node.name;

    return (
        <li className="section-row">
            <button className="section" aria-expanded={open} onClick={() => setOpen(!open)}>
                <span className="section-mark" aria-hidden="true">
                    <svg viewBox="0 0 24 24">
                        <path d="M12 3 5 6v5.5c0 4.3 2.9 7.8 7 9.5 4.1-1.7 7-5.2 7-9.5V6z" />
                    </svg>
                </span>
                <span className="section-text">
                    <span className="strong">{t("vpn.title")}</span>
                    <span className="muted small">
                        {active ? t("vpn.on", { name: active.nodeName }) : t("vpn.off")}
                    </span>
                </span>
                <svg className="chevron-right" viewBox="0 0 24 24" aria-hidden="true">
                    <path d={open ? "m6 9 6 6 6-6" : "m9 18 6-6-6-6"} />
                </svg>
            </button>
            {open ? (
                <div className="section-text" style={{ padding: "4px 12px 8px", gap: 6 }}>
                    {active ? (
                        <button disabled={busy} onClick={() => send({ kind: "vpnDisconnect" })}>
                            {t("vpn.disconnect")}
                        </button>
                    ) : null}
                    {state.nodes.map((node) => (
                        <button
                            key={node.id}
                            disabled={busy || !node.browser || node.id === active?.nodeId}
                            title={node.browser ? undefined : t("vpn.noBrowserRoute")}
                            onClick={() => connect(node.id)}
                        >
                            {label(node)}
                        </button>
                    ))}
                    {state.nodes.some((node) => !node.browser) ? (
                        <span className="muted small">{t("vpn.noBrowserRoute")}</span>
                    ) : null}
                    {error ? (
                        <span role="alert" className="small">
                            {error}
                        </span>
                    ) : null}
                </div>
            ) : null}
        </li>
    );
}
