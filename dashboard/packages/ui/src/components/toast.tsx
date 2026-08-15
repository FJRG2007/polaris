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
 * - **One per key.** A second note with the same `key` replaces the first
 *   instead of stacking, so ten messages in one conversation are one note that
 *   keeps changing rather than ten.
 */

import { cn } from "../lib/cn";
import { X } from "lucide-react";
import { createPortal } from "react-dom";
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
    /** What pressing it does. Without one the note is not pressable, which is
     *  what keeps a note that leads nowhere from looking like it leads
     *  somewhere. */
    readonly onPress?: () => void;
    /** How long it stays. Zero keeps it until it is dismissed. */
    readonly life?: number;
}

interface Shown extends Toast {
    readonly id: string;
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
        setShown((current) => [...current.filter((one) => one.id !== id), { ...toast, id }].slice(-MOST));
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

    if (!mounted || shown.length === 0 || typeof document === "undefined") return null;

    return createPortal(
        <div className="pointer-events-none fixed right-4 top-4 z-50 flex w-80 max-w-[calc(100vw-2rem)] flex-col gap-2">
            {shown.map((toast) => (
                <ToastNote key={toast.id} toast={toast} onDismiss={() => onDismiss(toast.id)} />
            ))}
        </div>,
        document.body
    );
}

function ToastNote({ toast, onDismiss }: { toast: Shown; onDismiss: () => void }) {
    const [held, setHeld] = useState(false);
    const life = toast.life ?? LIFE_MS;

    useEffect(() => {
        if (held || life <= 0) return;
        const timer = setTimeout(onDismiss, life);
        return () => clearTimeout(timer);
        // Re-armed when the pointer leaves, which is what "hover holds it" is.
    }, [held, life, onDismiss]);

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
                <span className="block truncate text-sm font-medium" title={toast.title}>{toast.title}</span>
                {toast.body ? (
                    <span className="mt-0.5 block line-clamp-2 text-xs text-muted-foreground">
                        {toast.body}
                    </span>
                ) : null}
            </span>
            <button
                type="button"
                aria-label="Dismiss"
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
