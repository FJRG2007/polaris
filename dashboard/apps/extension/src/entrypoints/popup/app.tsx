import { useCallback, useEffect, useRef, useState } from "react";
import { askBackground, type ItemSummary, type VaultStatus } from "@/lib/messages";

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

/** How long a copied password stays on the clipboard. */
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
        setNote(field === "username" ? "Username copied." : "Copied, and cleared in 30 seconds.");
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
