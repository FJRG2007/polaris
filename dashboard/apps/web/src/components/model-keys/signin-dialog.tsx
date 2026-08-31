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
 * So the terminal is here, the command is already running in it, and the person
 * does the two things only they can: authorise in their own browser, and copy
 * the line back. Reading the line off the screen for them is deliberately not
 * attempted - the shape it comes in is not something anybody here has verified,
 * and a parser written against a guess stores the wrong line silently, which
 * shows up as a session failing at a login prompt a week later.
 *
 * The screen is polled rather than streamed. A login is thirty seconds of
 * waiting on somebody else's OAuth, the output is a few lines, and a socket for
 * that would be a socket to keep alive, reconnect and tear down for a dialog
 * that is open for a minute.
 *
 * enigma:allow-no-reset - the masked field is a credential being copied out of
 * the terminal above it, not a password being entered. Nobody signs in to
 * Polaris here; they are already signed in to be looking at it.
 */

import { runAction } from "@/lib/run-action";
import type { AgentSignin } from "@/lib/agents/agent-signins";
import type { SigninView } from "@/lib/agents/signin-runtime";
import { useCallback, useEffect, useRef, useState } from "react";
import { CornerDownLeft, ExternalLink, Loader2, Terminal } from "lucide-react";
import {
    Button,
    Dialog,
    DialogContent,
    DialogFooter,
    DialogHeader,
    DialogTitle,
    Input
} from "@polaris/ui";

/** How often the terminal is re-read. Fast enough that a URL appearing feels
 *  immediate, slow enough that a dialog left open is not a call a second. */
const POLL_MS = 1500;

export interface SigninDialogActions {
    begin: (env: unknown) => Promise<{ id?: string; error?: string }>;
    screen: (id: unknown) => Promise<{ view?: SigninView; error?: string }>;
    answer: (input: unknown) => Promise<{ error?: string }>;
    end: (id: unknown) => Promise<{ error?: string }>;
    save: (secret: string) => Promise<{ error?: string }>;
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
    const [id, setId] = useState<string | null>(null);
    const [screen, setScreen] = useState("");
    const [url, setUrl] = useState<string | null>(null);
    const [ready, setReady] = useState(false);
    const [line, setLine] = useState("");
    const [secret, setSecret] = useState("");
    const [busy, setBusy] = useState(false);
    const [error, setError] = useState<string | null>(null);
    const view = useRef<HTMLPreElement>(null);

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
        // Once, for this credential. `actions` is a stable object from the card.
        // eslint-disable-next-line react-hooks/exhaustive-deps
    }, [signin.env]);

    useEffect(() => {
        if (!id) return;
        let stopped = false;
        const read = () => {
            void actions.screen(id).then((result) => {
                if (stopped || !result.view) return;
                setScreen(result.view.screen);
                setReady(result.view.ready);
                // Kept once found. The terminal scrolls, and an address that
                // scrolled off is one somebody was half way through using.
                if (result.view.url) setUrl(result.view.url);
            });
        };
        read();
        const timer = setInterval(read, POLL_MS);
        return () => {
            stopped = true;
            clearInterval(timer);
        };
        // eslint-disable-next-line react-hooks/exhaustive-deps
    }, [id]);

    // The bottom is where the command is, so that is what stays in view.
    useEffect(() => {
        if (view.current) view.current.scrollTop = view.current.scrollHeight;
    }, [screen]);

    // The container goes when the dialog does, however it goes. Without this a
    // person who closed the tab would leave one running until the sweep, and
    // would be told a sign-in was already open the next time they tried.
    const close = useCallback(() => {
        if (id) void actions.end(id);
        onClose();
        // eslint-disable-next-line react-hooks/exhaustive-deps
    }, [id, onClose]);

    const send = () => {
        if (!id || !line.trim()) return;
        setBusy(true);
        void runAction(() => actions.answer({ id, text: line }), setError).then((result) => {
            setBusy(false);
            if (result?.error) setError(result.error);
            else setLine("");
        });
    };

    const save = () => {
        setBusy(true);
        void runAction(() => actions.save(secret.trim()), setError).then((result) => {
            setBusy(false);
            if (result?.error) {
                setError(result.error);
                return;
            }
            if (id) void actions.end(id);
            onDone();
        });
    };

    return (
        <Dialog open onOpenChange={close}>
            {/* Wide enough for the terminal inside it. The default caps at
                max-w-lg, which put an eighty-column terminal behind a horizontal
                scrollbar and made every line of the login half-visible. */}
            <DialogContent className="max-h-[92vh] w-[min(56rem,96vw)] max-w-[min(56rem,96vw)] overflow-y-auto">
                <DialogHeader>
                    <DialogTitle>Sign in to {signin.serves[0]?.label ?? signin.label}</DialogTitle>
                </DialogHeader>

                <div className="space-y-3">
                    <p className="text-muted-foreground text-xs">
                        Polaris is running the sign-in on a machine of its own. Open the page it asks for, authorise
                        it in your browser, and paste the code it gives you into the line below the terminal.
                    </p>

                    {/* The address, lifted out of the terminal. Every one of these
                        tools signs in by printing a URL and waiting for a code, and
                        every one of them prints it into a box nobody wanted to be
                        reading - three hundred characters that have to be selected
                        without missing the last one. Found by rule rather than per
                        vendor, so a tool nobody has added yet gets the same button. */}
                    {url ? (
                        <a
                            href={url}
                            target="_blank"
                            rel="noreferrer"
                            className="bg-primary/10 border-primary/40 hover:bg-primary/15 flex items-center gap-2 rounded-md border px-3 py-2 text-sm"
                        >
                            <ExternalLink className="size-4 shrink-0" />
                            <span className="min-w-0 flex-1">Open the sign-in page</span>
                        </a>
                    ) : null}

                    {/* Until the machine says anything there is nothing to show, and
                        that is a minute of installing a package - which as a blank
                        box read as broken. */}
                    {ready ? (
                        <pre
                            ref={view}
                            className="bg-elevated h-[26rem] overflow-auto rounded-md border border-border p-3 font-mono text-[11px] leading-snug"
                        >
                            {screen}
                        </pre>
                    ) : (
                        <div className="bg-elevated flex h-[26rem] flex-col items-center justify-center gap-2 rounded-md border border-border">
                            <Loader2 className="text-muted-foreground size-5 shrink-0 animate-spin" />
                            <p className="text-muted-foreground text-xs">
                                {id ? "Installing the tool on it." : "Starting a machine."}
                            </p>
                            <p className="text-muted-foreground text-xs">This takes a minute the first time.</p>
                        </div>
                    )}

                    <div className="flex items-center gap-2">
                        <Terminal className="text-muted-foreground size-4 shrink-0" />
                        <Input
                            value={line}
                            onChange={(event) => setLine(event.target.value)}
                            onKeyDown={(event) => {
                                if (event.key === "Enter") {
                                    event.preventDefault();
                                    send();
                                }
                            }}
                            placeholder="Type into it, then press enter"
                            className="min-w-0 flex-1"
                            disabled={!ready || busy}
                        />
                        <Button size="sm" variant="ghost" onClick={send} disabled={!ready || busy || !line.trim()}>
                            <CornerDownLeft className="size-4 shrink-0" />
                        </Button>
                    </div>

                    <label className="block space-y-1 border-t border-border pt-3">
                        <span className="text-xs text-muted-foreground">
                            When it prints the {signin.label.toLowerCase()}, copy it in here. Polaris does not read
                            it off the screen for you - storing the wrong line would not show up until a session
                            failed to sign in.
                        </span>
                        <Input
                            type="password"
                            value={secret}
                            onChange={(event) => setSecret(event.target.value)}
                            placeholder={signin.label}
                        />
                    </label>

                    {error ? <p className="text-sm text-red-400">{error}</p> : null}
                </div>

                <DialogFooter>
                    <Button variant="ghost" onClick={close}>
                        Cancel
                    </Button>
                    <Button onClick={save} disabled={busy || secret.trim().length === 0}>
                        {busy ? <Loader2 className="size-4 shrink-0 animate-spin" /> : null}
                        Link it
                    </Button>
                </DialogFooter>
            </DialogContent>
        </Dialog>
    );
}
