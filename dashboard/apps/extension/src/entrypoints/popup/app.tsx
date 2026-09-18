import { TIMEOUT_CHOICES } from "@/lib/lock";
import { readIntendedLogin } from "@/lib/save";
import type { UpdateNotice } from "@/lib/update";
import { looksLikeAddress, readOrigin } from "@/lib/address";
import { accountHost, describeAccount } from "@/lib/accounts";
import { useCallback, useEffect, useRef, useState } from "react";
import { askBackground, type ItemSummary, type Request, type VaultStatus } from "@/lib/messages";
// The subpath rather than the package: `@polaris/core` is a barrel over the whole
// product's domain logic, and pulling it in for one function put a quarter of a
// megabyte of zod schemas, CIDR arithmetic and camera geometry into a popup that
// draws six buttons.
import {
    generatePassword,
    PASSWORD_MAX_LENGTH,
    PASSWORD_MIN_LENGTH
} from "@polaris/core/password-generator";

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

/** What the worker's last check found, if it found anything. */
function useUpdate(): UpdateNotice | null {
    const [notice, setNotice] = useState<UpdateNotice | null>(null);
    useEffect(() => {
        void (async () => {
            const reply = await askBackground({ kind: "updateStatus" });
            if (reply.ok && "update" in reply) setNotice(reply.update);
        })();
    }, []);
    return notice;
}

/**
 * The one thing this popup says without being asked.
 *
 * What it says depends on how this copy got here, because the two readers have
 * nothing to do with each other. A store install is updated by the store once the
 * new version is reviewed: there is nothing for that person to do, and sending
 * them to re-load a folder by hand would be sending them to undo a working
 * install. A copy loaded from disk updates never, and the only thing that will
 * ever change that is them doing it again - so it points at the steps, on their
 * own Polaris, rather than repeating them in a 360-pixel panel.
 */
function UpdateBanner({
    notice,
    server
}: {
    notice: UpdateNotice | null;
    server: string | null;
}): React.JSX.Element | null {
    if (!notice) return null;
    if (notice.kind === "store") {
        return (
            <div className="notice small">
                Version {notice.version} is out. Your browser installs it once the store has
                reviewed it, so there is nothing to do here.
            </div>
        );
    }
    return (
        <div className="notice small">
            Version {notice.version} is out. This copy was loaded by hand, so it has to be loaded
            again the same way.{" "}
            <a
                href={server ? `${server}/account/downloads` : notice.url}
                target="_blank"
                rel="noreferrer"
            >
                {server ? "The steps are on your Polaris" : "See what changed"}
            </a>
            .
        </div>
    );
}

export function App(): React.JSX.Element {
    const [status, refresh] = useStatus();
    const update = useUpdate();

    // Nothing at all until the worker has answered: a popup that flashed the
    // sign-in screen at somebody whose vault is open would be lying for a frame.
    if (!status) return <main className="pad" />;

    // The order is the product's: which Polaris, then this browser connected to
    // the account, then a vault if the account has one. The connection is what
    // makes this extension somebody's - it is listed on their Sessions screen and
    // ended from there - and the vault is one thing it may then be used for.
    //
    // The exception is a browser that was signed in to a vault before connections
    // existed. It keeps working exactly as it did, and is asked to connect by a
    // line above its own list rather than by a screen standing in front of it:
    // taking somebody's logins away to make a point about a new step would be a
    // worse thing to do than the step is worth.
    const legacyVault = !status.linked && status.connected;
    const screen = !status.server ? (
        <Connect onDone={refresh} />
    ) : !status.linked && !legacyVault ? (
        <LinkPolaris server={status.server} onDone={refresh} />
    ) : // A vault token with no account credential is one opened by typing the
    // master password before the approval was required; it goes back through the
    // approval rather than carrying on, because the extension has no idea whose
    // account it is sitting on until it does.
    !status.connected || !status.polarisSession ? (
        <SignIn
            server={status.server}
            connected={status.connected}
            canVault={status.canVault}
            account={status.linkedAccount}
            onDone={refresh}
        />
    ) : !status.unlocked ? (
        <Unlock onDone={refresh} />
    ) : (
        <Items status={status} onChange={refresh} />
    );

    return (
        <>
            <UpdateBanner notice={update} server={status.server} />
            {/* Above whatever is showing, because it is about all of it: an
                extension that is not connected is one this account cannot see or
                end from Polaris. */}
            {legacyVault ? <LinkBanner onDone={refresh} /> : null}
            {screen}
            {/* Under whichever screen is showing, rather than only over the item
                list. A vault that is locked, and an account just set aside to add
                another, are exactly the moments somebody needs the way back - and
                those are the screens the list would otherwise be missing from. */}
            <Accounts status={status} onChange={refresh} />
        </>
    );
}

function Problem({ text }: { text: string | null }): React.JSX.Element | null {
    return text ? <p className="problem">{text}</p> : null;
}

function Connect({ onDone }: { onDone: () => Promise<void> }): React.JSX.Element {
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
            setError("That does not look like an address.");
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
            setError("Without permission for that address, nothing can be read from it.");
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
            <h1>Polaris</h1>
            <p className="muted">The address you open the dashboard at.</p>
            <input
                autoFocus
                value={typed}
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
                {asking ? "Asking the browser" : "Continue"}
            </button>
            <p className="muted small">
                The browser will ask whether this extension may talk to that address. It is the only
                one it ever reads.
            </p>
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
        setError(
            reply.waiting === "denied"
                ? "That was turned down in Polaris."
                : "That request ran out. Ask again."
        );
    }, [onDone]);

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
                <h1>Waiting for Polaris</h1>
                <p className="muted">
                    Approve this in the tab that opened. The code there should read:
                </p>
                <code className="value">{waiting.userCode}</code>
                <p className="muted small">
                    Nothing is connected until somebody signed in to Polaris says yes. You can close
                    this; it carries on without it.
                </p>
                <button
                    className="ghost"
                    onClick={() => {
                        setWaiting(null);
                        void askBackground({ kind: "linkCancel" });
                    }}
                >
                    Cancel
                </button>
            </main>
        );
    }

    return (
        <main className="pad">
            <h1>Connect this browser</h1>
            <p className="muted">{new URL(server).host}</p>
            <Problem text={error} />
            <button disabled={busy} onClick={() => void ask()}>
                {busy ? "Asking" : "Connect to Polaris"}
            </button>
            <p className="muted small">
                A tab opens on your Polaris and you approve it there. The connection appears under
                Sessions, and you can end it from there at any time.
            </p>
            <button className="ghost" onClick={() => void askBackground({ kind: "forgetServer" }).then(onDone)}>
                Use a different Polaris
            </button>
        </main>
    );
}

/** The line offered to a browser signed in to a vault from before connections
 *  existed. Its vault keeps working; this is how it joins the list. */
function LinkBanner({ onDone }: { onDone: () => Promise<void> }): React.JSX.Element {
    const [busy, setBusy] = useState(false);
    const [error, setError] = useState<string | null>(null);

    // The refusal is the answer this press is most likely to get: the browser it
    // is offered to is, by definition, one that was signed in before any of this
    // existed, and the server it is signed in to may well predate it too. Shown
    // rather than swallowed - a button that goes quiet is one somebody presses
    // again all afternoon.
    const ask = async (): Promise<void> => {
        setBusy(true);
        setError(null);
        const reply = await askBackground({ kind: "link" });
        setBusy(false);
        if (!reply.ok) {
            setError(reply.error);
            return;
        }
        await onDone();
    };

    return (
        <div className="notice small">
            This browser is not connected to your Polaris account yet, so it does not appear under
            Sessions.{" "}
            <button className="as-link" disabled={busy} onClick={() => void ask()}>
                Connect it
            </button>
            .
            <Problem text={error} />
        </div>
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
    account,
    onDone
}: {
    server: string;
    connected: boolean;
    /** Whether this account may use a vault at all. */
    canVault: boolean;
    /** Who this browser is connected as, so the screen says whose vault it is
     *  about to open rather than naming a server. */
    account: { name: string | null; email: string | null } | null;
    onDone: () => Promise<void>;
}): React.JSX.Element {
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

    const leave = async (
        request: { kind: "signOut" } | { kind: "forgetServer" } | { kind: "unlink" }
    ): Promise<void> => {
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
        setError(
            reply.waiting === "denied"
                ? "That was turned down in Polaris."
                : "That request ran out. Ask again."
        );
    }, [onDone]);

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
                <h1>Waiting for Polaris</h1>
                <p className="muted">
                    Approve this in the tab that opened. The code there should read:
                </p>
                <code className="value">{waiting.userCode}</code>
                <p className="muted small">
                    Nothing is handed over until somebody with the vault open says yes. You can
                    close this; it carries on without it.
                </p>
                <button className="ghost" onClick={() => void cancel()}>
                    Cancel
                </button>
            </main>
        );
    }

    if (!canVault) {
        return (
            <main className="pad">
                <h1>Connected</h1>
                <p className="muted">{account?.email ?? new URL(server).host}</p>
                <p className="muted small">
                    This account does not have a vault, so there are no logins to fill here yet.
                    Everything else this extension learns to do will work from this connection.
                </p>
                <button className="ghost" onClick={() => void leave({ kind: "unlink" })}>
                    Disconnect this browser
                </button>
            </main>
        );
    }

    return (
        <main className="pad">
            <h1>Your vault</h1>
            <p className="muted">{account?.email ?? new URL(server).host}</p>
            <Problem text={error} />
            <button disabled={busy} onClick={() => void ask()}>
                {busy ? "Asking" : "Connect your vault"}
            </button>
            {/* What it needs, before what it does. The requirement was the last
                clause of the sentence, under a button that said "Sign in with
                Polaris" - so this read as signing in to Polaris, and the vault
                turned up as a surprise on the other tab. What this connects to is
                the password vault; saying so is not a smaller promise, it is the
                true one. */}
            <p className="muted small">
                Approving happens on your dashboard, with your vault open. The key is handed over
                sealed, so only this extension can open it - and it is tied to this connection, so
                disconnecting the browser closes the vault with it.
            </p>
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
                    Sign out of the vault
                </button>
            ) : null}
            {/* Ending the connection, which is the same act as ending it from the
                account's Sessions screen and takes the vault with it. */}
            <button className="ghost" onClick={() => void leave({ kind: "unlink" })}>
                Disconnect this browser
            </button>
        </main>
    );
}

function Unlock({ onDone }: { onDone: () => Promise<void> }): React.JSX.Element {
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
            <h1>Vault locked</h1>
            <input
                autoFocus
                type="password"
                value={password}
                placeholder="Vault master password"
                onChange={(event) => setPassword(event.target.value)}
                onKeyDown={(event) => event.key === "Enter" && void unlock()}
            />
            <Problem text={error} />
            <button disabled={busy || password === ""} onClick={() => void unlock()}>
                {busy ? "Opening" : "Unlock"}
            </button>
        </main>
    );
}

/**
 * Making up a password, where somebody is already signing up for something.
 *
 * Closed until asked for, because most visits here are to read a password rather
 * than to invent one, and a panel of options above the list would be in the way
 * of the common case every time to serve the rare one.
 *
 * The generating is `@polaris/core`'s, the same module the web vault will use, so
 * a password made here and one made there are drawn the same way. This makes a
 * string and saves nothing itself: "Use it" hands it to the form above, and "Copy"
 * hands it to whatever somebody is signing up to.
 */
function Generator({ onUse }: { onUse: (value: string) => void }): React.JSX.Element {
    const [open, setOpen] = useState(false);
    const [length, setLength] = useState(20);
    const [value, setValue] = useState<string | null>(null);
    const [note, setNote] = useState<string | null>(null);
    const clearing = useRef<number | null>(null);

    useEffect(
        () => () => {
            if (clearing.current !== null) window.clearTimeout(clearing.current);
        },
        []
    );

    const make = (at: number): void => {
        setValue(generatePassword({ length: at }));
        setNote(null);
    };

    const show = (): void => {
        setOpen(true);
        make(length);
    };

    const copy = async (): Promise<void> => {
        if (!value) return;
        await navigator.clipboard.writeText(value);
        setNote("Copied. Cleared in 30 seconds if this stays open.");
        if (clearing.current !== null) window.clearTimeout(clearing.current);
        clearing.current = window.setTimeout(() => {
            void navigator.clipboard.writeText("");
        }, CLEAR_AFTER_MS);
    };

    if (!open) {
        return (
            <div className="row">
                <button className="ghost" onClick={show}>
                    Generate a password
                </button>
            </div>
        );
    }

    return (
        <div className="row wrap">
            <code className="value">{value ?? "Nothing can be made of that."}</code>
            <div className="acts">
                <input
                    className="tiny"
                    type="number"
                    min={PASSWORD_MIN_LENGTH}
                    max={PASSWORD_MAX_LENGTH}
                    value={length}
                    aria-label="How many characters"
                    onChange={(event) => {
                        const at = Number.parseInt(event.target.value, 10);
                        setLength(at);
                        if (Number.isFinite(at)) make(at);
                    }}
                />
                <button className="ghost" title="Make another" onClick={() => make(length)}>
                    Again
                </button>
                <button className="ghost" disabled={!value} onClick={() => void copy()}>
                    Copy
                </button>
                <button
                    className="ghost"
                    title="Put it straight into a new login"
                    disabled={!value}
                    onClick={() => {
                        if (value) onUse(value);
                    }}
                >
                    Use it
                </button>
                <button className="ghost" onClick={() => setOpen(false)}>
                    Hide
                </button>
            </div>
            {note ? <p className="muted small">{note}</p> : null}
        </div>
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
    const period = Math.max(1, of);
    const held = Math.max(0, Math.min(period, left));
    const radius = 9;
    const circumference = 2 * Math.PI * radius;
    const tone = held <= 5 ? "danger" : held <= Math.max(8, period / 3) ? "warning" : "success";

    return (
        <span className={`ring ${tone}`} role="timer" aria-label={`${held} seconds left`}>
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

function TotpCell({ id, onCopy }: { id: string; onCopy: () => void }): React.JSX.Element | null {
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
            title="Copy the one-time code"
            aria-label="Copy the one-time code"
            onClick={onCopy}
        >
            <CountdownRing left={left} of={30} />
            <span className="code">{shown}</span>
            <CopyMark />
        </button>
    );
}

/**
 * The mark on a line that can be copied.
 *
 * Hidden until the row is hovered or something in it has focus, which is what
 * lets a login be three readable lines instead of a name and a row of buttons
 * named after the thing they copy. `aria-hidden`, because the line it sits in is
 * already a button with a name of its own - announcing it again would read the
 * same action twice.
 */
function CopyMark(): React.JSX.Element {
    return (
        <svg className="copy-mark" viewBox="0 0 24 24" aria-hidden="true">
            <rect x="9" y="9" width="11" height="11" rx="2" />
            <path d="M5 15V5a2 2 0 0 1 2-2h10" />
        </svg>
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
    label,
    shown,
    mono,
    onCopy
}: {
    label: string;
    shown: string;
    mono?: boolean;
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
            title={`Copy the ${label.toLowerCase()}`}
            aria-label={`Copy the ${label.toLowerCase()}`}
            onClick={onCopy}
        >
            <span className={mono ? "shown mono" : "shown"}>{shown}</span>
            <CopyMark />
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
    const [password, setPassword] = useState("");
    const [refused, setRefused] = useState<string | null>(null);
    const [busy, setBusy] = useState(false);

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
            <span className="muted small">New password for {item.name}</span>
            <input
                autoFocus
                value={password}
                placeholder="The new password"
                aria-label={`New password for ${item.name}`}
                onChange={(event) => setPassword(event.target.value)}
                onKeyDown={(event) => event.key === "Enter" && password !== "" && void submit()}
            />
            <div className="acts">
                <button
                    className="ghost"
                    title="Make one up"
                    onClick={() => setPassword(generatePassword({ length: 20 }) ?? "")}
                >
                    Make one up
                </button>
                <button
                    className="ghost"
                    disabled={busy || password === ""}
                    onClick={() => void submit()}
                >
                    {busy ? "Saving" : "Save"}
                </button>
                <button className="ghost" onClick={onClose}>
                    Cancel
                </button>
            </div>
            <p className="muted small">
                Change it on the site too, or you will be locked out of it.
            </p>
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
    const check = readIntendedLogin(typed);
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
                    {host ? "Save a login for this page" : "Save a login"}
                </button>
            </div>
        );
    }

    return (
        <div className="row wrap">
            <input
                autoFocus
                value={name}
                placeholder="Name"
                aria-label="Name"
                onChange={(event) => setName(event.target.value)}
            />
            <input
                value={username}
                placeholder="Username"
                aria-label="Username"
                onChange={(event) => setUsername(event.target.value)}
            />
            <input
                type="password"
                value={password}
                placeholder="Password"
                aria-label="Password"
                onChange={(event) => setPassword(event.target.value)}
                onKeyDown={(event) => event.key === "Enter" && check.ok && void save()}
            />
            <span className="muted small">
                {url ? `Saved for ${host ?? url}` : "Not tied to any page"}
            </span>
            <div className="acts">
                <button className="ghost" disabled={busy || !check.ok} onClick={() => void save()}>
                    {busy ? "Saving" : "Save"}
                </button>
                <button className="ghost" onClick={() => setOpen(false)}>
                    Cancel
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
    return (
        <div className="row">
            <label className="muted small" htmlFor="vault-timeout">
                Lock after
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
                    {TIMEOUT_CHOICES.map((choice) => (
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
                {active ? (
                    <>
                        Signed in as{" "}
                        <span className="who-name" title={active.email ?? undefined}>
                            {describeAccount(active)}
                        </span>
                    </>
                ) : (
                    "Signing in to another account"
                )}
            </span>
            <div className="acts">
                <button className="ghost" disabled={busy} onClick={() => setOpen(!open)}>
                    {open ? "Hide" : others.length > 0 ? `Switch (${others.length})` : "Accounts"}
                </button>
            </div>
            {open ? (
                <ul className="accounts">
                    {others.map((one) => (
                        <li key={one.id}>
                            <button
                                className="account"
                                disabled={busy}
                                title={`Switch to ${describeAccount(one)}`}
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
                                Add another account
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

    const copy = async (item: ItemSummary, field: "username" | "password" | "totp") => {
        const reply = await askBackground({ kind: "copy", id: item.id, field });
        if (!reply.ok || !("value" in reply)) {
            setNote(reply.ok ? null : reply.error);
            return;
        }
        await navigator.clipboard.writeText(reply.value);
        setNote(
            field === "username"
                ? "Username copied."
                : "Copied. Cleared in 30 seconds if this stays open."
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
                        <span className="vault" title={`Shared from ${item.vault}`}>
                            {item.vault}
                        </span>
                    ) : null}
                </div>
                <Field
                    label="Username"
                    shown={item.username ?? item.host ?? "No username"}
                    onCopy={item.username === null ? null : () => void copy(item, "username")}
                />
                <Field
                    label="Password"
                    shown="••••••••••"
                    mono
                    onCopy={() => void copy(item, "password")}
                />
                {item.totp ? (
                    <TotpCell id={item.id} onCopy={() => void copy(item, "totp")} />
                ) : null}
            </div>
            {/* What is left is the two things that are not "copy that": putting it
                into the page in front of somebody, and replacing the password. */}
            <div className="acts">
                {offerFill ? (
                    <button
                        className="ghost"
                        title="Fill this page"
                        onClick={() => void fill(item)}
                    >
                        Fill
                    </button>
                ) : null}
                <button
                    className="ghost"
                    title="Replace the password"
                    aria-label={`Replace the password for ${item.name}`}
                    onClick={() => setChanging(item)}
                >
                    New
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
                    placeholder="Search your logins"
                    onChange={(event) => setQuery(event.target.value)}
                />
            </header>

            {suggested.length > 0 && query === "" ? (
                <section>
                    <h2>For this page</h2>
                    <ul>{suggested.map((item) => row(item, true))}</ul>
                </section>
            ) : null}

            <section>
                <h2>{query === "" ? "Everything" : "Found"}</h2>
                {found.length === 0 ? (
                    <p className="muted pad">
                        {query === "" ? "No logins saved yet." : "Nothing matches that."}
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

            {here.host ? (
                <div className="row">
                    <span className="muted small">
                        {here.blocked
                            ? `Switched off for ${here.host}.`
                            : `Offering logins for ${here.host}.`}
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
                            {here.blocked ? "Use it here again" : "Never on this site"}
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
                    Sync
                </button>
                <button
                    className="ghost"
                    onClick={() => void askBackground({ kind: "lock" }).then(onChange)}
                >
                    Lock
                </button>
                {/* The way out of a 360-pixel panel and into the whole thing.
                    Everything this extension cannot do - and that is most of
                    Polaris - is one press away instead of an address somebody
                    has to remember they configured here. */}
                {status.server ? (
                    <button
                        className="ghost"
                        title={`Open ${new URL(status.server).host}`}
                        onClick={() => {
                            void browser.tabs.create({ url: status.server as string });
                            window.close();
                        }}
                    >
                        Open Polaris
                    </button>
                ) : null}
                <button
                    className="ghost"
                    onClick={() => void askBackground({ kind: "signOut" }).then(onChange)}
                >
                    Sign out
                </button>
                <span className="muted small grow">
                    {status.syncedAt
                        ? `Synced ${new Date(status.syncedAt).toLocaleTimeString()}`
                        : "Not synced yet"}
                </span>
            </footer>
        </main>
    );
}
