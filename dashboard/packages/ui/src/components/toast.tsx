"use client";

/**
 * A note that appears, says one thing, and goes.
 *
 * The distinction that matters is against the notification bell: that is a
 * record - a list somebody comes back to, clears, and expects to still be there
 * tomorrow - and this is not. A chat message arriving, a file finishing, a save
 * that worked: things worth seeing once, worth nothing afterwards, and things
 * that would bury the four real notifications if they were written down.
 *
 * Top right, because the bottom right is where a call rings and a call must
 * never be covered by a message.
 *
 * Three deliberate limits:
 *
 * - **A stack, capped.** Past `MOST` the oldest goes, so a burst is a few notes
 *   rather than a column down the whole screen.
 * - **Hover holds it.** A note that vanished while it was being read would have
 *   to be gone looking for, which is the opposite of the point.
 * - **Its time runs only while somebody can see it.** A note raised while the
 *   tab is hidden - another tab in front, the window minimised or covered -
 *   waits for them to come back. It used to spend its six seconds unseen: a
 *   chime, somebody turning round to look, and nothing on the screen and nothing
 *   in the bell. A window that is on screen but not the one being typed in is
 *   seen, though: waiting for it to be clicked kept a note there until it was
 *   closed by hand.
 * - **One per key.** A second note with the same `key` replaces the first
 *   instead of stacking, so ten messages in one conversation are one note that
 *   keeps changing rather than ten.
 *
 * A note can also take an answer (`reply`): a message is answered where it
 * arrived, without going to the conversation. The note stays while the answer is
 * being written, says when it went, and goes.
 */

import { cn } from "../lib/cn";
import { Input } from "./input";
import { createPortal } from "react-dom";
import { Loader2, Reply, SendHorizontal, X } from "lucide-react";
import {
    createContext,
    useCallback,
    useContext,
    useEffect,
    useMemo,
    useRef,
    useState,
    type ReactNode
} from "react";
import { useUiStrings } from "../lib/ui-strings";

/** How many are on screen at once. */
const MOST = 4;

/** How long one stays when it is not being hovered. */
const LIFE_MS = 6000;

export interface Toast {
    /** Replaces any note already showing under the same key. Defaults to an id
     *  of its own, so notes stack unless a caller asks otherwise. */
    readonly key?: string;
    readonly title: string;
    readonly body?: string;
    /** Drawn to the left of the words. A face, an icon, anything small. */
    readonly icon?: ReactNode;
    /** Drawn under the words: a picture of what the note is about. Kept to a
     *  bounded box by the note, so the caller only hands over the element. */
    readonly media?: ReactNode;
    /** What pressing it does. Without one the note is not pressable, which is
     *  what keeps a note that leads nowhere from looking like it leads
     *  somewhere. */
    readonly onPress?: () => void;
    /** How long it stays. Zero keeps it until it is dismissed. */
    readonly life?: number;
    /** An answer written on the note itself, for a message. */
    readonly reply?: ToastReply;
    /** Things done from the note without going anywhere: "Mark as read". */
    readonly actions?: readonly ToastAction[];
}

export interface ToastAction {
    readonly label: string;
    readonly icon?: ReactNode;
    /** Does it; answers why it could not, or null. The note goes once it is done. */
    readonly run: () => Promise<string | null>;
}

export interface ToastReply {
    /** What the field says before anything is typed: "Reply to Ana". */
    readonly placeholder: string;
    /** Send it. Answers why it did not go, or null when it did. */
    readonly send: (text: string) => Promise<string | null>;
}

/** How long a note that sent an answer says so before it goes. */
const SENT_MS = 1500;

interface Shown extends Toast {
    readonly id: string;
    /** Which showing this is: a note replaced under the same key is a new one. */
    readonly shownAs: number;
}

interface ToastApi {
    show: (toast: Toast) => void;
    dismiss: (key: string) => void;
}

const Context = createContext<ToastApi | null>(null);

/**
 * The stack, and the way to add to it.
 *
 * Mounted once, high in the tree. Everything below can raise a note without
 * knowing where it will be drawn or what else is on screen.
 */
export function ToastProvider({ children }: { children: ReactNode }) {
    const [shown, setShown] = useState<readonly Shown[]>([]);
    const next = useRef(0);

    const dismiss = useCallback((id: string) => {
        setShown((current) => current.filter((toast) => toast.id !== id));
    }, []);

    const show = useCallback((toast: Toast) => {
        next.current += 1;
        const id = toast.key ?? `toast-${next.current}`;
        setShown((current) =>
            [
                ...current.filter((one) => one.id !== id),
                { ...toast, id, shownAs: next.current }
            ].slice(-MOST)
        );
    }, []);

    const api = useMemo(() => ({ show, dismiss }), [show, dismiss]);

    return (
        <Context.Provider value={api}>
            {children}
            <ToastStack shown={shown} onDismiss={dismiss} />
        </Context.Provider>
    );
}

/**
 * Raise a note.
 *
 * Answers with a no-op outside a provider rather than throwing: a component that
 * can be rendered in a dialog, a public page and the app should not have to know
 * which of them it is in to say something went well.
 */
export function useToast(): ToastApi {
    const found = useContext(Context);
    return (
        found ?? {
            show: () => undefined,
            dismiss: () => undefined
        }
    );
}

function ToastStack({
    shown,
    onDismiss
}: {
    shown: readonly Shown[];
    onDismiss: (id: string) => void;
}) {
    const [mounted, setMounted] = useState(false);
    useEffect(() => setMounted(true), []);

    // One dismiss per note for as long as it is shown. A new one on every draw
    // restarted every note's time whenever another arrived, so a busy chat kept
    // them all on screen.
    const closers = useRef(new Map<string, () => void>());
    const closerOf = (id: string) => {
        let closer = closers.current.get(id);
        if (!closer) {
            closer = () => onDismiss(id);
            closers.current.set(id, closer);
        }
        return closer;
    };
    for (const id of closers.current.keys()) {
        if (!shown.some((toast) => toast.id === id)) closers.current.delete(id);
    }

    if (!mounted || shown.length === 0 || typeof document === "undefined") return null;

    return createPortal(
        <div className="pointer-events-none fixed right-4 top-4 z-50 flex w-80 max-w-[calc(100vw-2rem)] flex-col gap-2">
            {shown.map((toast) => (
                <ToastNote key={toast.id} toast={toast} onDismiss={closerOf(toast.id)} />
            ))}
        </div>,
        document.body
    );
}

/** Whether somebody can see this tab: the browser draws it. Not whether it
 *  has the keyboard - a window on a second screen is read without being clicked. */
function seenNow(): boolean {
    if (typeof document === "undefined") return true;
    return document.visibilityState === "visible";
}

/** Whether the tab is being looked at, kept current. */
function useSeen(): boolean {
    const [seen, setSeen] = useState(seenNow);
    useEffect(() => {
        const update = () => setSeen(seenNow());
        update();
        document.addEventListener("visibilitychange", update);
        return () => document.removeEventListener("visibilitychange", update);
    }, []);
    return seen;
}

function ToastNote({ toast, onDismiss }: { toast: Shown; onDismiss: () => void }) {
    const words = useUiStrings();
    const [held, setHeld] = useState(false);
    /** The answer being written on it: null while nobody has asked to. */
    const [answer, setAnswer] = useState<string | null>(null);
    const [sending, setSending] = useState(false);
    const [sent, setSent] = useState(false);
    const [problem, setProblem] = useState<string | null>(null);
    /** The action under way, by label. */
    const [acting, setActing] = useState<string | null>(null);
    const seen = useSeen();
    const life = toast.life ?? LIFE_MS;
    // Writing an answer holds the note like a pointer over it does: it must not
    // go in the middle of a sentence.
    const writing = answer !== null || sending || acting !== null;
    // A note replaced while it said "Sent" is about something new, which has not
    // been answered; an answer half written or on its way is kept.
    const showing = useRef(toast.shownAs);
    showing.current = toast.shownAs;
    useEffect(() => setSent(false), [toast.shownAs]);

    useEffect(() => {
        if (!sent) return;
        const timer = setTimeout(onDismiss, SENT_MS);
        return () => clearTimeout(timer);
    }, [sent, onDismiss]);

    const send = async () => {
        const text = (answer ?? "").trim();
        if (!toast.reply || text.length === 0 || sending) return;
        setSending(true);
        setProblem(null);
        const sentFrom = showing.current;
        const refused = await toast.reply.send(text).catch(() => words.couldNotSend);
        setSending(false);
        if (refused) {
            setProblem(refused);
            return;
        }
        setAnswer(null);
        if (showing.current === sentFrom) setSent(true);
    };

    const act = async (action: ToastAction) => {
        if (acting) return;
        const actedFrom = showing.current;
        setActing(action.label);
        setProblem(null);
        const refused = await action.run().catch(() => words.didNotWork);
        setActing(null);
        if (showing.current !== actedFrom) return;
        if (refused) setProblem(refused);
        else onDismiss();
    };

    useEffect(() => {
        if (held || writing || sent || !seen || life <= 0) return;
        const timer = setTimeout(onDismiss, life);
        return () => clearTimeout(timer);
        // Re-armed when the pointer leaves, which is what "hover holds it" is,
        // and when somebody comes back to the tab, which is when they can read it.
    }, [held, writing, sent, seen, life, onDismiss, toast.shownAs]);

    const pressable = Boolean(toast.onPress);

    return (
        <div
            role="status"
            onMouseEnter={() => setHeld(true)}
            onMouseLeave={() => setHeld(false)}
            className={cn(
                "pointer-events-auto flex items-start gap-2.5 rounded-lg border border-border-strong bg-elevated p-3 shadow-modal transition-colors",
                pressable && "cursor-pointer hover:bg-card-hover"
            )}
            onClick={
                pressable
                    ? () => {
                          toast.onPress?.();
                          onDismiss();
                      }
                    : undefined
            }
        >
            {toast.icon ? <span className="mt-0.5 shrink-0">{toast.icon}</span> : null}
            <span className="min-w-0 flex-1">
                <span className="block truncate text-sm font-medium" title={toast.title}>
                    {toast.title}
                </span>
                {toast.body ? (
                    <span className="mt-0.5 block line-clamp-2 text-xs text-muted-foreground">
                        {toast.body}
                    </span>
                ) : null}
                {toast.media ? (
                    <span className="mt-2 flex max-h-40 overflow-hidden rounded-md empty:hidden">
                        {toast.media}
                    </span>
                ) : null}
                {toast.reply || toast.actions?.length ? (
                    // Pressing anything here answers or acts; it does not open
                    // what the note points at.
                    <span className="mt-2 block" onClick={(event) => event.stopPropagation()}>
                        {sent ? (
                            <span className="block text-xs text-muted-foreground">{words.sent}</span>
                        ) : answer === null || !toast.reply ? (
                            <span className="flex flex-wrap items-center gap-1">
                                {toast.reply ? (
                                    <button
                                        type="button"
                                        onClick={() => setAnswer("")}
                                        disabled={acting !== null}
                                        className="inline-flex items-center gap-1 rounded px-1.5 py-0.5 text-xs font-medium text-primary transition-colors hover:bg-card-hover disabled:opacity-50"
                                    >
                                        <Reply className="size-3.5" />
                                        {words.reply}
                                    </button>
                                ) : null}
                                {toast.actions?.map((action) => (
                                    <button
                                        key={action.label}
                                        type="button"
                                        onClick={() => void act(action)}
                                        disabled={acting !== null}
                                        className="inline-flex items-center gap-1 rounded px-1.5 py-0.5 text-xs font-medium text-muted-foreground transition-colors hover:bg-card-hover hover:text-foreground disabled:opacity-50"
                                    >
                                        {acting === action.label ? (
                                            <Loader2 className="size-3.5 animate-spin" />
                                        ) : (
                                            action.icon
                                        )}
                                        {action.label}
                                    </button>
                                ))}
                            </span>
                        ) : (
                            <span className="flex items-center gap-1.5">
                                <Input
                                    autoFocus
                                    value={answer}
                                    disabled={sending}
                                    onChange={(event) => setAnswer(event.target.value)}
                                    onKeyDown={(event) => {
                                        if (event.key === "Enter" && !event.shiftKey) {
                                            event.preventDefault();
                                            void send();
                                        } else if (event.key === "Escape") {
                                            event.preventDefault();
                                            setAnswer(null);
                                            setProblem(null);
                                        }
                                    }}
                                    placeholder={toast.reply?.placeholder}
                                    aria-label={toast.reply?.placeholder}
                                    maxLength={4000}
                                    className="h-8 min-w-0 flex-1 text-xs"
                                />
                                <button
                                    type="button"
                                    onClick={() => void send()}
                                    disabled={sending || answer.trim().length === 0}
                                    aria-label={words.send}
                                    title={words.send}
                                    className="shrink-0 rounded p-1.5 text-primary transition-colors hover:bg-card-hover disabled:opacity-50"
                                >
                                    {sending ? (
                                        <Loader2 className="size-3.5 animate-spin" />
                                    ) : (
                                        <SendHorizontal className="size-3.5" />
                                    )}
                                </button>
                            </span>
                        )}
                        {problem ? (
                            <span role="alert" className="mt-1 block text-xs text-danger">
                                {problem}
                            </span>
                        ) : null}
                    </span>
                ) : null}
            </span>
            <button
                type="button"
                aria-label={words.dismiss}
                onClick={(event) => {
                    // The note itself may be pressable, and dismissing is not
                    // the same as opening what it points at.
                    event.stopPropagation();
                    onDismiss();
                }}
                className="shrink-0 rounded p-0.5 text-muted-foreground transition-colors hover:text-foreground"
            >
                <X className="size-3.5" />
            </button>
        </div>
    );
}
