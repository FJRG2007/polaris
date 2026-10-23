/**
 * Polar beside the page.
 *
 * The chat itself is the deployment's `/polar/embed` in a frame - the same
 * component the dashboard draws, so it looks and behaves as Polaris does and
 * moves with every dashboard update. This draws only what the extension owns:
 * the one-line question about the page in front, which is where a site is
 * allowed (a browser asks for a site's access only from a click in an
 * extension page, never from inside a frame), and the states before there is a
 * Polaris to show.
 */

import { storage } from "#imports";
import { useWords } from "../popup/words";
import { originsOf } from "../popup/polar-row";
import * as polar from "@/lib/polar-panel";
import * as offline from "@/lib/polar-offline";
import { DraftOffer, OfflineView } from "./offline";
import { askBackground } from "@/lib/messages";
import { useCallback, useEffect, useRef, useState } from "react";

/** Sites somebody allowed Polar to read, by origin. */
const ALLOWED_SITES = storage.defineItem<string[]>("local:polar.sites", { fallback: [] });

type PanelPort = ReturnType<typeof browser.runtime.connect>;

/** Whose conversation this panel shows: chosen in the popup's settings. */
const CHAT_SCOPE = storage.defineItem<polar.ChatScope>(polar.CHAT_SCOPE_KEY, {
    fallback: "shared"
});

/**
 * The Polaris the last panel showed. A panel opens on it straight away while the
 * worker is asked again and the server is checked, instead of drawing nothing
 * until both answer: the chat frame is most of the wait, and it starts loading
 * the moment it has an address.
 */
const LAST_SERVER = storage.defineItem<string | null>("local:polar.lastServer", {
    fallback: null
});

/** How long a page read stays good for another hand-over to the frame. Opening
 *  the panel hands the page over up to three times in a second (the tab in
 *  front, the frame loading, the chat saying it is listening), and a read is
 *  the whole page's text - a layout of all of it, mid-animation, each time. */
const PAGE_READ_MS = 1_500;

/** This browser run's mark, made by the first panel to open in it. */
const BROWSER_RUN = storage.defineItem<string | null>(polar.BROWSER_RUN_KEY, { fallback: null });

async function browserRun(): Promise<string> {
    const kept = await BROWSER_RUN.getValue();
    if (kept) return kept;
    const made = polar.newBrowserRun();
    await BROWSER_RUN.setValue(made);
    return made;
}

/** The tab this panel is the tab's own panel for, or null for the shared one. */
const OWN_TAB = ((): number | null => {
    const raw = new URLSearchParams(location.search).get("tab");
    const id = raw === null ? Number.NaN : Number(raw);
    return Number.isInteger(id) ? id : null;
})();

/**
 * The port that tells the worker this panel is open - and where - for as long
 * as it is: a shortcut pressed while it is open closes it. The worker can be
 * recycled under it, which drops the port, so it is made again. Messages from
 * the worker arrive through `onMessage`.
 */
function holdPort(
    onMessage: (message: polar.PanelMessage) => void,
    onPort: (port: PanelPort | null) => void
): () => void {
    let port: PanelPort | null = null;
    let stopped = false;
    let timer: ReturnType<typeof setTimeout> | undefined;
    const connect = async (): Promise<void> => {
        if (stopped) return;
        const here = await browser.windows?.getCurrent?.().catch(() => undefined);
        port = browser.runtime.connect({ name: polar.PANEL_PORT });
        onPort(port);
        port.onMessage.addListener((message) => onMessage(message as polar.PanelMessage));
        port.onDisconnect.addListener(() => {
            port = null;
            onPort(null);
            if (!stopped) timer = setTimeout(() => void connect(), 1000);
        });
        port.postMessage({ kind: "hello", windowId: here?.id ?? null, tabId: OWN_TAB });
    };
    void connect();
    return () => {
        stopped = true;
        clearTimeout(timer);
        port?.disconnect();
    };
}

const WEB_PAGES = ["https://*/*", "http://*/*"];

/** How often an open chat checks that Polaris still answers, ms. */
const HEALTH_MS = 30_000;

interface Connection {
    readonly origin: string | null;
    /** The account connected on it, which is whose copy and draft are shown. */
    readonly account: string | null;
}

/** The Polaris this browser is connected to, and as whom. */
async function polarisConnection(): Promise<Connection> {
    const reply = await askBackground({ kind: "status" });
    if (!reply.ok || !("status" in reply)) return { origin: null, account: null };
    return {
        origin: reply.status.server,
        account: reply.status.linkedAccount?.id ?? null
    };
}

async function isUp(origin: string): Promise<boolean> {
    try {
        const answer = await fetch(new URL("/api/health", origin), {
            credentials: "omit",
            cache: "no-store"
        });
        return answer.status < 500;
    } catch {
        return false;
    }
}

async function findPolaris(): Promise<Connection & { up: boolean }> {
    const found = await polarisConnection();
    return { ...found, up: found.origin ? await isUp(found.origin) : false };
}

type Reach = "asking" | "none" | "offline" | "ready";

interface Front {
    readonly tabId: number | null;
    /** The tab's site, or null for a page that is not a web page. */
    readonly site: string | null;
    /** False when the browser does not tell this extension the tab's address. */
    readonly known: boolean;
}

const NO_FRONT: Front = { tabId: null, site: null, known: true };

/** Reads the page inside the tab, the way each browser lets an extension. */
async function readTab(tabId: number): Promise<polar.SharedPage | null> {
    try {
        const scripting = (browser as unknown as { scripting?: typeof browser.scripting })
            .scripting;
        if (scripting?.executeScript) {
            const [first] = await scripting.executeScript({
                target: { tabId },
                func: polar.readPageInTab
            });
            return polar.trimPage((first?.result ?? {}) as Record<string, unknown>);
        }
        // Manifest v2 (Firefox): no `scripting`, the older call with the same
        // function, serialized.
        const tabs = browser.tabs as unknown as {
            executeScript(id: number, details: { code: string }): Promise<unknown[]>;
        };
        const [result] = await tabs.executeScript(tabId, {
            code: `(${polar.readPageInTab.toString()})()`
        });
        return polar.trimPage((result ?? {}) as Record<string, unknown>);
    } catch {
        // A page the browser keeps extensions out of (its store, a PDF viewer).
        return null;
    }
}

export function Panel(): React.JSX.Element {
    const t = useWords();
    const [server, setServer] = useState<string | null>(null);
    const [account, setAccount] = useState<string | null>(null);
    const [reach, setReach] = useState<Reach>("asking");
    const [front, setFront] = useState<Front>(NO_FRONT);
    const [allowed, setAllowed] = useState<string[]>([]);
    const [dismissed, setDismissed] = useState<string | null>(null);
    const [chatScope, setChatScope] = useState<polar.ChatScope | null>(null);
    const [run, setRun] = useState<string | null>(null);
    /** The last copy of the chats, the draft typed while down, and since when. */
    const [kept, setKept] = useState<offline.Kept | null>(null);
    const [draft, setDraft] = useState("");
    const [downSince, setDownSince] = useState<number | null>(null);
    const frame = useRef<HTMLIFrameElement>(null);
    /** A question from a right-click, held until the chat in the frame is ready. */
    const waiting = useRef<polar.PolarAsk | null>(null);
    /** The draft handed to the chat, cleared from storage once it is posted. */
    const offered = useRef<polar.PolarAsk | null>(null);
    /** Copies written one after another, so two close together keep both. */
    const saving = useRef<Promise<void>>(Promise.resolve());
    /** The frame whose chat has said it is listening. */
    const listening = useRef<Window | null>(null);
    const portRef = useRef<PanelPort | null>(null);
    /** Checked once: opened on a Polaris tab, this panel hands over and closes. */
    const checked = useRef(false);

    useEffect(() => {
        void CHAT_SCOPE.getValue().then((scope) => setChatScope(polar.readChatScope(scope)));
        return CHAT_SCOPE.watch((scope) => setChatScope(polar.readChatScope(scope)));
    }, []);

    useEffect(() => {
        void browserRun()
            .catch(() => polar.newBrowserRun())
            .then(setRun);
    }, []);

    const deliver = useCallback(() => {
        const target = frame.current?.contentWindow;
        const ask = waiting.current;
        if (!target || !server || !ask || target !== listening.current) return;
        target.postMessage(polar.askMessage(ask), new URL(server).origin);
        waiting.current = null;
        if (ask !== offered.current) return;
        offered.current = null;
        if (account) void storage.removeItem(offline.draftKey(server, account));
    }, [server, account]);

    useEffect(
        () =>
            holdPort(
                (message) => {
                    if (message.kind === "close") window.close();
                    else if (message.kind === "ask") {
                        waiting.current = { quote: message.quote, draft: message.draft };
                        deliver();
                    }
                },
                (port) => (portRef.current = port)
            ),
        [deliver]
    );

    const connect = useCallback(async () => {
        setReach("asking");
        const kept = await LAST_SERVER.getValue().catch(() => null);
        if (kept) {
            setServer(kept);
            setReach("ready");
        }
        const { origin, account } = await polarisConnection();
        setServer(origin);
        setAccount(account);
        void LAST_SERVER.setValue(origin).catch(() => undefined);
        if (!origin) return setReach("none");
        // The chat loads now; the health check only says whether it is down.
        setReach("ready");
        const up = await isUp(origin);
        setReach(up ? "ready" : "offline");
        setDownSince((before) => (up ? null : (before ?? Date.now())));
    }, []);

    // The copy of this Polaris and the draft of its account, read once known.
    useEffect(() => {
        if (!server) return;
        void storage
            .getItem<unknown>(offline.keptKey(server))
            .then((value) => setKept(offline.readKept(value)));
        if (!account) return setDraft("");
        void storage
            .getItem<string>(offline.draftKey(server, account))
            .then((value) => setDraft(typeof value === "string" ? value : ""));
    }, [server, account]);

    const writeDraft = useCallback(
        (text: string) => {
            setDraft(text);
            if (!server || !account) return;
            const key = offline.draftKey(server, account);
            void (text.trim() ? storage.setItem(key, text) : storage.removeItem(key));
        },
        [server, account]
    );

    // A chat already open whose Polaris stops answering turns to the copy.
    useEffect(() => {
        if (reach !== "ready" || !server) return;
        let stopped = false;
        const timer = setInterval(() => {
            if (document.hidden) return;
            void isUp(server).then((up) => {
                if (up || stopped) return;
                setReach("offline");
                setDownSince((before) => before ?? Date.now());
            });
        }, HEALTH_MS);
        return () => {
            stopped = true;
            clearInterval(timer);
        };
    }, [reach, server]);

    useEffect(() => {
        void connect();
        void ALLOWED_SITES.getValue().then(setAllowed);
        return ALLOWED_SITES.watch((next) => setAllowed(next ?? []));
    }, [connect]);

    const lastRead = useRef<{
        tabId: number;
        at: number;
        page: Promise<polar.SharedPage | null>;
    } | null>(null);

    // Which page is in front, followed as the person moves around.
    const look = useCallback(async () => {
        const [tab] = await browser.tabs.query({ active: true, currentWindow: true });
        if (!tab?.id) return setFront(NO_FRONT);
        // Opened on a Polaris tab - by a press the worker had not yet read the
        // deployments for - this is a second copy of the page's own Polar: hand
        // the press to it and close. Only on opening; a panel somebody already
        // has open stays open as they move between tabs.
        if (!checked.current && server) {
            checked.current = true;
            const origins = await askBackground({ kind: "status" }).then((reply) =>
                reply.ok && "status" in reply ? originsOf(reply.status) : [server]
            );
            if (polar.isPolarisTab(tab.url, origins)) {
                portRef.current?.postMessage({ kind: "bounce", tabId: tab.id });
                // Let the message leave before the page goes.
                setTimeout(() => window.close(), 100);
                return;
            }
        }
        setFront({
            tabId: tab.id,
            site: polar.siteOf(tab.url, server),
            known: typeof tab.url === "string"
        });
    }, [server]);

    useEffect(() => {
        void look();
        const onActivated = (): void => void look();
        const onUpdated = (_id: number, change: { status?: string; url?: string }): void => {
            if (change.status !== "complete" && !change.url) return;
            lastRead.current = null;
            void look();
        };
        browser.tabs.onActivated.addListener(onActivated);
        browser.tabs.onUpdated.addListener(onUpdated);
        browser.windows?.onFocusChanged?.addListener(onActivated);
        return () => {
            browser.tabs.onActivated.removeListener(onActivated);
            browser.tabs.onUpdated.removeListener(onUpdated);
            browser.windows?.onFocusChanged?.removeListener(onActivated);
        };
    }, [look]);

    const shared = front.site !== null && allowed.includes(front.site);
    const readFront = useCallback((tabId: number): Promise<polar.SharedPage | null> => {
        const held = lastRead.current;
        if (held && held.tabId === tabId && Date.now() - held.at < PAGE_READ_MS) return held.page;
        const page = readTab(tabId);
        lastRead.current = { tabId, at: Date.now(), page };
        return page;
    }, []);

    // Hand the page to the frame - or nothing, for a site not allowed - and
    // only ever to the deployment's origin.
    const send = useCallback(async () => {
        const target = frame.current?.contentWindow;
        if (!target || !server) return;
        const page = shared && front.tabId !== null ? await readFront(front.tabId) : null;
        // Read from a tab that has since moved to another site: not this one's.
        const still = page && polar.siteOf(page.url, server) === front.site ? page : null;
        target.postMessage(polar.pageMessage(still), new URL(server).origin);
    }, [front, shared, server, readFront]);

    useEffect(() => {
        void send();
    }, [send]);

    useEffect(() => {
        if (!server) return;
        const onMessage = (event: MessageEvent): void => {
            const snapshot = offline.snapshotFrom(event, frame.current?.contentWindow, server);
            if (snapshot) {
                const key = offline.keptKey(server);
                saving.current = saving.current
                    .then(async () => {
                        const next = offline.remember(
                            offline.readKept(await storage.getItem<unknown>(key)),
                            snapshot.account,
                            snapshot.conversation
                        );
                        await storage.setItem(key, next);
                        setKept(next);
                    })
                    .catch(() => undefined);
                return;
            }
            if (!polar.isRefresh(event, frame.current?.contentWindow, server)) return;
            listening.current = frame.current?.contentWindow ?? null;
            void send();
            // The chat is listening now: a question waiting for it goes in.
            deliver();
        };
        window.addEventListener("message", onMessage);
        return () => window.removeEventListener("message", onMessage);
    }, [send, server, deliver]);

    // The browser's own question first, inside this click: an await before it
    // and the browser refuses to ask at all.
    const allow = (): void => {
        const site = front.site;
        const origins = site ? [`${site}/*`] : WEB_PAGES;
        void browser.permissions
            .request({ origins })
            .then(async (granted) => {
                if (!granted) return;
                if (site) await ALLOWED_SITES.setValue([...new Set([...allowed, site])]);
                await look();
            })
            .catch(() => undefined);
    };

    const stop = (): void => {
        if (!front.site) return;
        void ALLOWED_SITES.setValue(allowed.filter((site) => site !== front.site));
    };

    if (reach === "asking" || chatScope === null || run === null)
        return <div className="side-app" />;
    if (reach === "none" || !server) {
        return (
            <div className="side-app">
                <div className="side-empty">
                    <p>{t("polar.connectFirst")}</p>
                </div>
            </div>
        );
    }
    if (reach === "offline") {
        // The copy is the last account's to use Polar here: only that one sees it.
        return (
            <OfflineView
                kept={offline.keptFor(kept, account)}
                since={downSince ?? Date.now()}
                draft={draft}
                onDraft={writeDraft}
                probe={async () => {
                    const found = await findPolaris();
                    if (found.up && found.origin) {
                        setServer(found.origin);
                        setAccount(found.account);
                    }
                    return found.up;
                }}
                onBack={() => {
                    setDownSince(null);
                    setReach("ready");
                }}
            />
        );
    }

    const host = front.site ? new URL(front.site).host : null;
    // A tab whose address this browser keeps from the extension: one question
    // for web pages in general, then the site-by-site one.
    const askAny = !front.known && front.tabId !== null;
    return (
        <div className="side-app">
            {askAny ? (
                <div className="side-bar" role="region" aria-label={t("polar.title")}>
                    <span className="grow">{t("polar.askAny")}</span>
                    <button onClick={allow}>{t("polar.allowAny")}</button>
                </div>
            ) : host && !shared && dismissed !== front.site ? (
                <div className="side-bar" role="region" aria-label={t("polar.title")}>
                    <span className="grow" title={host}>
                        {t("polar.askSite", { site: host })}
                    </span>
                    <button onClick={allow}>{t("polar.allow")}</button>
                    <button className="ghost" onClick={() => setDismissed(front.site)}>
                        {t("polar.notNow")}
                    </button>
                </div>
            ) : host && shared ? (
                <div className="side-bar" role="status">
                    <span className="grow" title={host}>
                        {t("polar.reading", { site: host })}
                    </span>
                    <button className="ghost" onClick={stop}>
                        {t("polar.stop")}
                    </button>
                </div>
            ) : null}
            {draft.trim() ? (
                <DraftOffer
                    onUse={() => {
                        // Into the composer, for the person to read and send.
                        const ask = { draft: draft.trim() };
                        waiting.current = ask;
                        offered.current = ask;
                        setDraft("");
                        deliver();
                    }}
                    onDiscard={() => writeDraft("")}
                />
            ) : null}
            <iframe
                // A conversation per tab is a frame per tab: a new tab in front
                // is that tab's chat, opened where it was left.
                key={polar.chatScopeFor(chatScope, OWN_TAB ?? front.tabId, run) ?? "shared"}
                ref={frame}
                className="side-frame"
                title={t("polar.title")}
                src={polar.embedUrl(
                    server,
                    new URL(browser.runtime.getURL("/")).origin,
                    polar.chatScopeFor(chatScope, OWN_TAB ?? front.tabId, run)
                )}
                onLoad={() => void send()}
                allow="microphone; clipboard-write"
            />
        </div>
    );
}
