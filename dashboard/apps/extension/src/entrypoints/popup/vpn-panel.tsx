/**
 * The VPN's own screen: whether this browser is connected and where from, the
 * one action that changes it, and every server this account may leave through,
 * by country and then by city.
 *
 * Quick connect goes back to the most recent server still usable and picks one
 * at random the first time; Random picks another. Either of them, and a country
 * pressed as a whole, tries one more server when the first does not carry
 * traffic, and says which one it ended on. A server picked by hand is not
 * swapped for another: whoever picked it is told why it failed instead.
 *
 * Connected, the card says for how long, where the saved connection says when it
 * began. It does not show the exit address: the check before connecting only
 * learns that traffic flows, and asking a lookup service would tell a third
 * party who is behind the VPN.
 */

import { useWords } from "./words";
import { Choice } from "./settings";
import { useEffect, useMemo, useState } from "react";
import * as places from "@/lib/vpn-places";
import { EVERY_SITE } from "@/lib/injection";
import { askBackground } from "@/lib/messages";
import type { ConflictExtension, VpnNode, VpnState } from "@/lib/vpn";
import { activeNode, Flag, shareVpnState, useVpnState } from "./vpn-row";
import { ProxyConflictCard, useProxyWatch } from "./vpn-conflict";

const RECENTS_KEY = "polaris.vpn.recents";

function loadRecents(): string[] {
    try {
        return places.readRecents(JSON.parse(window.localStorage.getItem(RECENTS_KEY) ?? "[]"));
    } catch {
        return [];
    }
}

function saveRecents(recents: readonly string[]): void {
    try {
        window.localStorage.setItem(RECENTS_KEY, JSON.stringify(recents));
    } catch {
        // Recents are a convenience; connecting still worked.
    }
}

type Outcome = { ok: true; state: VpnState } | { ok: false; error: string };

export function VpnPanel(): React.JSX.Element {
    const t = useWords();
    const { state, failed, reload } = useVpnState();
    const [recents, setRecents] = useState(loadRecents);
    const [query, setQuery] = useState("");
    const [open, setOpen] = useState<ReadonlySet<string>>(new Set());
    const [connecting, setConnecting] = useState<VpnNode | null>(null);
    const [error, setError] = useState<{ text: string; retry: () => void } | null>(null);
    const [note, setNote] = useState<string | null>(null);
    const [guardError, setGuardError] = useState<string | null>(null);
    /** What the proxy card is doing: an extension's id, "find", or nothing. */
    const [working, setWorking] = useState<string | null>(null);
    const [conflictError, setConflictError] = useState<string | null>(null);
    /** The server a refused connect was for, tried again once the proxy is free. */
    const [retryNode, setRetryNode] = useState<VpnNode | null>(null);
    /** Moved once the management permission is granted, so its events are heard. */
    const [watchKey, setWatchKey] = useState(0);
    useProxyWatch(reload, String(watchKey));

    const countries = useMemo(
        () => places.groupByCountry(state?.nodes ?? [], t.locale, t("vpn.otherPlaces")),
        [state, t]
    );
    const shown = useMemo(() => places.searchCountries(countries, query), [countries, query]);

    if (!state) return <PanelSkeleton failed={failed} onRetry={reload} />;

    const busy = connecting !== null;
    const active = activeNode(state);
    const label = (node: VpnNode): string =>
        node.exit === "tor" ? t("vpn.throughTor", { name: node.name }) : node.name;
    const reason = (node: VpnNode): string =>
        node.browserIssue
            ? t(`vpn.browserIssue.${node.browserIssue}`, { name: node.name })
            : t("vpn.noBrowserRoute");

    const ask = (node: VpnNode): Promise<Outcome> =>
        askBackground({ kind: "vpnConnect", nodeId: node.id }).then((reply) =>
            reply.ok && "vpn" in reply
                ? { ok: true, state: reply.vpn }
                : { ok: false, error: reply.ok ? t("errors.serverSilent") : reply.error }
        );

    /**
     * Connects to `first`, and to `fallback()` once when that fails and one is
     * given. The grant is asked for here, inside the click: the worker cannot.
     */
    const connect = (
        first: VpnNode,
        fallback?: (failed: VpnNode) => VpnNode | null,
        outsideClick = false
    ): void => {
        setConnecting(first);
        setError(null);
        setNote(null);
        const retry = (): void => connect(first, fallback);
        // Away from a click the browser refuses to ask; the worker still checks
        // the grant and says so when it is missing.
        const grant = outsideClick
            ? Promise.resolve(true)
            : browser.permissions.request({ origins: [...EVERY_SITE] });
        void grant
            .catch(() => false)
            .then(async (granted) => {
                if (!granted) return { ok: false, error: t("vpn.refused.noSites") } as Outcome;
                const outcome = await ask(first);
                const next = outcome.ok ? null : fallback?.(first);
                if (outcome.ok || !next) return outcome;
                setConnecting(next);
                const second = await ask(next);
                if (second.ok) setNote(t("vpn.fellBack", { failed: first.name, name: next.name }));
                return second.ok ? { ...second, node: next } : outcome;
            })
            .then((outcome: Outcome & { node?: VpnNode }) => {
                setConnecting(null);
                if (!outcome.ok) {
                    // A failed switch can leave the old server off: draw what is true now.
                    reload();
                    setRetryNode(first);
                    return setError({ text: outcome.error, retry });
                }
                setRetryNode(null);
                shareVpnState(outcome.state);
                const used = outcome.node ?? first;
                const next = places.pushRecent(recents, used.id);
                setRecents(next);
                saveRecents(next);
            });
    };

    const disconnect = (): void => {
        setConnecting(null);
        setError(null);
        setNote(null);
        void askBackground({ kind: "vpnDisconnect" }).then((reply) => {
            if (reply.ok && "vpn" in reply) shareVpnState(reply.vpn);
            else
                setError({
                    text: reply.ok ? t("errors.serverSilent") : reply.error,
                    retry: disconnect
                });
        });
    };

    /** Asks, inside the click, to see the extensions, so the card can name them. */
    const findHolder = (): void => {
        setConflictError(null);
        setWorking("find");
        void browser.permissions
            .request({ permissions: ["management"] })
            .catch(() => false)
            .then((granted) => {
                setWorking(null);
                if (!granted) return setConflictError(t("vpn.conflict.findRefused"));
                setWatchKey((key) => key + 1);
                reload();
            });
    };

    /**
     * Disables the extension, inside the click as the browser wants, then takes
     * the proxy back: a connection in place gets it again, and a connect that was
     * refused for it is tried once more. Another extension next in line shows up
     * in the card instead.
     */
    const disableHolder = (extension: ConflictExtension): void => {
        setConflictError(null);
        setWorking(extension.id);
        const management = (
            browser as unknown as {
                management?: { setEnabled?(id: string, enabled: boolean): Promise<void> };
            }
        ).management;
        const done = management?.setEnabled
            ? management.setEnabled(extension.id, false)
            : Promise.reject(new Error("management is not granted"));
        void done
            .then(
                () => true,
                () => false
            )
            .then(async (off) => {
                if (!off) {
                    setWorking(null);
                    return setConflictError(
                        t("vpn.conflict.disableFailed", { name: extension.name })
                    );
                }
                const reply = await askBackground({ kind: "vpnReclaim" });
                setWorking(null);
                if (!reply.ok || !("vpn" in reply)) return reload();
                shareVpnState(reply.vpn);
                if (!reply.vpn.conflict && !reply.vpn.active && retryNode) {
                    connect(retryNode, undefined, true);
                }
            });
    };

    /** Optimistic: the choice shows at once and goes back if the worker refuses it. */
    const turnWebRtc = (on: boolean): void => {
        setGuardError(null);
        shareVpnState({ ...state, webRtcGuard: on });
        void askBackground({ kind: "vpnWebRtc", on }).then((reply) => {
            if (reply.ok && "vpn" in reply) return shareVpnState(reply.vpn);
            shareVpnState({ ...state, webRtcGuard: !on });
            setGuardError(reply.ok ? t("errors.serverSilent") : reply.error);
        });
    };

    /** Another usable server than the one that failed, and than the one in use. */
    const otherThan = (failed: VpnNode): VpnNode | null =>
        places.randomPick(
            state.nodes.filter((node) => node.id !== failed.id),
            state.active?.nodeId ?? null
        );
    const quick = places.quickPick(state.nodes, recents);
    const random = places.randomPick(state.nodes, state.active?.nodeId ?? null);
    const recent = places.recentNodes(state.nodes, recents);
    const searching = query.trim().length > 0;

    const toggle = (key: string): void =>
        setOpen((held) => {
            const next = new Set(held);
            if (next.has(key)) next.delete(key);
            else next.add(key);
            return next;
        });

    /** Connecting cannot work while something else holds the proxy. */
    const held = Boolean(state.conflict);
    const status = connecting ? "connecting" : state.active ? "on" : "off";
    const where = connecting ?? active;
    const place = where ? places.placeOf(where, t.locale) : null;
    const heading =
        status === "connecting"
            ? t("vpn.connecting")
            : status === "on"
              ? t("vpn.connected")
              : t("vpn.notConnected");
    const detail =
        status === "off"
            ? t("vpn.offHint")
            : (place ?? (where ? label(where) : (state.active?.nodeName ?? "")));
    const server = status !== "off" && place && where ? label(where) : null;

    return (
        <main className="vpn">
            <section className="vpn-hero" data-state={status} aria-live="polite">
                <div className="vpn-status">
                    {status === "off" ? (
                        <span className="vpn-shield" aria-hidden="true">
                            <svg viewBox="0 0 24 24">
                                <path d="M12 3 5 6v5.5c0 4.3 2.9 7.8 7 9.5 4.1-1.7 7-5.2 7-9.5V6z" />
                            </svg>
                        </span>
                    ) : (
                        <Flag code={where?.country ?? null} large />
                    )}
                    <span className="vpn-status-text">
                        <span className="vpn-state">
                            <span className="vpn-dot" aria-hidden="true" />
                            {heading}
                        </span>
                        <span className="vpn-where" title={detail}>
                            {detail}
                        </span>
                        {server ? (
                            <span className="vpn-server muted small" title={server}>
                                {server}
                            </span>
                        ) : null}
                        {status === "on" && state.active?.since ? (
                            <ConnectedFor since={state.active.since} />
                        ) : null}
                    </span>
                </div>
                {status === "on" ? (
                    <button className="vpn-main off" onClick={disconnect}>
                        {t("vpn.disconnect")}
                    </button>
                ) : (
                    <div className="vpn-actions">
                        <button
                            className="vpn-main"
                            disabled={busy || held || !quick}
                            title={
                                quick
                                    ? t("vpn.connectTo", { name: label(quick) })
                                    : t("vpn.noneUsable")
                            }
                            onClick={() => quick && connect(quick, otherThan)}
                        >
                            {busy ? <span className="vpn-spinner" aria-hidden="true" /> : null}
                            {busy ? t("vpn.connecting") : t("vpn.quickConnect")}
                        </button>
                        <button
                            className="ghost vpn-random"
                            disabled={busy || held || !random}
                            title={t("vpn.randomHint")}
                            onClick={() => random && connect(random, otherThan)}
                        >
                            <svg viewBox="0 0 24 24" aria-hidden="true">
                                <path d="M16 3h5v5M4 20 21 3M21 16v5h-5M15 15l6 6M4 4l5 5" />
                            </svg>
                            {t("vpn.random")}
                        </button>
                    </div>
                )}
                {status === "on" ? (
                    <button
                        className="ghost vpn-change"
                        disabled={held || !random}
                        title={t("vpn.randomHint")}
                        onClick={() => random && connect(random, otherThan)}
                    >
                        {t("vpn.changeRandom")}
                    </button>
                ) : null}
                {state.conflict ? (
                    <ProxyConflictCard
                        conflict={state.conflict}
                        connected={state.active !== null}
                        working={working}
                        error={conflictError}
                        onFind={findHolder}
                        onDisable={disableHolder}
                        onOpenExtensions={() =>
                            void browser.tabs.create({ url: "chrome://extensions" })
                        }
                        t={t}
                    />
                ) : null}
                {note ? (
                    <p className="vpn-note small" role="status">
                        {note}
                    </p>
                ) : null}
                {error && !state.conflict ? (
                    <div className="vpn-error" role="alert">
                        <span className="strong small">{t("vpn.failed")}</span>
                        <span className="small">{error.text}</span>
                        <button className="ghost" onClick={error.retry}>
                            {t("vpn.tryAgain")}
                        </button>
                    </div>
                ) : null}
            </section>

            {state.nodes.length === 0 ? (
                <div className="vpn-empty">
                    <span className="strong">{t("vpn.emptyTitle")}</span>
                    <span className="muted small">{t("vpn.emptyHint")}</span>
                </div>
            ) : (
                <>
                    <div className="vpn-search">
                        <input
                            type="search"
                            value={query}
                            aria-label={t("vpn.searchLabel")}
                            placeholder={t("vpn.search")}
                            onChange={(event) => setQuery(event.target.value)}
                        />
                    </div>
                    {!searching && recent.length ? (
                        <>
                            <h2>{t("vpn.recents")}</h2>
                            <ul>
                                {recent.map((node) => (
                                    <ServerRow
                                        key={node.id}
                                        node={node}
                                        title={places.placeOf(node, t.locale) ?? label(node)}
                                        sub={places.placeOf(node, t.locale) ? label(node) : null}
                                        flag
                                        current={node.id === state.active?.nodeId}
                                        busy={busy || held}
                                        reason={node.browser ? null : reason(node)}
                                        onConnect={() => connect(node)}
                                    />
                                ))}
                            </ul>
                        </>
                    ) : null}
                    <h2>{t("vpn.allPlaces")}</h2>
                    {shown.length === 0 ? (
                        <p className="vpn-empty muted small">
                            {t("vpn.noMatch", { query: query.trim() })}
                        </p>
                    ) : (
                        <ul>
                            {shown.map((country) => {
                                const key = country.code ?? "-";
                                const expanded = searching || open.has(key);
                                const pick = places.randomPick(
                                    country.nodes,
                                    state.active?.nodeId ?? null
                                );
                                const here = country.nodes.some(
                                    (node) => node.id === state.active?.nodeId
                                );
                                const count = t("vpn.servers", { count: country.nodes.length });
                                return (
                                    <li key={key} className="vpn-country-row">
                                        <div className="vpn-country">
                                            <button
                                                className="vpn-pick"
                                                aria-disabled={
                                                    busy ||
                                                    held ||
                                                    country.usable === 0 ||
                                                    undefined
                                                }
                                                title={
                                                    pick
                                                        ? t("vpn.connectTo", { name: country.name })
                                                        : here
                                                          ? t("vpn.inUse")
                                                          : t("vpn.noneUsable")
                                                }
                                                onClick={() =>
                                                    !busy &&
                                                    !held &&
                                                    pick &&
                                                    connect(pick, (failed) =>
                                                        places.randomPick(
                                                            country.nodes.filter(
                                                                (node) => node.id !== failed.id
                                                            ),
                                                            state.active?.nodeId ?? null
                                                        )
                                                    )
                                                }
                                            >
                                                <Flag code={country.code} />
                                                <span className="vpn-text">
                                                    <span className="vpn-name" title={country.name}>
                                                        {country.name}
                                                    </span>
                                                    <span className="muted small vpn-name">
                                                        {country.usable === country.nodes.length
                                                            ? count
                                                            : t("vpn.usableOf", {
                                                                  count: country.usable,
                                                                  total: country.nodes.length
                                                              })}
                                                    </span>
                                                </span>
                                                {here ? (
                                                    <span className="badge">{t("vpn.inUse")}</span>
                                                ) : null}
                                            </button>
                                            <button
                                                className="icon vpn-expand"
                                                aria-expanded={expanded}
                                                aria-label={t("vpn.showServers", {
                                                    country: country.name
                                                })}
                                                title={t("vpn.showServers", {
                                                    country: country.name
                                                })}
                                                onClick={() => toggle(key)}
                                            >
                                                <svg viewBox="0 0 24 24" aria-hidden="true">
                                                    <path
                                                        d={
                                                            expanded
                                                                ? "m6 15 6-6 6 6"
                                                                : "m6 9 6 6 6-6"
                                                        }
                                                    />
                                                </svg>
                                            </button>
                                        </div>
                                        {expanded ? (
                                            <ul className="vpn-cities">
                                                {country.nodes.map((node) => (
                                                    <ServerRow
                                                        key={node.id}
                                                        node={node}
                                                        title={node.city ?? label(node)}
                                                        sub={node.city ? label(node) : null}
                                                        current={node.id === state.active?.nodeId}
                                                        busy={busy || held}
                                                        reason={node.browser ? null : reason(node)}
                                                        onConnect={() => connect(node)}
                                                    />
                                                ))}
                                            </ul>
                                        ) : null}
                                    </li>
                                );
                            })}
                        </ul>
                    )}
                </>
            )}

            {state.webRtcGuard === null ? null : (
                <section>
                    <h2>{t("vpn.privacy")}</h2>
                    <div className="vpn-setting">
                        <Choice
                            label={t("vpn.webRtcGuard")}
                            value={state.webRtcGuard ? "on" : "off"}
                            options={[
                                { value: "on", label: t("settings.on") },
                                { value: "off", label: t("settings.off") }
                            ]}
                            hint={t(state.webRtcGuard ? "vpn.webRtcOnHint" : "vpn.webRtcOffHint")}
                            onChange={(value) => turnWebRtc(value === "on")}
                        />
                        {guardError ? (
                            <p className="vpn-note small" role="alert">
                                {guardError}
                            </p>
                        ) : null}
                    </div>
                </section>
            )}
        </main>
    );
}

/** "Connected for 12 min", moved on each minute while the popup is open. */
function ConnectedFor({ since }: { since: number }): React.JSX.Element | null {
    const t = useWords();
    const [now, setNow] = useState(Date.now);
    useEffect(() => {
        // The next tick lands when the count changes, not a minute after opening.
        const wait = 60_000 - ((now - since) % 60_000);
        const timer = window.setTimeout(() => setNow(Date.now()), Math.max(1_000, wait));
        return () => window.clearTimeout(timer);
    }, [now, since]);
    const minutes = places.elapsedMinutes(since, now);
    if (minutes === null) return null;
    const text =
        minutes < 1
            ? t("vpn.connectedJustNow")
            : t("vpn.connectedFor", { duration: places.formatElapsed(minutes, t.locale) });
    return (
        <span className="vpn-since muted small" title={text}>
            {text}
        </span>
    );
}

/** One server: pressing it connects there. Not usable says why, under its name. */
function ServerRow({
    node,
    title,
    sub,
    flag,
    current,
    busy,
    reason,
    onConnect
}: {
    node: VpnNode;
    title: string;
    sub: string | null;
    flag?: boolean;
    current: boolean;
    busy: boolean;
    reason: string | null;
    onConnect: () => void;
}): React.JSX.Element {
    const t = useWords();
    // The server in use is not greyed out: it is the one that is working.
    const blocked = busy || reason !== null;
    return (
        <li className="vpn-server-row">
            <button
                className="vpn-pick"
                aria-disabled={blocked || undefined}
                aria-current={current || undefined}
                title={reason ?? (current ? t("vpn.inUse") : t("vpn.connectTo", { name: title }))}
                onClick={() => !blocked && !current && onConnect()}
            >
                {flag ? <Flag code={node.country} /> : null}
                <span className="vpn-text">
                    <span className="vpn-name" title={title}>
                        {title}
                    </span>
                    {sub ? (
                        <span className="muted small vpn-name" title={sub}>
                            {sub}
                        </span>
                    ) : null}
                    {reason ? <span className="muted small vpn-reason">{reason}</span> : null}
                </span>
                {current ? <span className="badge">{t("vpn.inUse")}</span> : null}
                {reason ? <span className="badge muted">{t("vpn.unavailable")}</span> : null}
            </button>
        </li>
    );
}

/** The screen's shape while the list is asked for, or why it could not be. */
function PanelSkeleton({
    failed,
    onRetry
}: {
    failed: boolean;
    onRetry: () => void;
}): React.JSX.Element {
    const t = useWords();
    if (failed)
        return (
            <main className="vpn">
                <div className="vpn-error" role="alert">
                    <span className="small">{t("vpn.loadFailed")}</span>
                    <button className="ghost" onClick={onRetry}>
                        {t("vpn.tryAgain")}
                    </button>
                </div>
            </main>
        );
    return (
        <main className="vpn" aria-busy="true" aria-label={t("vpn.loading")}>
            <div className="vpn-hero">
                <div className="vpn-status">
                    <span className="vpn-bone flag" />
                    <span className="vpn-status-text">
                        <span className="vpn-bone line" />
                        <span className="vpn-bone line short" />
                    </span>
                </div>
                <span className="vpn-bone button" />
            </div>
            <div className="vpn-search">
                <span className="vpn-bone field" />
            </div>
            {[0, 1, 2, 3].map((index) => (
                <div key={index} className="vpn-country vpn-bone-row">
                    <span className="vpn-bone flag-small" />
                    <span className="vpn-status-text">
                        <span className="vpn-bone line" />
                        <span className="vpn-bone line short" />
                    </span>
                </div>
            ))}
        </main>
    );
}
