"use client";

/**
 * Signing an agent in, with the machine supplied.
 *
 * What this replaces was a sentence telling somebody to go and find a computer
 * where the tool was installed and already signed in, remember a command, run
 * it, and come back with what it printed. On a deployment whose whole premise is
 * that nobody opens a terminal, that was the instruction least likely to be
 * followed.
 *
 * So the vendor's own CLI runs on a machine Polaris starts, and the dialog shows
 * what it asks for. A device-code login (Copilot, Codex) is two steps - open the
 * page, type the code - and the dialog shows exactly those, as lifted off the
 * screen, then notices on its own that the CLI said it was done and keeps the
 * login. A login that wants a code typed back (Gemini's authorization code,
 * Claude's) is the same two steps with a field for the code, and a login that
 * prints its token (Claude's) is kept the moment the token is on the screen.
 * Either way the raw terminal is one click away, and it opens on its own with
 * the copy field under it if the token could not be read.
 *
 * The screen is polled rather than streamed. A login is thirty seconds of
 * waiting on somebody else's OAuth, the output is a few lines, and a socket for
 * that would be a socket to keep alive, reconnect and tear down for a dialog
 * that is open for a minute. The polling stops when the login ends, when the
 * dialog closes, and at the attempt's own lifetime at the latest.
 *
 * enigma:allow-no-reset - the masked field is a credential being copied out of
 * the terminal above it, not a password being entered. Nobody signs in to
 * Polaris here; they are already signed in to be looking at it.
 */

import { runAction } from "@/lib/run-action";
import type { AgentSignin } from "@/lib/agents/agent-signins";
import type { SigninIdentity, SigninView } from "@/lib/agents/signin-runtime";
import { useCallback, useEffect, useRef, useState } from "react";
import { CheckCircle2, ChevronDown, CornerDownLeft, ExternalLink, Loader2, Terminal } from "lucide-react";
import { useTranslations } from "@/components/i18n/i18n-provider";
import {
    Button,
    CopyIcon,
    Dialog,
    DialogContent,
    DialogFooter,
    DialogHeader,
    DialogTitle,
    Input,
    useCopied
} from "@polaris/ui";

/** How often the terminal is re-read. Fast enough that a code appearing feels
 *  immediate, slow enough that a dialog left open is not a call a second. */
const POLL_MS = 1500;

/** The most reads one attempt gets: its container is taken away after fifteen
 *  minutes, so a poll past that is a call that can only fail. */
const MAX_POLLS = Math.ceil((15 * 60 * 1000) / POLL_MS);

/** How many times a finished login's file is asked for before saying so. The
 *  CLI may print its success line a moment before the file is on disk. */
const MAX_AUTO_LINKS = 5;

export interface SigninDialogActions {
    begin: (env: unknown) => Promise<{ id?: string; error?: string }>;
    screen: (id: unknown) => Promise<{ view?: SigninView; error?: string }>;
    answer: (input: unknown) => Promise<{ error?: string }>;
    end: (id: unknown) => Promise<{ error?: string }>;
    /** Whose account it turned out to be, asked while the container is still
     *  there. Empty for a tool that will not say. */
    identity: (input: unknown) => Promise<SigninIdentity>;
    /** The credential file the login wrote, for a tool that keeps its login in
     *  a file. Absent on a screen that offers only pasted tokens. */
    capture?: (input: unknown) => Promise<{ value?: string; error?: string }>;
    save: (secret: string, identity: SigninIdentity, name: string) => Promise<{ error?: string }>;
}

export function SigninDialog({
    signin,
    actions,
    onClose,
    onDone
}: {
    signin: AgentSignin;
    actions: SigninDialogActions;
    onClose: () => void;
    onDone: () => void;
}) {
    const t = useTranslations("components");
    const tcommon = useTranslations("common");
    // Bumped by "Start again", which runs the whole thing on a fresh machine.
    const [round, setRound] = useState(0);
    const [id, setId] = useState<string | null>(null);
    const [view, setView] = useState<SigninView | null>(null);
    const [url, setUrl] = useState<string | null>(null);
    const [expired, setExpired] = useState(false);
    const [line, setLine] = useState("");
    const [secret, setSecret] = useState("");
    // What to call this one. Asked because an account may hold several - a
    // personal subscription and a work one - and "Claude subscription token"
    // twice is a list nobody can choose from.
    const [name, setName] = useState("");
    const [busy, setBusy] = useState(false);
    const [linked, setLinked] = useState(false);
    const [error, setError] = useState<string | null>(null);
    // Null until somebody chooses: then the flow decides, open for a login that
    // wants typing and folded for one that only wants a code typed elsewhere.
    const [showTerminal, setShowTerminal] = useState<boolean | null>(null);
    // Set when a login that prints its token finished and no token could be
    // read: the person copies it in instead, which is what this was before.
    const [manual, setManual] = useState(false);
    const autoLinks = useRef(0);
    // Bumped by every automatic attempt that found nothing yet, so the next one
    // is scheduled even when the answer came back too fast for `busy` to be seen
    // changing: React folds the two into one render and the effect never reran.
    const [retries, setRetries] = useState(0);
    const terminal = useRef<HTMLPreElement>(null);

    const ready = view?.ready ?? false;
    const device = view?.flow === "device";
    const code = view?.code ?? null;
    const finished = view?.finished ?? false;
    const stopped = view !== null && view.exitCode !== null && !finished;
    const capture = (signin.file || signin.onScreen) && !manual ? actions.capture : undefined;
    // Folded while Polaris drives the login itself; open where the person has
    // to read something off it.
    const terminalOpen = showTerminal ?? (!device && !capture);

    // Started as the dialog opens: there is nothing to ask first, and a machine
    // that takes a minute to install the tool should be doing it while the
    // person reads what is about to happen.
    useEffect(() => {
        let cancelled = false;
        void actions.begin(signin.env).then((result) => {
            if (cancelled) return;
            if (result.error) setError(result.error);
            else if (result.id) setId(result.id);
        });
        return () => {
            cancelled = true;
        };
        // Once per round, for this credential. `actions` is a stable object from
        // the card.
        // eslint-disable-next-line react-hooks/exhaustive-deps
    }, [signin.env, round]);

    // Read until the login has an outcome: kept, or the command over. After
    // either the screen has nothing new to say.
    const settled = linked || (view !== null && view.exitCode !== null);
    useEffect(() => {
        if (!id || settled) return;
        let off = false;
        let polls = 0;
        const read = () => {
            polls += 1;
            if (polls > MAX_POLLS) {
                off = true;
                clearInterval(timer);
                setExpired(true);
                return;
            }
            void actions.screen(id).then((result) => {
                if (off || !result.view) return;
                setView(result.view);
                // Kept once found. The terminal scrolls, and an address that
                // scrolled off is one somebody was half way through using.
                if (result.view.url) setUrl(result.view.url);
            });
        };
        const timer = setInterval(read, POLL_MS);
        read();
        return () => {
            off = true;
            clearInterval(timer);
        };
        // eslint-disable-next-line react-hooks/exhaustive-deps
    }, [id, settled]);

    // The bottom is where the command is, so that is what stays in view.
    useEffect(() => {
        if (terminal.current) terminal.current.scrollTop = terminal.current.scrollHeight;
    }, [view?.screen, terminalOpen]);

    // The container goes when the dialog does, however it goes. Without this a
    // person who closed the tab would leave one running until the sweep, and
    // would be told a sign-in was already open the next time they tried.
    const close = useCallback(() => {
        if (linked) {
            onDone();
            return;
        }
        if (id) void actions.end(id);
        onClose();
        // eslint-disable-next-line react-hooks/exhaustive-deps
    }, [id, linked, onClose, onDone]);

    const restart = () => {
        if (id) void actions.end(id);
        setId(null);
        setView(null);
        setUrl(null);
        setExpired(false);
        setError(null);
        setLine("");
        setManual(false);
        setShowTerminal(null);
        autoLinks.current = 0;
        setRound((value) => value + 1);
    };

    const send = () => {
        if (!id || !line.trim()) return;
        setBusy(true);
        void runAction(() => actions.answer({ id, text: line }), setError).then((result) => {
            setBusy(false);
            if (result?.error) setError(result.error);
            else setLine("");
        });
    };

    // `quiet` is the automatic attempt after the CLI said it was done: a file
    // not there yet is a retry on the next read, not an error on the screen.
    const link = useCallback(
        (quiet: boolean) => {
            setBusy(true);
            // The identity is read before the container goes, because after
            // that there is nothing left to ask. A tool that will not answer
            // costs a label on a row, never the credential.
            void (async () => {
                const report = quiet ? () => undefined : setError;
                const identity: SigninIdentity = id
                    ? await actions.identity({ id, env: signin.env }).catch(() => ({}))
                    : {};
                let value = secret.trim();
                if (capture) {
                    const captured = id ? await runAction(() => capture({ id, env: signin.env }), report) : null;
                    if (!captured?.value) {
                        setBusy(false);
                        const givenUp = !quiet || autoLinks.current >= MAX_AUTO_LINKS;
                        // Only once the login is over: pressed early, the token
                        // is simply not printed yet.
                        if (givenUp && signin.onScreen && finished) {
                            setManual(true);
                            setShowTerminal(true);
                        } else if (captured?.error && givenUp) {
                            setError(captured.error);
                        }
                        if (quiet) setRetries((value) => value + 1);
                        return;
                    }
                    value = captured.value;
                }
                const label =
                    name.trim() || shortName(view?.signedInAs ?? "") || shortName(identity.email ?? identity.organization ?? "");
                const result = await runAction(() => actions.save(value, identity, label || "account"), setError);
                setBusy(false);
                if (result?.error) {
                    setError(result.error);
                    return;
                }
                setError(null);
                setLinked(true);
                if (id) void actions.end(id);
            })();
        },
        // eslint-disable-next-line react-hooks/exhaustive-deps
        [id, secret, name, capture, view?.signedInAs, signin.env, signin.onScreen, finished]
    );

    // Kept the moment the CLI says it worked, with no button to find. Only for
    // a login that leaves a file, and only after it said so - a file read while
    // the login is still under way is exactly what must not be kept.
    useEffect(() => {
        if (!finished || !capture || linked || busy || autoLinks.current >= MAX_AUTO_LINKS) return;
        // A retry waits a poll's length: the file may land a moment after the
        // line that announced it.
        const timer = setTimeout(
            () => {
                autoLinks.current += 1;
                link(true);
            },
            autoLinks.current === 0 ? 0 : POLL_MS
        );
        return () => clearTimeout(timer);
    }, [finished, capture, linked, busy, link, retries]);

    const openLabel = url ? hostOf(url) : null;
    const showLink = !linked && (!device || finished || stopped);

    return (
        <Dialog open onOpenChange={close}>
            {/* Wide enough for the terminal inside it. The default caps at
                max-w-lg, which put an eighty-column terminal behind a horizontal
                scrollbar and made every line of the login half-visible. */}
            <DialogContent className="max-h-[92vh] w-[min(48rem,96vw)] max-w-[min(48rem,96vw)] overflow-y-auto overscroll-contain">
                <DialogHeader>
                    <DialogTitle>{t("signinDialog.title", { tool: signin.serves[0]?.label ?? signin.label })}</DialogTitle>
                </DialogHeader>

                <div className="flex flex-col gap-3">
                    <p className="text-muted-foreground text-xs">{t("signinDialog.intro")}</p>
                    {/* Worth saying before rather than after: the vendor may well
                        retire whatever it minted last time, and finding that out
                        from a session that stopped working is finding it out in
                        the worst place. */}
                    {signin.subscription && !linked ? (
                        <p className="text-muted-foreground text-xs">{t("signinDialog.subscription")}</p>
                    ) : null}

                    {linked ? (
                        <div className="bg-elevated flex flex-col items-center gap-2 rounded-md border border-border px-4 py-8 text-center">
                            <CheckCircle2 className="text-success-ink size-8 shrink-0" />
                            <p className="min-w-0 break-words text-sm font-medium">
                                {view?.signedInAs
                                    ? t("signinDialog.signedInAs", { login: view.signedInAs })
                                    : t("signinDialog.signedIn")}
                            </p>
                            <p className="text-muted-foreground text-xs">{t("signinDialog.linked")}</p>
                        </div>
                    ) : !ready && !expired && !error ? (
                        // Until the machine says anything there is nothing to show,
                        // and that is a minute of installing a package - which as a
                        // blank box read as broken.
                        <div className="bg-elevated flex h-48 flex-col items-center justify-center gap-2 rounded-md border border-border">
                            <Loader2 className="text-muted-foreground size-5 shrink-0 animate-spin" />
                            <p className="text-muted-foreground text-xs">
                                {id ? t("signinDialog.installing") : t("signinDialog.starting")}
                            </p>
                            <p className="text-muted-foreground text-xs">{t("signinDialog.firstTime")}</p>
                        </div>
                    ) : ready && device && !stopped && !expired ? (
                        <DeviceSteps
                            url={url}
                            openLabel={openLabel}
                            code={code}
                            finished={finished}
                            signedInAs={view?.signedInAs ?? null}
                        />
                    ) : ready && !device && !stopped && !expired ? (
                        <PasteSteps
                            url={url}
                            line={line}
                            onLine={setLine}
                            onSend={send}
                            // The terminal has its own line under it; one field
                            // for the same thing is enough.
                            field={!terminalOpen}
                            busy={busy || settled}
                            finished={finished && Boolean(capture)}
                        />
                    ) : null}

                    {(stopped || expired) && !linked ? (
                        <div className="flex flex-wrap items-center gap-2">
                            <p className="text-danger min-w-0 flex-1 text-sm">
                                {expired ? t("signinDialog.expired") : t("signinDialog.ended")}
                            </p>
                            <Button size="sm" variant="outline" onClick={restart}>
                                {t("signinDialog.restart")}
                            </Button>
                        </div>
                    ) : null}

                    {view?.fellBack && !linked ? (
                        <p className="text-muted-foreground text-xs" role="status">
                            {t("signinDialog.fellBack")}
                        </p>
                    ) : null}

                    {/* Only the CLI rung has a terminal. The direct rung is the
                        vendor's endpoints called from the server, with nothing
                        to type and nothing to show. */}
                    {ready && !linked && view?.rung !== "direct" ? (
                        <div className="flex flex-col gap-2">
                            <Button
                                size="sm"
                                variant="ghost"
                                className="self-start"
                                aria-expanded={terminalOpen}
                                onClick={() => setShowTerminal(!terminalOpen)}
                            >
                                <Terminal className="size-4 shrink-0" />
                                {terminalOpen ? t("signinDialog.hideTerminal") : t("signinDialog.showTerminal")}
                                <ChevronDown
                                    className={`size-4 shrink-0 transition-transform ${terminalOpen ? "rotate-180" : ""}`}
                                />
                            </Button>
                            {terminalOpen ? (
                                <>
                                    <pre
                                        ref={terminal}
                                        className="bg-elevated h-72 overflow-auto overscroll-contain whitespace-pre-wrap break-words rounded-md border border-border p-3 font-mono text-[0.6875rem] leading-snug"
                                    >
                                        {view?.screen}
                                    </pre>
                                    <div className="flex items-center gap-2">
                                        <Input
                                            value={line}
                                            onChange={(event) => setLine(event.target.value)}
                                            onKeyDown={(event) => {
                                                if (event.key === "Enter") {
                                                    event.preventDefault();
                                                    send();
                                                }
                                            }}
                                            placeholder={t("signinDialog.typeHere")}
                                            aria-label={t("signinDialog.typeHere")}
                                            className="min-w-0 flex-1"
                                            disabled={busy || settled}
                                        />
                                        <Button
                                            size="icon-sm"
                                            variant="ghost"
                                            onClick={send}
                                            aria-label={t("signinDialog.typeHere")}
                                            disabled={busy || settled || !line.trim()}
                                        >
                                            <CornerDownLeft className="size-4 shrink-0" />
                                        </Button>
                                    </div>
                                </>
                            ) : null}
                        </div>
                    ) : null}

                    {!linked ? (
                        <label className="block space-y-1 border-t border-border pt-3">
                            <span className="text-xs text-muted-foreground">{t("signinDialog.nameHint")}</span>
                            <Input
                                value={name}
                                onChange={(event) => setName(event.target.value)}
                                placeholder={t("signinDialog.namePlaceholder")}
                            />
                        </label>
                    ) : null}

                    {linked || device ? null : capture ? (
                        <p className="text-xs text-muted-foreground">
                            {signin.onScreen ? t("signinDialog.tokenHint") : t("signinDialog.fileHint")}
                        </p>
                    ) : (
                        <label className="block space-y-1">
                            <span className="text-xs text-muted-foreground">
                                {manual ? t("signinDialog.tokenMissed") : t("signinDialog.copyIn")}
                            </span>
                            <Input
                                type="password"
                                value={secret}
                                onChange={(event) => setSecret(event.target.value)}
                                placeholder={signin.label}
                            />
                        </label>
                    )}

                    {error ? <p className="text-sm text-danger">{error}</p> : null}
                </div>

                <DialogFooter>
                    {linked ? (
                        <Button onClick={onDone}>{t("signinDialog.done")}</Button>
                    ) : (
                        <>
                            <Button variant="ghost" onClick={close}>
                                {tcommon("actions.cancel")}
                            </Button>
                            {showLink ? (
                                <Button
                                    onClick={() => link(false)}
                                    disabled={busy || (capture ? !ready : secret.trim().length === 0)}
                                >
                                    {busy ? <Loader2 className="size-4 shrink-0 animate-spin" /> : null}
                                    {t("signinDialog.link")}
                                </Button>
                            ) : null}
                        </>
                    )}
                </DialogFooter>
            </DialogContent>
        </Dialog>
    );
}

/** The two steps of a login that wants a code typed back: open the page, then
 *  paste what it shows into a field of its own rather than into a terminal. */
function PasteSteps({
    url,
    line,
    onLine,
    onSend,
    field,
    busy,
    finished
}: {
    url: string | null;
    line: string;
    onLine: (value: string) => void;
    onSend: () => void;
    field: boolean;
    busy: boolean;
    finished: boolean;
}) {
    const t = useTranslations("components");
    return (
        <ol className="bg-elevated flex flex-col gap-4 rounded-md border border-border p-4">
            <li className="flex min-w-0 flex-col gap-2">
                <span className="text-sm">
                    <span className="text-muted-foreground mr-2 font-mono">1</span>
                    {t("signinDialog.pasteStepOpen")}
                </span>
                {url ? (
                    <Button asChild variant="primary" size="md" className="max-w-full self-start">
                        <a href={url} target="_blank" rel="noopener noreferrer" title={url}>
                            <ExternalLink className="size-4 shrink-0" />
                            <span className="min-w-0 truncate">{t("signinDialog.openPage")}</span>
                        </a>
                    </Button>
                ) : (
                    <span className="text-muted-foreground flex items-center gap-2 text-xs">
                        <Loader2 className="size-4 shrink-0 animate-spin" />
                        {t("signinDialog.gettingPage")}
                    </span>
                )}
            </li>
            <li className="flex min-w-0 flex-col gap-2">
                <span className="text-sm">
                    <span className="text-muted-foreground mr-2 font-mono">2</span>
                    {t("signinDialog.pasteStepCode")}
                </span>
                {field ? (
                    <div className="flex items-center gap-2">
                        <Input
                            value={line}
                            onChange={(event) => onLine(event.target.value)}
                            onKeyDown={(event) => {
                                if (event.key === "Enter") {
                                    event.preventDefault();
                                    onSend();
                                }
                            }}
                            placeholder={t("signinDialog.codePlaceholder")}
                            aria-label={t("signinDialog.codePlaceholder")}
                            autoComplete="off"
                            spellCheck={false}
                            className="min-w-0 flex-1 font-mono"
                            disabled={busy}
                        />
                        <Button
                            size="icon-sm"
                            variant="outline"
                            onClick={onSend}
                            aria-label={t("signinDialog.pasteStepCode")}
                            title={t("signinDialog.pasteStepCode")}
                            disabled={busy || !line.trim()}
                        >
                            <CornerDownLeft className="size-4 shrink-0" />
                        </Button>
                    </div>
                ) : null}
            </li>
            {finished ? (
                <li className="text-muted-foreground flex items-center gap-2 text-xs" aria-live="polite">
                    <Loader2 className="size-4 shrink-0 animate-spin" />
                    {t("signinDialog.linking")}
                </li>
            ) : null}
        </ol>
    );
}

/** The two steps of a device-code login, as the CLI printed them. */
function DeviceSteps({
    url,
    openLabel,
    code,
    finished,
    signedInAs
}: {
    url: string | null;
    openLabel: string | null;
    code: string | null;
    finished: boolean;
    signedInAs: string | null;
}) {
    const t = useTranslations("components");
    const { copied, copy } = useCopied();

    if (!code) {
        return (
            <div className="bg-elevated flex h-48 flex-col items-center justify-center gap-2 rounded-md border border-border">
                <Loader2 className="text-muted-foreground size-5 shrink-0 animate-spin" />
                <p className="text-muted-foreground text-xs">{t("signinDialog.gettingCode")}</p>
            </div>
        );
    }

    return (
        <ol className="bg-elevated flex flex-col gap-4 rounded-md border border-border p-4">
            <li className="flex min-w-0 flex-col gap-2">
                <span className="text-sm">
                    <span className="text-muted-foreground mr-2 font-mono">1</span>
                    {t("signinDialog.deviceStepOpen")}
                </span>
                {url ? (
                    <Button asChild variant="primary" size="md" className="max-w-full self-start">
                        <a href={url} target="_blank" rel="noopener noreferrer" title={url}>
                            <ExternalLink className="size-4 shrink-0" />
                            <span className="min-w-0 truncate">
                                {openLabel ? t("signinDialog.deviceOpen", { host: openLabel }) : t("signinDialog.openPage")}
                            </span>
                        </a>
                    </Button>
                ) : null}
            </li>
            <li className="flex min-w-0 flex-col gap-2">
                <span className="text-sm">
                    <span className="text-muted-foreground mr-2 font-mono">2</span>
                    {t("signinDialog.deviceStepCode")}
                </span>
                <div className="flex flex-wrap items-center gap-3">
                    <code className="select-all rounded-md border border-border bg-background px-3 py-1.5 font-mono text-2xl font-semibold tracking-[0.2em]">
                        {code}
                    </code>
                    <Button variant="outline" size="sm" onClick={() => void copy(code)}>
                        <CopyIcon copied={copied} />
                        {t("signinDialog.copyCode")}
                    </Button>
                </div>
            </li>
            <li className="text-muted-foreground flex items-center gap-2 text-xs" aria-live="polite">
                <Loader2 className="size-4 shrink-0 animate-spin" />
                <span className="min-w-0 break-words">
                    {finished
                        ? signedInAs
                            ? `${t("signinDialog.signedInAs", { login: signedInAs })} - ${t("signinDialog.linking")}`
                            : t("signinDialog.linking")
                        : t("signinDialog.waiting")}
                </span>
            </li>
        </ol>
    );
}

/** "github.com/login/device" for the button, or null for an address that does
 *  not parse - which then gets the generic label instead of a wrong one. */
function hostOf(url: string): string | null {
    try {
        const parsed = new URL(url);
        return `${parsed.host}${parsed.pathname.replace(/\/$/, "")}`;
    } catch {
        return null;
    }
}

/**
 * What to call a row nobody named.
 *
 * The login, or the address it belongs to, since that is the thing somebody
 * holding two of these is telling apart. The store's names are short and have
 * no @ in them, so an address becomes the part people actually read.
 */
function shortName(from: string): string {
    const cleaned = from.split("@")[0]?.replace(/[^A-Za-z0-9_-]/g, "-") ?? "";
    return cleaned.slice(0, 20);
}
