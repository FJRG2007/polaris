/**
 * The VPN on the home screen: whether this browser is connected and where from,
 * one press away from its own screen. Hidden where this Polaris has none for
 * this account.
 *
 * The state is held for the popup's lifetime, so opening the VPN screen from
 * this row draws what the row already knows instead of loading it again.
 */

import { useWords } from "./words";
import { useEffect, useState } from "react";
import { flagPath, placeOf } from "@/lib/vpn-places";
import { askBackground } from "@/lib/messages";
import type { VpnNode, VpnState } from "@/lib/vpn";

let held: VpnState | null = null;
const listeners = new Set<(state: VpnState) => void>();

/** Shares a fresh state with every part of the popup drawing the VPN. */
export function shareVpnState(state: VpnState): void {
    held = state;
    for (const listener of listeners) listener(state);
}

/**
 * The VPN's state: the last one this popup saw at once, asked again in the
 * background. `failed` is a question the worker could not answer.
 */
export function useVpnState(): { state: VpnState | null; failed: boolean; reload: () => void } {
    const [state, setState] = useState<VpnState | null>(held);
    const [failed, setFailed] = useState(false);
    const reload = (): void => {
        setFailed(false);
        void askBackground({ kind: "vpn" }).then((reply) => {
            if (reply.ok && "vpn" in reply) shareVpnState(reply.vpn);
            else setFailed(true);
        });
    };
    useEffect(() => {
        listeners.add(setState);
        reload();
        return () => {
            listeners.delete(setState);
        };
        // Asked once per mount; `reload` is the way to ask again.
        // eslint-disable-next-line react-hooks/exhaustive-deps
    }, []);
    return { state, failed, reload };
}

/** The node in use, from the list, where the list still has it. */
export function activeNode(state: VpnState): VpnNode | null {
    return state.nodes.find((node) => node.id === state.active?.nodeId) ?? null;
}

/** A country's flag, or a globe for a server nobody placed. Decorative: the
 *  country's name is always written beside it. */
export function Flag({ code, large }: { code: string | null; large?: boolean }): React.JSX.Element {
    const [broken, setBroken] = useState(false);
    const path = flagPath(code);
    const size = large ? "vpn-flag large" : "vpn-flag";
    if (!path || broken)
        return (
            <span className={`${size} globe`} aria-hidden="true">
                <svg viewBox="0 0 24 24">
                    <circle cx="12" cy="12" r="9" />
                    <path d="M3 12h18M12 3c2.5 2.6 3.8 5.6 3.8 9s-1.3 6.4-3.8 9c-2.5-2.6-3.8-5.6-3.8-9S9.5 5.6 12 3z" />
                </svg>
            </span>
        );
    return (
        <img
            className={size}
            src={path}
            alt=""
            aria-hidden="true"
            onError={() => setBroken(true)}
        />
    );
}

export function VpnRow({ onOpen }: { onOpen: () => void }): React.JSX.Element | null {
    const t = useWords();
    const { state } = useVpnState();
    if (!state || (!state.available && !state.active)) return null;
    const node = activeNode(state);
    const where = state.active
        ? ((node ? placeOf(node, t.locale) : null) ?? state.active.nodeName)
        : null;
    // A proxy somebody else holds is what the VPN screen is needed for, so it is
    // what the row says, connected or not.
    const line = state.conflict
        ? t("vpn.conflict.row")
        : where
          ? t("vpn.connectedFrom", { place: where })
          : t("vpn.off");
    return (
        <li className="section-row">
            <button className="section" onClick={onOpen}>
                {state.active ? (
                    <span className="section-mark on" aria-hidden="true">
                        <Flag code={node?.country ?? null} />
                    </span>
                ) : (
                    <span className="section-mark" aria-hidden="true">
                        <svg viewBox="0 0 24 24">
                            <path d="M12 3 5 6v5.5c0 4.3 2.9 7.8 7 9.5 4.1-1.7 7-5.2 7-9.5V6z" />
                        </svg>
                    </span>
                )}
                <span className="section-text">
                    <span className="strong">{t("vpn.title")}</span>
                    <span className="muted small section-sub" title={line}>
                        {state.active && !state.conflict ? (
                            <span className="vpn-dot" aria-hidden="true" />
                        ) : null}
                        {line}
                    </span>
                </span>
                <svg className="chevron-right" viewBox="0 0 24 24" aria-hidden="true">
                    <path d="m9 18 6-6-6-6" />
                </svg>
            </button>
        </li>
    );
}
