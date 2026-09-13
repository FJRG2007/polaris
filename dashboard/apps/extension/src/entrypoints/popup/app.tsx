import { useCallback, useEffect, useRef, useState } from "react";
import { askBackground, type ItemSummary, type VaultStatus } from "@/lib/messages";
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

export function App(): React.JSX.Element {
    const [status, refresh] = useStatus();

    // Nothing at all until the worker has answered: a popup that flashed the
    // sign-in screen at somebody whose vault is open would be lying for a frame.
    if (!status) return <main className="pad" />;
    if (!status.server) return <Connect onDone={refresh} />;
    if (!status.connected) return <SignIn server={status.server} onDone={refresh} />;
    if (!status.unlocked) return <Unlock onDone={refresh} />;
    return <Items status={status} onChange={refresh} />;
}

function Problem({ text }: { text: string | null }): React.JSX.Element | null {
    return text ? <p className="problem">{text}</p> : null;
}

function Connect({ onDone }: { onDone: () => Promise<void> }): React.JSX.Element {
    const [typed, setTyped] = useState("");
    const [error, setError] = useState<string | null>(null);
    const [asking, setAsking] = useState(false);

    const connect = async (): Promise<void> => {
        setAsking(true);
        setError(null);
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
            <button disabled={asking || typed.trim() === ""} onClick={() => void connect()}>
                {asking ? "Asking the browser" : "Continue"}
            </button>
            <p className="muted small">
                The browser will ask whether this extension may talk to that address. It is the only
                one it ever reads.
            </p>
        </main>
    );
}

function SignIn({
    server,
    onDone
}: {
    server: string;
    onDone: () => Promise<void>;
}): React.JSX.Element {
    const [email, setEmail] = useState("");
    const [password, setPassword] = useState("");
    const [code, setCode] = useState("");
    const [needsCode, setNeedsCode] = useState(false);
    const [error, setError] = useState<string | null>(null);
    const [busy, setBusy] = useState(false);

    const signIn = async (): Promise<void> => {
        setBusy(true);
        setError(null);
        const reply = await askBackground({
            kind: "signIn",
            email,
            password,
            code: code.trim() === "" ? undefined : code.trim()
        });
        setBusy(false);
        if (!reply.ok) {
            setError(reply.error);
            if (reply.needsCode) setNeedsCode(true);
            return;
        }
        await onDone();
    };

    return (
        <main className="pad">
            <h1>Sign in</h1>
            <p className="muted">{new URL(server).host}</p>
            <input
                autoFocus
                type="email"
                value={email}
                placeholder="you@example.com"
                onChange={(event) => setEmail(event.target.value)}
            />
            <input
                type="password"
                value={password}
                placeholder="Master password"
                onChange={(event) => setPassword(event.target.value)}
                onKeyDown={(event) => event.key === "Enter" && void signIn()}
            />
            {needsCode ? (
                <input
                    autoFocus
                    inputMode="numeric"
                    value={code}
                    placeholder="Code from your authenticator"
                    onChange={(event) => setCode(event.target.value)}
                    onKeyDown={(event) => event.key === "Enter" && void signIn()}
                />
            ) : null}
            <Problem text={error} />
            <button
                disabled={busy || email.trim() === "" || password === ""}
                onClick={() => void signIn()}
            >
                {busy ? "Opening" : "Unlock"}
            </button>
            <p className="muted small">
                The master password never leaves this browser. It is turned into a key here, and what
                goes out cannot be turned back into it.
            </p>
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
            <h1>Locked</h1>
            <input
                autoFocus
                type="password"
                value={password}
                placeholder="Master password"
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
 * a password made here and one made there are drawn the same way. Nothing is
 * saved: this hands over a string, and the item it belongs to is made wherever
 * somebody is signing up.
 */
function Generator(): React.JSX.Element {
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
function TotpCell({ id }: { id: string }): React.JSX.Element | null {
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
        <span className="code" title={`Turns over in ${left} seconds`}>
            {shown} <span className="muted">{left}s</span>
        </span>
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
            if (reply.ok && "blocked" in reply) setHere({ host: reply.host, blocked: reply.blocked });
        })();
    }, []);

    useEffect(() => {
        void (async () => {
            const [tab] = await browser.tabs.query({ active: true, currentWindow: true });
            if (tab?.url && /^https?:/i.test(tab.url)) {
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

    const row = (item: ItemSummary, offerFill: boolean): React.JSX.Element => (
        <li key={item.id}>
            <div className="who">
                <span className="name">{item.name}</span>
                <span className="muted small">{item.username ?? item.host ?? ""}</span>
                {item.totp ? <TotpCell id={item.id} /> : null}
            </div>
            <div className="acts">
                {offerFill ? (
                    <button className="ghost" title="Fill this page" onClick={() => void fill(item)}>
                        Fill
                    </button>
                ) : null}
                <button
                    className="ghost"
                    title="Copy the username"
                    aria-label={`Copy the username for ${item.name}`}
                    onClick={() => void copy(item, "username")}
                >
                    User
                </button>
                <button
                    className="ghost"
                    title="Copy the password"
                    aria-label={`Copy the password for ${item.name}`}
                    onClick={() => void copy(item, "password")}
                >
                    Pass
                </button>
                {item.totp ? (
                    <button
                        className="ghost"
                        title="Copy the one-time code"
                        aria-label={`Copy the one-time code for ${item.name}`}
                        onClick={() => void copy(item, "totp")}
                    >
                        Code
                    </button>
                ) : null}
            </div>
        </li>
    );

    return (
        <main>
            <header>
                <input
                    autoFocus
                    value={query}
                    placeholder="Search the vault"
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
                        {query === "" ? "This vault has no logins yet." : "Nothing matches that."}
                    </p>
                ) : (
                    <ul>{found.map((item) => row(item, false))}</ul>
                )}
            </section>

            <Problem text={note} />

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

            <Generator />

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
