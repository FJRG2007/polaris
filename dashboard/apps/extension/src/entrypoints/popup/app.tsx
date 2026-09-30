import { storage } from "#imports";
import { screenFor } from "@/lib/screen";
import { timeoutChoices } from "@/lib/lock";
import { EVERY_SITE } from "@/lib/injection";
import { readIntendedLogin } from "@/lib/save";
import type { UpdateNotice } from "@/lib/update";
import { looksLikeAddress, readOrigin } from "@/lib/address";
import { accountHost, describeAccount } from "@/lib/accounts";
import { GeneratorPanel } from "./generator";
import { CheckMark, CopyMark } from "./marks";
import { ServersFold, ServersPanel } from "./servers";
import {
    detectOs,
    installLine,
    installShell,
    repoFromReleaseUrl
} from "@polaris/core/extension-install";
import { Home, SectionBar, TopBar, useSection } from "./shell";
import { useWords } from "./words";
import type { Words } from "@/lib/words";
import { useCallback, useEffect, useRef, useState } from "react";
import { askBackground, type ItemSummary, type Request, type VaultStatus } from "@/lib/messages";
// The subpath rather than the package: `@polaris/core` is a barrel over the whole
// product's domain logic, and pulling it in for one function put a quarter of a
// megabyte of zod schemas, CIDR arithmetic and camera geometry into a popup that
// draws six buttons.
import { generatePassword } from "@polaris/core/password-generator";
import {
    GENERATOR_DEFAULTS,
    GENERATOR_KEY,
    readGeneratorOptions,
    sameOptions,
    type GeneratorOptions
} from "@/lib/generator";

/**
 * The popup, which is four screens and knows nothing.
 *
 * Every decision is the worker's: which items match, whether this page may be
 * filled, whether a password opens the vault. This draws what it is told and
 * sends what was pressed. It holds one secret for a few seconds at a time - a
 * value on its way to the clipboard - and clears it after.
 *
 * The screens are the states of the vault rather than a navigation: which Polaris
 * (no server yet), who (no session), the master password (locked), and the items
 * (open). Somebody who has used it before opens it on the last of those.
 */

/**
 * How long a copied password stays on the clipboard, for as long as this popup
 * is the thing holding the timer.
 *
 * Which is only while it is open. A browser action popup is torn down the moment
 * it loses focus, and its timers go with it, so this cannot be promised past
 * that - and the line it puts on screen says so rather than claiming a clearance
 * nobody is left to perform. Moving it somewhere that outlives the popup means
 * the worker, and a worker has no document to write a clipboard from.
 */
const CLEAR_AFTER_MS = 30_000;

/**
 * Which copy was just acknowledged, for the check mark that replaces the copy
 * mark - the same acknowledgement Polaris gives. Set only once the clipboard
 * write has actually happened, so a check never stands for a copy that failed.
 */
function useCopied(): [string | null, (key: string) => void] {
    const [copied, setCopied] = useState<string | null>(null);
    const timer = useRef<number | null>(null);
    useEffect(
        () => () => {
            if (timer.current !== null) window.clearTimeout(timer.current);
        },
        []
    );
    const mark = useCallback((key: string) => {
        setCopied(key);
        if (timer.current !== null) window.clearTimeout(timer.current);
        timer.current = window.setTimeout(() => setCopied(null), COPIED_MS);
    }, []);
    return [copied, mark];
}

/** How long the check mark stays after a copy. */
const COPIED_MS = 1500;

function useStatus(): [VaultStatus | null, () => Promise<void>] {
    const [status, setStatus] = useState<VaultStatus | null>(null);
    const read = useCallback(async () => {
        const reply = await askBackground({ kind: "status" });
        if ("status" in reply && reply.ok) setStatus(reply.status);
    }, []);
    useEffect(() => {
        void read();
    }, [read]);
    return [status, read];
}

/** What the worker's last check found, if it found anything - and a newer
 *  version already on disk, waiting to be started. */
function useUpdate(): { notice: UpdateNotice | null; pending: string | null } {
    const [state, setState] = useState<{ notice: UpdateNotice | null; pending: string | null }>({
        notice: null,
        pending: null
    });
    useEffect(() => {
        void (async () => {
            const reply = await askBackground({ kind: "updateStatus" });
            if (reply.ok && "update" in reply)
                setState({ notice: reply.update, pending: reply.pending });
        })();
    }, []);
    return state;
}

/**
 * The one thing this popup says without being asked.
 *
 * What it says depends on how this copy got here, because the readers have
 * nothing to do with each other:
 *
 * - A newer version already on disk, put there by the install script's updater,
 *   starts by itself at the next safe moment (`lib/self-update.ts`). Said, with
 *   the way to start it now and what that costs.
 * - A store install, and a copy the updater keeps current, are updated for
 *   them: there is nothing to do, and saying so is the whole message.
 * - A Chromium copy loaded by hand, or by the script before it set up the
 *   updater, updates never - until the one line is run once. So that line is
 *   shown, for this system, with a copy button.
 * - Firefox has no updater at all: its temporary add-on is gone when Firefox
 *   closes. It keeps pointing at the steps.
 */
function UpdateBanner({
    notice,
    pending,
    server
}: {
    notice: UpdateNotice | null;
    pending: string | null;
    server: string | null;
}): React.JSX.Element | null {
    const t = useWords();
    const [copied, mark] = useCopied();
    const [starting, setStarting] = useState(false);

    if (pending) {
        return (
            <div className="notice small">
                <p>{t("popup.update.ready", { version: pending })}</p>
                <button
                    className="ghost notice-act"
                    disabled={starting}
                    onClick={() => {
                        setStarting(true);
                        void askBackground({ kind: "restartNow" }).then(() => window.close());
                    }}
                >
                    {t("popup.update.startNow")}
                </button>
                <p className="muted">{t("popup.update.startNowHint")}</p>
            </div>
        );
    }
    if (!notice) return null;
    if (notice.kind === "store") {
        return (
            <div className="notice small">
                {t("popup.update.store", { version: notice.version })}
            </div>
        );
    }
    if (notice.kind === "auto") {
        return (
            <div className="notice small">
                {t("popup.update.auto", { version: notice.version })}
            </div>
        );
    }
    const repo = repoFromReleaseUrl(notice.url);
    if (import.meta.env.BROWSER !== "firefox" && repo) {
        const os = detectOs(navigator.userAgent);
        const line = installLine(os, repo);
        return (
            <div className="notice small">
                <p>
                    {t("popup.update.runOnce", {
                        version: notice.version,
                        shell: installShell(os)
                    })}
                </p>
                <div className="install-line">
                    <code>{line}</code>
                    <button
                        className={copied === "line" ? "icon copied" : "icon"}
                        aria-label={t("popup.update.copyLine")}
                        title={
                            copied === "line" ? t("generator.copied") : t("popup.update.copyLine")
                        }
                        onClick={() =>
                            void navigator.clipboard.writeText(line).then(() => mark("line"))
                        }
                    >
                        {copied === "line" ? <CheckMark /> : <CopyMark />}
                    </button>
                </div>
            </div>
        );
    }
    return (
        <div className="notice small">
            {t.rich("popup.update.byHand", {
                version: notice.version,
                link: (chunks) => (
                    <a
                        key="link"
                        href={server ? `${server}/account/downloads` : notice.url}
                        target="_blank"
                        rel="noreferrer"
                    >
                        {chunks}
                    </a>
                ),
                where: server ? "polaris" : "changes"
            })}
        </div>
    );
}

export function App(): React.JSX.Element {
    const t = useWords();
    const [status, refresh] = useStatus();
    const { notice: update, pending } = useUpdate();
    const [section, setSection] = useSection();
    /**
     * Asking Polaris to let this browser in, from the locked screen.
     *
     * The master password is one way past a locked vault and it is not always
     * the one that works: a vault whose keys this browser is no longer holding
     * refuses every password there is, and so does an extension too old to run
     * the derivation the account was moved to. Both used to end at a password
     * field with nothing else on the screen, which reads as a forgotten master
     * password - the one thing nobody can help with. The approval is the other
     * way in and it was already built; this only makes it reachable from the
     * screen where somebody is stuck.
     */
    const [way, setWay] = useState<"either" | "approval" | "password">("either");
    const askPolaris = useCallback(() => setWay("approval"), []);
    const askPassword = useCallback(() => setWay("password"), []);

    // Nothing at all until the worker has answered: a popup that flashed the
    // sign-in screen at somebody whose vault is open would be lying for a frame.
    if (!status) return <main className="pad" />;

    const shown = screenFor(status);
    // Asked for, or found waiting. The second is what a popup reopened in the
    // middle of an approval lands on: the worker is still holding the request,
    // and this is the screen that can show its code. Saying so explicitly is what
    // makes the way back work - a request still in flight would otherwise send
    // somebody straight back to it the moment they left.
    const onApproval = way === "approval" || (way === "either" && status.awaitingApproval);

    // Before the account: which Polaris, then connecting this browser to it. The
    // accounts line stays under these, because adding a second account is exactly
    // when somebody needs the way back to the first.
    if (shown === "server" || shown === "link" || !status.server) {
        return (
            <div className="app">
                <UpdateBanner notice={update} pending={pending} server={status.server} />
                {shown === "link" && status.server ? (
                    <LinkPolaris server={status.server} onDone={refresh} />
                ) : (
                    <Connect onDone={refresh} />
                )}
                <Accounts status={status} onChange={refresh} />
                <ServersFold status={status} onChange={refresh} />
            </div>
        );
    }

    // Connected: the frame, and either the home screen or the section open in it.
    return (
        <div className="app">
            <UpdateBanner notice={update} pending={pending} server={status.server} />
            <TopBar status={status} onChange={refresh} onOpen={setSection} />
            {section === "home" ? (
                <Home status={status} onOpen={setSection} />
            ) : section === "servers" ? (
                <>
                    <SectionBar title={t("shell.servers")} onBack={() => setSection("home")} />
                    <main>
                        <ServersPanel status={status} onChange={refresh} />
                    </main>
                </>
            ) : (
                <>
                    <SectionBar title={t("shell.vault")} onBack={() => setSection("home")} />
                    {shown === "signIn" || (shown === "unlock" && onApproval) ? (
                        <SignIn
                            server={status.server}
                            connected={status.connected}
                            canVault={status.canVault}
                            onDone={async () => {
                                setWay("either");
                                await refresh();
                            }}
                            // Only from the locked screen, where the password is
                            // still there to go back to. On the sign-in screen
                            // proper there is nothing behind it.
                            onBack={shown === "unlock" ? askPassword : undefined}
                        />
                    ) : shown === "unlock" ? (
                        <Unlock onDone={refresh} onApprove={askPolaris} />
                    ) : (
                        <Items status={status} onChange={refresh} />
                    )}
                    {/* Making a password needs no vault: it is arithmetic in this
                        popup, the same generator the item list offers. Somebody
                        signing up for something with their vault locked is exactly
                        who wants one, and sending them through a master password
                        first to reach a local random number was a lock on a door
                        with no room behind it. Over the list it is the one inside
                        `Items`, which can also hand the value to the save form;
                        here there is no form to hand it to. */}
                    {shown === "signIn" || shown === "unlock" ? <Generator /> : null}
                </>
            )}
        </div>
    );
}

function Problem({ text }: { text: string | null }): React.JSX.Element | null {
    return text ? <p className="problem">{text}</p> : null;
}

function Connect({ onDone }: { onDone: () => Promise<void> }): React.JSX.Element {
    const t = useWords();
    const [typed, setTyped] = useState("");
    const [error, setError] = useState<string | null>(null);
    const [asking, setAsking] = useState(false);
    // Not "is it non-empty": one letter is a URL the moment a scheme goes in
    // front of it, so the button went live on the first keystroke and pressing
    // it spent the one prompt a gesture is good for on a host that cannot exist.
    const usable = looksLikeAddress(typed);

    const connect = async (): Promise<void> => {
        const origin = readOrigin(typed);
        if (!origin) {
            setError(t("errors.notAnAddress"));
            return;
        }
        setAsking(true);
        setError(null);

        // Asked here, inside the handler, and that is the whole point: a browser
        // refuses a permission request that did not come from a user gesture, and
        // the worker this used to be sent to has none. It failed with "This
        // function must be called during a user gesture", which reached the
        // screen as "Something went wrong." on a perfectly good address.
        let granted = false;
        try {
            granted = await browser.permissions.request({ origins: [`${origin}/*`] });
        } catch {
            granted = false;
        }
        if (!granted) {
            setAsking(false);
            setError(t("errors.noPermission"));
            return;
        }

        const reply = await askBackground({ kind: "connect", typed });
        setAsking(false);
        if (!reply.ok) {
            setError(reply.error);
            return;
        }
        await onDone();
    };

    return (
        <main className="pad">
            {/* i18n-ignore the product's name */}
            <h1>Polaris</h1>
            <p className="muted">{t("popup.connect.hint")}</p>
            <input
                autoFocus
                value={typed}
                // i18n-ignore an example address, the same in every language
                placeholder="polaris.example.com"
                onChange={(event) => setTyped(event.target.value)}
                onKeyDown={(event) => event.key === "Enter" && void connect()}
            />
            <Problem text={error} />
            {/* `usable`, not "something was typed". The permission prompt is the
                thing being protected: a browser grants one per gesture, and a
                button that lights up on the first keystroke spends it on a host
                that cannot exist - after which the reader is left with a refusal
                and no way to tell it from a real one. */}
            <button disabled={asking || !usable} onClick={() => void connect()}>
                {asking ? t("popup.connect.asking") : t("popup.connect.continue")}
            </button>
            <p className="muted small">{t("popup.connect.permission")}</p>
        </main>
    );
}

/**
 * Connecting this browser to Polaris.
 *
 * The extension's first step and the only one that needs a person. It shows a
 * short code, opens the page in Polaris that decides, and waits - in the worker,
 * because opening that tab is what closes this popup.
 *
 * Nothing is typed here and no password ever is: what approves this is somebody
 * already signed in to Polaris, in a browser Polaris can see.
 */
function LinkPolaris({
    server,
    onDone
}: {
    server: string;
    onDone: () => Promise<void>;
}): React.JSX.Element {
    const t = useWords();
    const [error, setError] = useState<string | null>(null);
    const [busy, setBusy] = useState(false);
    const [waiting, setWaiting] = useState<{ userCode: string; pollMs: number } | null>(null);

    const ask = async (): Promise<void> => {
        setBusy(true);
        setError(null);
        const reply = await askBackground({ kind: "link" });
        setBusy(false);
        if (!reply.ok) {
            setError(reply.error);
            return;
        }
        if ("waiting" in reply && reply.userCode) {
            setWaiting({ userCode: reply.userCode, pollMs: reply.pollMs });
        }
    };

    /** What the worker says about the request in flight, as a screen. The worker
     *  owns the waiting; this only draws where it got to. */
    const read = useCallback(async (): Promise<void> => {
        const reply = await askBackground({ kind: "linkCheck" });
        if (!reply.ok) {
            setWaiting(null);
            setError(reply.error);
            return;
        }
        if (!("waiting" in reply)) return;
        if (reply.waiting === "pending" && reply.userCode) {
            const found = { userCode: reply.userCode, pollMs: reply.pollMs };
            setWaiting((was) =>
                was && was.userCode === found.userCode && was.pollMs === found.pollMs ? was : found
            );
            return;
        }
        setWaiting(null);
        if (reply.waiting === "approved") {
            await onDone();
            return;
        }
        if (reply.waiting === "none") return;
        setError(reply.waiting === "denied" ? t("popup.link.denied") : t("popup.link.expired"));
    }, [onDone, t]);

    // A request left in flight, found again on the way back in: opening this
    // popup is the only way back to it, since pressing the button opened a tab.
    useEffect(() => {
        void read();
    }, [read]);

    useEffect(() => {
        if (!waiting) return;
        const timer = window.setInterval(() => void read(), waiting.pollMs);
        return () => window.clearInterval(timer);
    }, [waiting, read]);

    if (waiting) {
        return (
            <main className="pad">
                <h1>{t("popup.link.waitingTitle")}</h1>
                <p className="muted">{t("popup.link.approveIn")}</p>
                <code className="value">{waiting.userCode}</code>
                <p className="muted small">{t("popup.link.nothingUntil")}</p>
                <button
                    className="ghost"
                    onClick={() => {
                        setWaiting(null);
                        void askBackground({ kind: "linkCancel" });
                    }}
                >
                    {t("popup.cancel")}
                </button>
            </main>
        );
    }

    return (
        <main className="pad">
            <h1>{t("popup.link.title")}</h1>
            <p className="muted">{new URL(server).host}</p>
            <Problem text={error} />
            <button disabled={busy} onClick={() => void ask()}>
                {busy ? t("popup.link.asking") : t("popup.link.connect")}
            </button>
            <p className="muted small">{t("popup.link.hint")}</p>
            <button
                className="ghost"
                onClick={() => void askBackground({ kind: "forgetServer" }).then(onDone)}
            >
                {t("popup.link.differentPolaris")}
            </button>
        </main>
    );
}

/**
 * Signing in, which is asking Polaris itself.
 *
 * A tab opens on the dashboard, somebody who is already signed in and has their
 * vault open says yes, and the keys arrive sealed to a pair this extension made
 * for the exchange. Nothing is typed here. That is a higher bar than typing a
 * password, not a lower one - it needs a session AND an unlocked vault, where a
 * password is only the password.
 *
 * The only way in, rather than the first of two. The master password opens a
 * vault and says nothing about whose account it belongs to, so a browser let in
 * that way is signed in to nothing this extension can name - which is why the
 * button offering it is gone. It still unlocks a vault that has locked itself,
 * and that is the screen after this one.
 */
function SignIn({
    server,
    connected,
    canVault,
    onDone,
    onBack
}: {
    server: string;
    connected: boolean;
    /** Whether this account may use a vault at all. */
    canVault: boolean;
    onDone: () => Promise<void>;
    /** Where this screen was reached from, when it was reached from somewhere:
     *  the locked vault, whose password field is still worth going back to. */
    onBack?: () => void;
}): React.JSX.Element {
    const t = useWords();
    const [error, setError] = useState<string | null>(null);
    const [busy, setBusy] = useState(false);
    /** The request in flight: the code to show, and how often to ask about it. */
    const [waiting, setWaiting] = useState<{ userCode: string; pollMs: number } | null>(null);

    const ask = async (): Promise<void> => {
        setBusy(true);
        setError(null);
        const reply = await askBackground({ kind: "authorize" });
        setBusy(false);
        if (!reply.ok) {
            setError(reply.error);
            return;
        }
        if ("waiting" in reply && reply.userCode) {
            setWaiting({ userCode: reply.userCode, pollMs: reply.pollMs });
        }
    };

    const leave = async (request: { kind: "signOut" }): Promise<void> => {
        setError(null);
        const reply = await askBackground(request);
        if (!reply.ok) setError(reply.error);
        await onDone();
    };

    /**
     * What the worker says about the request in flight, as a screen.
     *
     * One reader for both the first look and every look after it, because they are
     * the same question: the worker owns the request and the waiting, and this only
     * draws whatever state it has reached. The code is held there rather than here
     * for the same reason - this popup does not outlive the tab it opened.
     */
    const readWaiting = useCallback(async (): Promise<void> => {
        const reply = await askBackground({ kind: "authorizeCheck" });
        if (!reply.ok) {
            setWaiting(null);
            setError(reply.error);
            return;
        }
        if (!("waiting" in reply)) return;
        if (reply.waiting === "pending" && reply.userCode) {
            // The same object while nothing has moved, so the timer below is not
            // torn down and rebuilt on every poll.
            const found = { userCode: reply.userCode, pollMs: reply.pollMs };
            setWaiting((was) =>
                was && was.userCode === found.userCode && was.pollMs === found.pollMs ? was : found
            );
            return;
        }
        setWaiting(null);
        if (reply.waiting === "approved") {
            await onDone();
            return;
        }
        if (reply.waiting === "none") return;
        setError(reply.waiting === "denied" ? t("popup.link.denied") : t("popup.link.expired"));
    }, [onDone, t]);

    // A request left in flight, found again on the way back in. Opening this popup
    // is the only way back to it: pressing the button opens a tab, and that is what
    // closed the popup. Without this the screen offers nothing but asking a second
    // time, which opens a second request and orphans the one somebody is in the
    // middle of approving.
    useEffect(() => {
        void readWaiting();
    }, [readWaiting]);

    // Asking after it, while one is in flight. The worker polls the server on its
    // own; this only reads where that got to, so nothing is lost when it closes.
    useEffect(() => {
        if (!waiting) return;
        const timer = window.setInterval(() => void readWaiting(), waiting.pollMs);
        return () => window.clearInterval(timer);
    }, [waiting, readWaiting]);

    const cancel = async (): Promise<void> => {
        setWaiting(null);
        await askBackground({ kind: "authorizeCancel" });
    };

    if (waiting) {
        return (
            <main className="pad">
                <h1>{t("popup.link.waitingTitle")}</h1>
                <p className="muted">{t("popup.link.approveIn")}</p>
                <code className="value">{waiting.userCode}</code>
                <p className="muted small">{t("popup.signIn.nothingUntil")}</p>
                <button className="ghost" onClick={() => void cancel()}>
                    {t("popup.cancel")}
                </button>
            </main>
        );
    }

    if (!canVault) {
        return (
            <main className="pad">
                <p className="muted small">
                    {t("popup.signIn.noVault", { host: new URL(server).host })}
                </p>
            </main>
        );
    }

    return (
        <main className="pad">
            <Problem text={error} />
            <button disabled={busy} onClick={() => void ask()}>
                {busy ? t("popup.link.asking") : t("popup.signIn.connect")}
            </button>
            {/* What it needs, before what it does. The requirement was the last
                clause of the sentence, under a button that said "Sign in with
                Polaris" - so this read as signing in to Polaris, and the vault
                turned up as a surprise on the other tab. What this connects to is
                the password vault; saying so is not a smaller promise, it is the
                true one. */}
            <p className="muted small">{t("popup.signIn.hint")}</p>
            {/* The master password is no longer a way in, and the button that
                offered it is gone rather than left to fail: it opens the vault
                without signing in to the account, which is the state the popup now
                sends back here. It is still what unlocks a vault that has been
                left alone - that is the screen after this one. */}
            {/* The way to a different server. Off the main path, because most
                people have one Polaris - but without it, setting an account aside
                to add another would strand somebody on whichever address they
                happened to name first. */}
            {connected ? (
                <button className="ghost" onClick={() => void leave({ kind: "signOut" })}>
                    {t("popup.signIn.signOut")}
                </button>
            ) : null}
            {onBack ? (
                <button className="ghost" onClick={onBack}>
                    {t("popup.signIn.usePassword")}
                </button>
            ) : null}
        </main>
    );
}

function Unlock({
    onDone,
    onApprove
}: {
    onDone: () => Promise<void>;
    /** The other way past a locked vault, for when the password is not the thing
     *  standing in the way. */
    onApprove: () => void;
}): React.JSX.Element {
    const t = useWords();
    const [password, setPassword] = useState("");
    const [error, setError] = useState<string | null>(null);
    const [busy, setBusy] = useState(false);

    const unlock = async (): Promise<void> => {
        setBusy(true);
        setError(null);
        const reply = await askBackground({ kind: "unlock", password });
        setBusy(false);
        if (!reply.ok) {
            setError(reply.error);
            return;
        }
        await onDone();
    };

    return (
        <main className="pad">
            <h1>{t("popup.unlock.title")}</h1>
            <input
                autoFocus
                type="password"
                value={password}
                placeholder={t("popup.unlock.placeholder")}
                onChange={(event) => setPassword(event.target.value)}
                onKeyDown={(event) => event.key === "Enter" && void unlock()}
            />
            <Problem text={error} />
            <button disabled={busy || password === ""} onClick={() => void unlock()}>
                {busy ? t("popup.unlock.opening") : t("popup.unlock.unlock")}
            </button>
            {/* The way out of the one screen that had none. A password field on
                its own can only be read as "you have forgotten it", and two of
                the three reasons this refuses have nothing to do with what was
                typed - see `lib/unlock`. */}
            <button className="ghost" onClick={onApprove}>
                {t("popup.unlock.fromPolaris")}
            </button>
        </main>
    );
}

/** The answer the worker reads when it registers the inline script. Written
 *  here and nowhere else, from the press that asked the browser for the grant. */
const EVERYWHERE = storage.defineItem<boolean>("local:inline.everywhere", { fallback: true });

/**
 * "Show Polaris on every site": the list under a login box on every page, the
 * way a password manager usually works, rather than one site at a time.
 *
 * On from the start on Chromium, whose build holds every web page (see
 * `wxt.config.ts`); where the grant is missing - a browser that let somebody
 * withhold it - turning it on asks for it again in the browser's own prompt.
 *
 * Turning it off stops the registration but keeps the grant: the broad grant
 * covers the Polaris server too, and giving it back could cut the vault off from
 * its own server. The browser's extension settings remove it for anybody who
 * wants it gone.
 */
function useEverywhere(t: Words): {
    everywhere: boolean | null;
    possible: boolean;
    turn: (on: boolean) => Promise<string | null>;
} {
    const [everywhere, setEverywhere] = useState<boolean | null>(null);
    const possible = Boolean(browser.scripting?.registerContentScripts);

    useEffect(() => {
        if (!possible) return;
        void Promise.all([
            EVERYWHERE.getValue(),
            browser.permissions.contains({ origins: [...EVERY_SITE] }).catch(() => false)
        ]).then(([chosen, held]) => setEverywhere(chosen && held));
    }, [possible]);

    const turn = async (on: boolean): Promise<string | null> => {
        if (on) {
            let allowed = false;
            try {
                allowed = await browser.permissions.request({ origins: [...EVERY_SITE] });
            } catch {
                allowed = false;
            }
            if (!allowed) return t("popup.sites.noEveryPermission");
        }
        await EVERYWHERE.setValue(on);
        const reply = await askBackground({ kind: "startInline" });
        setEverywhere(on);
        return reply.ok ? null : reply.error;
    };

    return { everywhere, possible, turn };
}

function OnEverySite({
    everywhere,
    turn
}: {
    everywhere: boolean;
    turn: (on: boolean) => Promise<string | null>;
}): React.JSX.Element {
    const t = useWords();
    const [busy, setBusy] = useState(false);
    const [note, setNote] = useState<string | null>(null);

    const press = async (): Promise<void> => {
        setBusy(true);
        setNote(null);
        const problem = await turn(!everywhere);
        setBusy(false);
        setNote(problem ?? (everywhere ? t("popup.sites.reloadOpen") : null));
    };

    return (
        <>
            <div className="row">
                <span className="muted small">
                    {everywhere ? t("popup.sites.everywhereOn") : t("popup.sites.everywhereOff")}
                </span>
                <div className="acts">
                    <button
                        className="ghost"
                        disabled={busy}
                        title={
                            everywhere ? t("popup.sites.onlySomeHint") : t("popup.sites.everyHint")
                        }
                        onClick={() => void press()}
                    >
                        {everywhere ? t("popup.sites.onlySome") : t("popup.sites.every")}
                    </button>
                </div>
            </div>
            {note ? <p className="muted small">{note}</p> : null}
        </>
    );
}

/**
 * Whether Polaris shows itself inside the pages of this site.
 *
 * The thing it turns on is the mark beside a login box, the generator on a
 * sign-up form, and the offer to save what was just typed - none of which the
 * popup can do, because all of them mean running a script inside somebody else's
 * page. This extension asks for no standing access to any site, so that access
 * arrives here, one host at a time, from the person looking at the host.
 *
 * The request is made here rather than sent to the worker, and it has to be: a
 * browser refuses a permission request that did not come from a user gesture, and
 * a worker has none. What the worker does afterwards is the half the popup
 * cannot - registering the script and running it in the tab already open, so the
 * marks appear without a reload.
 *
 * Absent entirely where it would be noise: on Polaris's own site, which fills its
 * own forms, and on a browser whose extensions cannot inject a script at runtime
 * at all.
 */
function OnThisSite({
    url,
    host,
    server
}: {
    url: string | null;
    host: string | null;
    server: string | null;
}): React.JSX.Element | null {
    const t = useWords();
    const [granted, setGranted] = useState<boolean | null>(null);
    const [busy, setBusy] = useState(false);
    const [note, setNote] = useState<string | null>(null);
    const origin = url === null ? null : readOrigin(url);
    // Manifest v2 has no `scripting` namespace, so on Firefox this is a feature
    // the browser does not have rather than one somebody has not switched on.
    const possible = Boolean(browser.scripting?.registerContentScripts);

    useEffect(() => {
        if (!origin || !possible) return;
        void browser.permissions
            .contains({ origins: [`${origin}/*`] })
            .then(setGranted)
            .catch(() => setGranted(false));
    }, [origin, possible]);

    if (!origin || !host || !possible || granted === null) return null;
    // Its own site, which has the vault open in a tab of its own.
    if (server !== null && readOrigin(server) === origin) return null;

    const turnOn = async (): Promise<void> => {
        setBusy(true);
        setNote(null);
        let allowed = false;
        try {
            allowed = await browser.permissions.request({ origins: [`${origin}/*`] });
        } catch {
            allowed = false;
        }
        if (!allowed) {
            setBusy(false);
            setNote(t("popup.sites.noSitePermission"));
            return;
        }
        const reply = await askBackground({ kind: "startInline" });
        setBusy(false);
        setGranted(true);
        if (!reply.ok) setNote(reply.error);
    };

    const turnOff = async (): Promise<void> => {
        setBusy(true);
        try {
            await browser.permissions.remove({ origins: [`${origin}/*`] });
        } catch {
            // Refused by the browser, which the line below then reports honestly:
            // the state is re-read rather than assumed.
        }
        const held = await browser.permissions
            .contains({ origins: [`${origin}/*`] })
            .catch(() => true);
        setGranted(held);
        setBusy(false);
        // A script already running in a page cannot be taken back out of it, and
        // somebody who still sees the mark after switching this off would read
        // that as a switch that does nothing.
        setNote(held ? null : t("popup.sites.reloadPage"));
    };

    return (
        <>
            <div className="row">
                <span className="muted small">
                    {granted
                        ? t("popup.sites.shownOn", { host })
                        : t("popup.sites.notShownOn", { host })}
                </span>
                <div className="acts">
                    <button
                        className="ghost"
                        disabled={busy}
                        title={
                            granted ? t("popup.sites.notHereHint") : t("popup.sites.showHereHint")
                        }
                        onClick={() => void (granted ? turnOff() : turnOn())}
                    >
                        {granted ? t("popup.sites.notHere") : t("popup.sites.showHere")}
                    </button>
                </div>
            </div>
            {note ? <p className="muted small">{note}</p> : null}
        </>
    );
}

/**
 * The generator's choices, read from storage and written back when they change.
 *
 * The defaults until storage answers, which is a frame or two: a generator opened
 * in that gap makes one password with the defaults and a second the moment the
 * saved choices land, rather than waiting on a read to draw anything. Written
 * only when a choice actually differs, and a browser that refuses the write keeps
 * the choice for as long as the popup is open - remembering is a convenience, not
 * something a password depends on.
 */
function useGeneratorOptions(): [GeneratorOptions, (next: GeneratorOptions) => void] {
    const [options, setOptions] = useState<GeneratorOptions>(GENERATOR_DEFAULTS);
    // Somebody who changed a choice before the saved ones arrived keeps theirs:
    // the read landing late must not put back what they just moved away from.
    const chosen = useRef(false);
    useEffect(() => {
        let alive = true;
        void storage
            .getItem<unknown>(GENERATOR_KEY)
            .then((held) => {
                if (alive && !chosen.current) setOptions(readGeneratorOptions(held));
            })
            .catch(() => undefined);
        return () => {
            alive = false;
        };
    }, []);
    const choose = useCallback(
        (next: GeneratorOptions) => {
            if (sameOptions(options, next)) return;
            chosen.current = true;
            setOptions(next);
            void storage.setItem(GENERATOR_KEY, next).catch(() => undefined);
        },
        [options]
    );
    return [options, choose];
}

/**
 * Making up a password, where somebody is already signing up for something.
 *
 * Closed until asked for, because most visits here are to read a password rather
 * than to invent one, and a panel of options above the list would be in the way
 * of the common case every time to serve the rare one.
 *
 * The generating is `@polaris/core`'s, the same module the web vault uses, so
 * a password made here and one made there are drawn the same way. This makes a
 * string and saves nothing itself: "Use it" hands it to the form above, and the
 * copy button hands it to whatever somebody is signing up to. What it is made of
 * is remembered for this browser, and the generator inside a page reads the same
 * choices - see `lib/generator`.
 *
 * It needs no vault, no account and no server, which is why it is offered on
 * every screen rather than behind the item list. Where there is no save form to
 * hand a password to there is no "Use it" either, and copying is the whole of it.
 */
function Generator({ onUse }: { onUse?: (value: string) => void }): React.JSX.Element {
    const t = useWords();
    const [open, setOpen] = useState(false);
    const [options, setOptions] = useGeneratorOptions();
    const [value, setValue] = useState<string | null>(null);
    const [shown, setShown] = useState(true);
    const [note, setNote] = useState<string | null>(null);
    // Bumped by "make another", so the same choices can ask for a new password.
    const [draw, setDraw] = useState(0);
    const clearing = useRef<number | null>(null);

    useEffect(
        () => () => {
            if (clearing.current !== null) window.clearTimeout(clearing.current);
        },
        []
    );

    // A new password whenever the panel opens, a choice changes, or somebody
    // asks for another - made in an effect because it is random, and a render
    // has to draw the same thing every time it runs.
    useEffect(() => {
        if (!open) return;
        setValue(generatePassword(options));
        setNote(null);
    }, [open, options, draw]);

    const [copied, markCopied] = useCopied();

    const copy = async (): Promise<void> => {
        if (!value) return;
        try {
            await navigator.clipboard.writeText(value);
        } catch {
            setNote(t("popup.clipboard.refused"));
            return;
        }
        markCopied("generated");
        setNote(t("popup.clipboard.copied", { seconds: CLEAR_AFTER_MS / 1000 }));
        if (clearing.current !== null) window.clearTimeout(clearing.current);
        clearing.current = window.setTimeout(() => {
            void navigator.clipboard.writeText("");
        }, CLEAR_AFTER_MS);
    };

    if (!open) {
        return (
            <div className="row">
                <button className="ghost" onClick={() => setOpen(true)}>
                    {t("menu.generate")}
                </button>
            </div>
        );
    }

    return (
        <GeneratorPanel
            value={value}
            options={options}
            onOptions={setOptions}
            shown={shown}
            onShown={setShown}
            copied={copied === "generated"}
            note={note}
            onAgain={() => setDraw((was) => was + 1)}
            onCopy={() => void copy()}
            onClose={() => setOpen(false)}
            onUse={
                onUse
                    ? () => {
                          if (value) onUse(value);
                      }
                    : undefined
            }
        />
    );
}

/**
 * The six digits beside an item that carries them, and how long they have left.
 *
 * Asked of the worker rather than computed here, because the secret stays there -
 * what crosses is a code that expires on its own within the minute. Re-asked when
 * the countdown runs out rather than on a fixed timer, so the digits on screen are
 * never the previous period's.
 */
/**
 * The seconds left, as a ring that empties.
 *
 * The same shape the vault draws in the dashboard, down to the radius and the
 * thresholds, because it answers the same question in both places: somebody
 * looking at six digits wants to know whether there is time to type them, and
 * that is a shape rather than an arithmetic. Redrawn here rather than imported -
 * the dashboard's is a Tailwind component and this popup ships no Tailwind - so
 * the numbers are copied and the colours come from the tokens in `style.css`.
 */
function CountdownRing({ left, of }: { left: number; of: number }): React.JSX.Element {
    const t = useWords();
    const period = Math.max(1, of);
    const held = Math.max(0, Math.min(period, left));
    const radius = 9;
    const circumference = 2 * Math.PI * radius;
    const tone = held <= 5 ? "danger" : held <= Math.max(8, period / 3) ? "warning" : "success";

    return (
        <span
            className={`ring ${tone}`}
            role="timer"
            aria-label={t("popup.items.secondsLeft", { count: held })}
        >
            <svg viewBox="0 0 24 24" aria-hidden="true">
                <circle
                    cx="12"
                    cy="12"
                    r={radius}
                    fill="none"
                    strokeWidth="2.5"
                    className="track"
                />
                <circle
                    cx="12"
                    cy="12"
                    r={radius}
                    fill="none"
                    strokeWidth="2.5"
                    strokeLinecap="round"
                    stroke="currentColor"
                    strokeDasharray={circumference}
                    strokeDashoffset={circumference * (1 - held / period)}
                />
            </svg>
            <span className="ring-left">{held}</span>
        </span>
    );
}

function TotpCell({
    id,
    done,
    onCopy
}: {
    id: string;
    /** Whether this code was just copied. */
    done: boolean;
    onCopy: () => void;
}): React.JSX.Element | null {
    const t = useWords();
    const [code, setCode] = useState<string | null>(null);
    const [left, setLeft] = useState(0);

    useEffect(() => {
        let alive = true;
        const ask = async (): Promise<void> => {
            const reply = await askBackground({ kind: "totpNow", id });
            if (!alive) return;
            if (reply.ok && "code" in reply) {
                setCode(reply.code);
                setLeft(reply.remaining);
            } else {
                setCode(null);
            }
        };
        void ask();
        const tick = window.setInterval(() => {
            setLeft((was) => {
                if (was <= 1) {
                    void ask();
                    return 30;
                }
                return was - 1;
            });
        }, 1000);
        return () => {
            alive = false;
            window.clearInterval(tick);
        };
    }, [id]);

    if (!code) return null;
    // Grouped in threes, which is how everybody reads a code off a screen.
    const shown = code.length === 6 ? `${code.slice(0, 3)} ${code.slice(3)}` : code;
    return (
        <button
            type="button"
            className="field code-field"
            title={t("popup.items.copyCode")}
            aria-label={t("popup.items.copyCode")}
            onClick={onCopy}
        >
            <CountdownRing left={left} of={30} />
            <span className="code">{shown}</span>
            {done ? <CheckMark /> : <CopyMark />}
        </button>
    );
}

/**
 * One value on a login, as a line that copies itself when pressed.
 *
 * The whole line is the button rather than an icon at the end of it: at 360
 * pixels a row of four labelled buttons is most of the width, and the thing
 * somebody wants is almost always "give me that value". A password is shown as
 * dots - it is copied, never read off the screen - and a login with no username
 * says so rather than drawing an empty line that looks pressable and is not.
 */
function Field({
    copyLabel,
    shown,
    mono,
    done,
    onCopy
}: {
    /** What pressing it does, said out loud: "Copy the username". */
    copyLabel: string;
    shown: string;
    mono?: boolean;
    /** Whether this value was just copied. */
    done?: boolean;
    onCopy: (() => void) | null;
}): React.JSX.Element {
    if (!onCopy) {
        return (
            <span className="field empty">
                <span className="muted small">{shown}</span>
            </span>
        );
    }
    return (
        <button
            type="button"
            className="field"
            title={copyLabel}
            aria-label={copyLabel}
            onClick={onCopy}
        >
            <span className={mono ? "shown mono" : "shown"}>{shown}</span>
            {done ? <CheckMark /> : <CopyMark />}
        </button>
    );
}

/**
 * Replacing one login's password.
 *
 * The new password is shown rather than masked, which is deliberate: the point of
 * changing it here is to set the same one on the site, and a value somebody cannot
 * read is one they cannot type in. It is a field rather than a label so a password
 * chosen somewhere else can be pasted into it.
 *
 * Nothing about the old password crosses into this popup. The worker reads it from
 * what it already holds and moves it into the item's history itself, so replacing a
 * password never requires having seen it.
 */
function ChangePassword({
    item,
    onClose,
    onChange
}: {
    item: ItemSummary;
    onClose: () => void;
    onChange: () => Promise<void>;
}): React.JSX.Element {
    const t = useWords();
    const [password, setPassword] = useState("");
    const [refused, setRefused] = useState<string | null>(null);
    const [busy, setBusy] = useState(false);
    // The generator's choices, so "make one up" here makes what it makes there.
    const [options] = useGeneratorOptions();

    const submit = async (): Promise<void> => {
        setBusy(true);
        setRefused(null);
        const reply = await askBackground({ kind: "changePassword", id: item.id, password });
        setBusy(false);
        if (!reply.ok) {
            setRefused(reply.error);
            return;
        }
        onClose();
        await onChange();
    };

    return (
        <div className="row wrap">
            <span className="muted small">{t("popup.change.for", { name: item.name })}</span>
            <input
                autoFocus
                value={password}
                placeholder={t("popup.change.placeholder")}
                aria-label={t("popup.change.for", { name: item.name })}
                onChange={(event) => setPassword(event.target.value)}
                onKeyDown={(event) => event.key === "Enter" && password !== "" && void submit()}
            />
            <div className="acts">
                <button
                    className="ghost"
                    title={t("popup.change.makeOne")}
                    onClick={() => setPassword(generatePassword(options) ?? "")}
                >
                    {t("popup.change.makeOne")}
                </button>
                <button
                    className="ghost"
                    disabled={busy || password === ""}
                    onClick={() => void submit()}
                >
                    {busy ? t("popup.saving") : t("popup.save")}
                </button>
                <button className="ghost" onClick={onClose}>
                    {t("popup.cancel")}
                </button>
            </div>
            <p className="muted small">{t("popup.change.onSiteToo")}</p>
            <Problem text={refused} />
        </div>
    );
}

/**
 * Saving the login for the page somebody is on.
 *
 * Closed until asked for, like the generator: most visits here are to read a
 * password rather than to add one, and a form standing open above the list would
 * be in the way of the common case to serve the rarer one.
 *
 * Prefilled with what is already known - the site's name and its address - because
 * the alternative is somebody retyping what the popup could see. Checked on every
 * keystroke by `readIntendedLogin`, the same function the worker decides with, so
 * the button says why it is disabled instead of failing after the press.
 */
function SaveLogin({
    url,
    host,
    offered,
    onUsed,
    onChange
}: {
    url: string | null;
    host: string | null;
    /** A password the generator has just made, to open this form around it. */
    offered: string | null;
    onUsed: () => void;
    onChange: () => Promise<void>;
}): React.JSX.Element {
    const t = useWords();
    const [open, setOpen] = useState(false);
    const [name, setName] = useState("");
    const [username, setUsername] = useState("");
    const [password, setPassword] = useState("");
    const [refused, setRefused] = useState<string | null>(null);
    const [busy, setBusy] = useState(false);

    // A password made next door arrives here rather than through the clipboard.
    // Taken once and then let go, so a later render does not put it back over
    // something that has since been typed over it.
    useEffect(() => {
        if (offered === null) return;
        setOpen(true);
        setPassword(offered);
        setName((was) => (was === "" ? (host ?? "") : was));
        setRefused(null);
        onUsed();
    }, [offered, host, onUsed]);

    const typed = { name, username, password, uri: url ?? "" };
    const check = readIntendedLogin(typed, t);
    // Nothing is said until something has been typed: an error under an untouched
    // form is a complaint about not having started yet.
    const started = name !== "" || username !== "" || password !== "";

    // What the server refused wins over what the form can see, because it is the
    // newer and more specific answer: a reader who has just been told the session
    // ended is not helped by going back to "give it a name".
    let problem: string | null = refused;
    if (problem === null && started && !check.ok) problem = check.error;

    const save = async (): Promise<void> => {
        setBusy(true);
        setRefused(null);
        const reply = await askBackground({ kind: "save", ...typed });
        setBusy(false);
        if (!reply.ok) {
            setRefused(reply.error);
            return;
        }
        setOpen(false);
        setName("");
        setUsername("");
        setPassword("");
        await onChange();
    };

    if (!open) {
        return (
            <div className="row">
                <button
                    className="ghost"
                    onClick={() => {
                        setOpen(true);
                        setName(host ?? "");
                        setRefused(null);
                    }}
                >
                    {host ? t("popup.saveLogin.forPage") : t("popup.saveLogin.open")}
                </button>
            </div>
        );
    }

    return (
        <div className="row wrap">
            <input
                autoFocus
                value={name}
                placeholder={t("popup.saveLogin.name")}
                aria-label={t("popup.saveLogin.name")}
                onChange={(event) => setName(event.target.value)}
            />
            <input
                value={username}
                placeholder={t("popup.saveLogin.username")}
                aria-label={t("popup.saveLogin.username")}
                onChange={(event) => setUsername(event.target.value)}
            />
            <input
                type="password"
                value={password}
                placeholder={t("popup.saveLogin.password")}
                aria-label={t("popup.saveLogin.password")}
                onChange={(event) => setPassword(event.target.value)}
                onKeyDown={(event) => event.key === "Enter" && check.ok && void save()}
            />
            <span className="muted small">
                {url
                    ? t("popup.saveLogin.savedFor", { where: host ?? url })
                    : t("popup.saveLogin.noPage")}
            </span>
            <div className="acts">
                <button className="ghost" disabled={busy || !check.ok} onClick={() => void save()}>
                    {busy ? t("popup.saving") : t("popup.save")}
                </button>
                <button className="ghost" onClick={() => setOpen(false)}>
                    {t("popup.cancel")}
                </button>
            </div>
            <Problem text={problem} />
        </div>
    );
}

/**
 * How long the vault stays open while nobody is using it.
 *
 * Here rather than buried in an options page, because it is the one setting that
 * decides how exposed an unattended screen is, and somebody who wants it shorter
 * should not have to go looking. The choices and the default are `lib/lock.ts`'s,
 * which is also what the worker enforces - so the list cannot drift from what is
 * actually accepted.
 */
function Timeout({
    status,
    onChange
}: {
    status: VaultStatus;
    onChange: () => Promise<void>;
}): React.JSX.Element {
    const t = useWords();
    return (
        <div className="row">
            <label className="muted small" htmlFor="vault-timeout">
                {t("popup.lockAfter")}
            </label>
            <div className="acts">
                <select
                    id="vault-timeout"
                    value={status.timeoutMs}
                    onChange={(event) => {
                        void askBackground({
                            kind: "setTimeout",
                            timeoutMs: Number(event.target.value)
                        }).then(onChange);
                    }}
                >
                    {timeoutChoices(t).map((choice) => (
                        <option key={choice.ms} value={choice.ms}>
                            {choice.label}
                        </option>
                    ))}
                </select>
            </div>
        </div>
    );
}

/**
 * Which account this is, and the way to another one.
 *
 * Two things the popup could not do, which turn out to be one thing. It knew how
 * to read a vault and not whose account the vault was on, so the only way to find
 * out was to open the dashboard and look. And it could hold exactly one account at
 * a time, so reaching the second meant signing out of the first, naming the server
 * again, and approving again - for an account it had been signed into ten seconds
 * earlier.
 *
 * So the line says who is in front, and opening it lists everyone else signed in
 * here. Switching is one press. Adding one sets the current account aside rather
 * than ending it, which is the difference between a second account and a
 * replacement.
 *
 * What a row is called comes from `lib/accounts`, not from here, because the same
 * fallback - name, then email, then the server's host - has to hold for a Polaris
 * too old to name its own account. A row nobody can identify is not a row.
 */
function Accounts({
    status,
    onChange
}: {
    status: VaultStatus;
    onChange: () => Promise<void>;
}): React.JSX.Element | null {
    const t = useWords();
    const [open, setOpen] = useState(false);
    const [busy, setBusy] = useState(false);
    const [refused, setRefused] = useState<string | null>(null);

    // Nothing at all before anything has been signed into. Otherwise this is the
    // one thing that would appear on a first run, saying nothing, above a form
    // still asking which Polaris this is.
    if (status.accounts.length === 0) return null;

    const active = status.accounts.find((one) => one.id === status.activeId) ?? null;
    const others = status.accounts.filter((one) => one.id !== status.activeId);

    const act = async (request: Request): Promise<void> => {
        setBusy(true);
        setRefused(null);
        const reply = await askBackground(request);
        setBusy(false);
        if (!reply.ok) {
            setRefused(reply.error);
            return;
        }
        setOpen(false);
        await onChange();
    };

    return (
        <div className="row wrap">
            <span className="muted small">
                {active
                    ? t.rich("popup.accounts.signedInAs", {
                          who: () => (
                              <span
                                  key="who"
                                  className="who-name"
                                  title={active.email ?? undefined}
                              >
                                  {describeAccount(active)}
                              </span>
                          )
                      })
                    : t("popup.accounts.signingIn")}
            </span>
            <div className="acts">
                <button className="ghost" disabled={busy} onClick={() => setOpen(!open)}>
                    {open
                        ? t("generator.hide")
                        : others.length > 0
                          ? t("popup.accounts.switchCount", { count: others.length })
                          : t("popup.accounts.accounts")}
                </button>
            </div>
            {open ? (
                <ul className="accounts">
                    {others.map((one) => (
                        <li key={one.id}>
                            <button
                                className="account"
                                disabled={busy}
                                title={t("shell.switchTo", { name: describeAccount(one) })}
                                onClick={() => void act({ kind: "switchAccount", id: one.id })}
                            >
                                <span className="shown">{describeAccount(one)}</span>
                                <span className="account-where">{accountHost(one.origin)}</span>
                            </button>
                        </li>
                    ))}
                    {/* Only where there is an account to set aside. With none in
                        front, the screen above this already IS the way in, and a
                        button offering to start another one goes nowhere. */}
                    {active ? (
                        <li>
                            <button
                                className="account"
                                disabled={busy}
                                onClick={() => void act({ kind: "addAccount" })}
                            >
                                {t("shell.addAccount")}
                            </button>
                        </li>
                    ) : null}
                </ul>
            ) : null}
            <Problem text={refused} />
        </div>
    );
}

function Items({
    status,
    onChange
}: {
    status: VaultStatus;
    onChange: () => Promise<void>;
}): React.JSX.Element {
    const t = useWords();
    const [suggested, setSuggested] = useState<readonly ItemSummary[]>([]);
    const [found, setFound] = useState<readonly ItemSummary[]>([]);
    const [query, setQuery] = useState("");
    const [note, setNote] = useState<string | null>(null);
    // The page somebody is on, kept so saving a login for it does not ask them to
    // type an address the popup can already see.
    const [pageUrl, setPageUrl] = useState<string | null>(null);
    // A password the generator has just made, on its way into the save form above
    // it. Nobody retypes twenty random characters, and sending it out to the
    // clipboard and back would be a round trip through the one place worth keeping
    // a password out of.
    const [offered, setOffered] = useState<string | null>(null);
    const takeOffered = useCallback(() => setOffered(null), []);
    // The item whose password is being replaced, if any. One at a time: a form per
    // row would put a password field beside every login in the list.
    const [changing, setChanging] = useState<ItemSummary | null>(null);
    const clearing = useRef<number | null>(null);
    // The site in front of somebody and whether they have shut this out of it,
    // asked of the worker rather than worked out here: the popup does not hold
    // the list, and the answer has to be the same one the badge and the fill use.
    const [here, setHere] = useState<{ host: string | null; blocked: boolean }>({
        host: null,
        blocked: false
    });
    const inline = useEverywhere(t);

    useEffect(() => {
        void (async () => {
            const reply = await askBackground({ kind: "blocked" });
            if (reply.ok && "blocked" in reply)
                setHere({ host: reply.host, blocked: reply.blocked });
        })();
    }, []);

    useEffect(() => {
        void (async () => {
            const [tab] = await browser.tabs.query({ active: true, currentWindow: true });
            if (tab?.url && /^https?:/i.test(tab.url)) {
                setPageUrl(tab.url);
                const reply = await askBackground({ kind: "itemsFor", url: tab.url });
                if (reply.ok && "items" in reply) setSuggested(reply.items);
            }
        })();
    }, []);

    useEffect(() => {
        void (async () => {
            const reply = await askBackground({ kind: "items", query });
            if (reply.ok && "items" in reply) setFound(reply.items);
        })();
    }, [query]);

    useEffect(
        () => () => {
            if (clearing.current !== null) window.clearTimeout(clearing.current);
        },
        []
    );

    const [copied, markCopied] = useCopied();

    const copy = async (item: ItemSummary, field: "username" | "password" | "totp") => {
        const reply = await askBackground({ kind: "copy", id: item.id, field });
        if (!reply.ok || !("value" in reply)) {
            setNote(reply.ok ? null : reply.error);
            return;
        }
        try {
            await navigator.clipboard.writeText(reply.value);
        } catch {
            setNote(t("popup.clipboard.refused"));
            return;
        }
        markCopied(`${item.id}:${field}`);
        setNote(
            field === "username"
                ? t("popup.clipboard.username")
                : t("popup.clipboard.copied", { seconds: CLEAR_AFTER_MS / 1000 })
        );
        if (field !== "username") {
            if (clearing.current !== null) window.clearTimeout(clearing.current);
            clearing.current = window.setTimeout(() => {
                void navigator.clipboard.writeText("");
            }, CLEAR_AFTER_MS);
        }
    };

    const fill = async (item: ItemSummary) => {
        const reply = await askBackground({ kind: "fill", id: item.id });
        if (!reply.ok) {
            setNote(reply.error);
            return;
        }
        window.close();
    };

    /**
     * One login, as three lines that copy themselves.
     *
     * It used to be a name and five buttons - Fill, User, Pass, New, Code - which
     * at 360 pixels left the name about eight characters before it was cut, and
     * named every button after the thing it copied rather than showing it. Now the
     * values are the lines: what the username is, that there is a password, and
     * what the code is right now, each one a button that copies it and each one
     * showing what it will copy.
     *
     * Which vault it came out of is on the name line, because a person has their
     * own and one from every organization they are in - and the same login lives
     * in more than one of them.
     */
    const row = (item: ItemSummary, offerFill: boolean): React.JSX.Element => (
        <li key={item.id}>
            <div className="item">
                <div className="head">
                    <span className="name">{item.name}</span>
                    {item.vault ? (
                        <span
                            className="vault"
                            title={t("popup.items.sharedFrom", { vault: item.vault })}
                        >
                            {item.vault}
                        </span>
                    ) : null}
                </div>
                <Field
                    copyLabel={t("popup.items.copyUsername")}
                    shown={item.username ?? item.host ?? t("popup.items.noUsername")}
                    done={copied === `${item.id}:username`}
                    onCopy={item.username === null ? null : () => void copy(item, "username")}
                />
                <Field
                    copyLabel={t("popup.items.copyPassword")}
                    shown="••••••••••"
                    mono
                    done={copied === `${item.id}:password`}
                    onCopy={() => void copy(item, "password")}
                />
                {item.totp ? (
                    <TotpCell
                        id={item.id}
                        done={copied === `${item.id}:totp`}
                        onCopy={() => void copy(item, "totp")}
                    />
                ) : null}
            </div>
            {/* What is left is the two things that are not "copy that": putting it
                into the page in front of somebody, and replacing the password. */}
            <div className="acts">
                {offerFill ? (
                    <button
                        className="ghost"
                        title={t("popup.items.fillHint")}
                        onClick={() => void fill(item)}
                    >
                        {t("popup.items.fill")}
                    </button>
                ) : null}
                <button
                    className="ghost"
                    title={t("popup.items.replaceHint")}
                    aria-label={t("popup.items.replaceFor", { name: item.name })}
                    onClick={() => setChanging(item)}
                >
                    {t("popup.items.new")}
                </button>
            </div>
        </li>
    );

    return (
        <main>
            <header>
                <input
                    autoFocus
                    value={query}
                    placeholder={t("popup.items.search")}
                    onChange={(event) => setQuery(event.target.value)}
                />
            </header>

            {suggested.length > 0 && query === "" ? (
                <section>
                    <h2>{t("popup.items.forPage")}</h2>
                    <ul>{suggested.map((item) => row(item, true))}</ul>
                </section>
            ) : null}

            <section>
                <h2>{query === "" ? t("popup.items.everything") : t("popup.items.found")}</h2>
                {found.length === 0 ? (
                    <p className="muted pad">
                        {query === "" ? t("popup.items.none") : t("popup.items.noMatch")}
                    </p>
                ) : (
                    <ul>{found.map((item) => row(item, false))}</ul>
                )}
            </section>

            <Problem text={note} />

            {changing ? (
                <ChangePassword
                    item={changing}
                    onClose={() => setChanging(null)}
                    onChange={onChange}
                />
            ) : null}

            {inline.possible && inline.everywhere !== null ? (
                <OnEverySite everywhere={inline.everywhere} turn={inline.turn} />
            ) : null}
            {inline.everywhere ? null : (
                <OnThisSite url={pageUrl} host={here.host} server={status.server} />
            )}

            {here.host ? (
                <div className="row">
                    <span className="muted small">
                        {here.blocked
                            ? t("popup.items.offFor", { host: here.host })
                            : t("popup.items.offeringFor", { host: here.host })}
                    </span>
                    <div className="acts">
                        <button
                            className="ghost"
                            onClick={() => {
                                void askBackground({
                                    kind: "setBlocked",
                                    blocked: !here.blocked
                                }).then((reply) => {
                                    if (reply.ok && "blocked" in reply) {
                                        setHere({ host: reply.host, blocked: reply.blocked });
                                    }
                                });
                            }}
                        >
                            {here.blocked ? t("popup.items.useAgain") : t("popup.items.never")}
                        </button>
                    </div>
                </div>
            ) : null}

            <SaveLogin
                url={pageUrl}
                host={here.host}
                offered={offered}
                onUsed={takeOffered}
                onChange={onChange}
            />

            <Generator onUse={setOffered} />

            <Timeout status={status} onChange={onChange} />

            <footer>
                <button
                    className="ghost"
                    onClick={() => void askBackground({ kind: "sync" }).then(onChange)}
                >
                    {t("popup.items.sync")}
                </button>
                <button
                    className="ghost"
                    onClick={() => void askBackground({ kind: "lock" }).then(onChange)}
                >
                    {t("popup.items.lock")}
                </button>
                <button
                    className="ghost"
                    onClick={() => void askBackground({ kind: "signOut" }).then(onChange)}
                >
                    {t("popup.items.signOut")}
                </button>
                <span className="muted small grow">
                    {status.syncedAt
                        ? t("popup.items.synced", {
                              time: new Date(status.syncedAt).toLocaleTimeString(t.locale)
                          })
                        : t("popup.items.notSynced")}
                </span>
            </footer>
        </main>
    );
}
