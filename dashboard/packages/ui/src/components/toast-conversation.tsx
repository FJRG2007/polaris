"use client";

/**
 * A note about a message, drawn the way a phone draws one.
 *
 * Modelled on Android's MessagingStyle and iOS's grouped message notifications:
 * the sender's face, who wrote and where, the last few lines of the conversation
 * rather than only the newest, a count when the note stands for more than one
 * message, and its actions as a row of icons under the words - each named for a
 * screen reader and on hover, since an icon alone says nothing to either.
 *
 * Answering opens a field in place of that row. Pressing the words opens the
 * conversation; it is a real button, so the keyboard reaches it like the rest.
 * Escape, the close button or a sideways swipe sends it away, and a pointer or
 * the keyboard resting on it holds it.
 */

import { cn } from "../lib/cn";
import { Input } from "./input";
import { useNoteState, type Shown } from "./toast-state";
import type { ToastAction, ToastConversation } from "./toast";
import { Check, Loader2, Reply, SendHorizontal, X } from "lucide-react";
import { useRef, useState, type PointerEvent, type ReactNode } from "react";

/** How many of the latest lines are drawn. */
const LINES = 3;

/** How far a note is swiped before letting go sends it away. */
const SWIPE_PX = 96;

/** How far a pointer moves before a press becomes a swipe. */
const DRAG_PX = 8;

const ICON_BUTTON =
    "inline-flex size-8 shrink-0 items-center justify-center rounded-md text-muted-foreground transition-colors hover:bg-card-hover hover:text-foreground disabled:opacity-50";

export function ConversationNote({
    toast,
    conversation,
    onDismiss
}: {
    toast: Shown;
    conversation: ToastConversation;
    onDismiss: () => void;
}) {
    const {
        words,
        setHeld,
        answer,
        setAnswer,
        sending,
        sent,
        problem,
        setProblem,
        acting,
        choosing,
        setChoosing,
        send,
        act
    } = useNoteState(toast, onDismiss);
    const swipe = useSwipe(onDismiss);

    const lines = conversation.lines.slice(-LINES);
    const count = conversation.count ?? 0;
    const open = toast.onPress
        ? () => {
              toast.onPress?.();
              onDismiss();
          }
        : undefined;

    const content = (
        <>
            {toast.icon ? (
                <span className="flex w-9 shrink-0 justify-center">{toast.icon}</span>
            ) : null}
            <span className="min-w-0 flex-1">
                <span className="flex min-w-0 items-baseline gap-1.5 pr-7">
                    <span
                        className="min-w-0 truncate text-sm font-semibold text-foreground"
                        title={conversation.sender}
                    >
                        {conversation.sender}
                    </span>
                    {conversation.where ? (
                        <span
                            className="min-w-0 shrink-[2] truncate text-xs text-muted-foreground"
                            title={conversation.where}
                        >
                            {conversation.where}
                        </span>
                    ) : null}
                    {count > 1 ? (
                        <span
                            className="ml-auto shrink-0 rounded-full bg-primary/15 px-1.5 text-[11px] font-semibold leading-4 text-primary tabular-nums"
                            title={conversation.countLabel}
                        >
                            <span aria-hidden="true">{count}</span>
                            <span className="sr-only">{conversation.countLabel ?? count}</span>
                        </span>
                    ) : null}
                </span>
                {lines.map((line, index) => (
                    <span
                        key={line.id}
                        className={cn(
                            "mt-0.5 block text-[13px] leading-snug text-muted-foreground",
                            lines.length === 1 ? "line-clamp-2" : "truncate",
                            index < lines.length - 1 && "text-foreground-subtle"
                        )}
                    >
                        {line.author ? (
                            <span className="font-medium text-foreground">{line.author} </span>
                        ) : null}
                        {line.text}
                    </span>
                ))}
                {toast.media ? (
                    <span className="mt-2 flex max-h-40 overflow-hidden rounded-md empty:hidden">
                        {toast.media}
                    </span>
                ) : null}
            </span>
        </>
    );

    const hasFooter = Boolean(toast.reply || toast.actions?.length);

    return (
        <div
            role="status"
            data-conversation-note=""
            onMouseEnter={() => setHeld(true)}
            onMouseLeave={() => setHeld(false)}
            onFocus={() => setHeld(true)}
            onBlur={(event) => {
                if (!event.currentTarget.contains(event.relatedTarget as Node | null)) {
                    setHeld(false);
                }
            }}
            onKeyDown={(event) => {
                // The reply field handles its own Escape: it closes the field.
                if (event.key === "Escape" && !event.defaultPrevented) {
                    event.preventDefault();
                    if (choosing) {
                        if (acting === null) {
                            setChoosing(null);
                            setProblem(null);
                        }
                    } else {
                        onDismiss();
                    }
                }
            }}
            className={cn(
                "pointer-events-auto relative motion-safe:animate-in motion-safe:fade-in-0 motion-safe:slide-in-from-right-4",
                count > 1 && "pb-1.5"
            )}
        >
            {/* The stack behind it: more than one message is waiting here. */}
            {count > 1 ? (
                <span
                    aria-hidden="true"
                    className="absolute inset-x-3 bottom-0 h-3 rounded-b-lg border border-t-0 border-border-strong bg-elevated"
                />
            ) : null}
            <div
                {...swipe.handlers}
                style={swipe.style}
                className={cn(
                    "relative touch-pan-y rounded-lg border border-border-strong bg-elevated p-3 shadow-modal",
                    !swipe.dragging && "transition-[transform,opacity] duration-200"
                )}
            >
                {open ? (
                    <button
                        type="button"
                        onClick={open}
                        className="-m-1 flex w-[calc(100%+0.5rem)] min-w-0 items-start gap-3 rounded-md p-1 text-left transition-colors hover:bg-card-hover"
                    >
                        {content}
                    </button>
                ) : (
                    <div className="flex min-w-0 items-start gap-3">{content}</div>
                )}
                <button
                    type="button"
                    aria-label={words.dismiss}
                    title={words.dismiss}
                    onClick={onDismiss}
                    className="absolute right-1.5 top-1.5 inline-flex size-7 items-center justify-center rounded-md text-muted-foreground transition-colors hover:bg-card-hover hover:text-foreground"
                >
                    <X className="size-3.5" />
                </button>
                {hasFooter ? (
                    <div className={cn("mt-1.5", toast.icon && "pl-12")}>
                        {sent ? (
                            <span className="flex items-center gap-1 py-1.5 text-xs text-muted-foreground">
                                <Check className="size-3.5" />
                                {words.sent}
                            </span>
                        ) : choosing ? (
                            <Choices
                                action={choosing}
                                acting={acting}
                                cancel={words.cancel}
                                onChoose={(choice) => void act(choice)}
                                onCancel={() => {
                                    setChoosing(null);
                                    setProblem(null);
                                }}
                            />
                        ) : answer !== null && toast.reply ? (
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
                                    placeholder={toast.reply.placeholder}
                                    aria-label={toast.reply.placeholder}
                                    maxLength={4000}
                                    className="h-8 min-w-0 flex-1 text-xs"
                                />
                                <button
                                    type="button"
                                    onClick={() => void send()}
                                    disabled={sending || answer.trim().length === 0}
                                    aria-label={words.send}
                                    title={words.send}
                                    className={cn(ICON_BUTTON, "text-primary hover:text-primary")}
                                >
                                    {sending ? (
                                        <Loader2 className="size-4 animate-spin" />
                                    ) : (
                                        <SendHorizontal className="size-4" />
                                    )}
                                </button>
                            </span>
                        ) : (
                            <span className="-ml-1.5 flex flex-wrap items-center gap-0.5">
                                {toast.reply ? (
                                    <button
                                        type="button"
                                        onClick={() => setAnswer("")}
                                        disabled={acting !== null}
                                        aria-label={words.reply}
                                        title={words.reply}
                                        className={cn(ICON_BUTTON, "text-primary hover:text-primary")}
                                    >
                                        <Reply className="size-4" />
                                    </button>
                                ) : null}
                                {toast.actions?.map((action) => (
                                    <IconAction
                                        key={action.label}
                                        label={action.label}
                                        busy={acting === action.label}
                                        disabled={acting !== null}
                                        onPress={() =>
                                            action.choices?.length
                                                ? setChoosing(action)
                                                : void act(action)
                                        }
                                    >
                                        {action.icon ?? action.label}
                                    </IconAction>
                                ))}
                            </span>
                        )}
                        {problem ? (
                            <span role="alert" className="mt-1 block text-xs text-danger">
                                {problem}
                            </span>
                        ) : null}
                    </div>
                ) : null}
            </div>
        </div>
    );
}

function IconAction({
    label,
    busy,
    disabled,
    onPress,
    children
}: {
    label: string;
    busy: boolean;
    disabled: boolean;
    onPress: () => void;
    children: ReactNode;
}) {
    return (
        <button
            type="button"
            onClick={onPress}
            disabled={disabled}
            aria-label={label}
            title={label}
            className={ICON_BUTTON}
        >
            {busy ? <Loader2 className="size-4 animate-spin" /> : children}
        </button>
    );
}

/** The ways of doing an action - "Mute" for an hour, a day - laid out on the
 *  note in place of its icons, so nothing is drawn over the stack. */
function Choices({
    action,
    acting,
    cancel,
    onChoose,
    onCancel
}: {
    action: ToastAction;
    acting: string | null;
    cancel: string;
    onChoose: (choice: { label: string; run: () => Promise<string | null> }) => void;
    onCancel: () => void;
}) {
    const chip =
        "inline-flex items-center gap-1 rounded-md px-2 py-1 text-xs font-medium text-muted-foreground transition-colors hover:bg-card-hover hover:text-foreground disabled:opacity-50";
    return (
        <span className="-ml-1.5 flex flex-wrap items-center gap-1">
            <span className="inline-flex min-w-0 items-center gap-1 px-1.5 py-1 text-xs font-medium text-foreground">
                {action.icon}
                <span className="truncate" title={action.label}>{action.label}</span>
            </span>
            {action.choices?.map((choice) => (
                <button
                    key={choice.label}
                    type="button"
                    onClick={() => onChoose(choice)}
                    disabled={acting !== null}
                    className={chip}
                >
                    {acting === choice.label ? <Loader2 className="size-3.5 animate-spin" /> : null}
                    {choice.label}
                </button>
            ))}
            <button type="button" onClick={onCancel} disabled={acting !== null} className={chip}>
                {cancel}
            </button>
        </span>
    );
}

/**
 * Sideways swipe to send a note away, the way a phone's notification goes.
 *
 * A press that never moved past `DRAG_PX` stays a press. One that did is a swipe,
 * and the click it would end in is swallowed, so letting go of a swipe over the
 * words does not also open the conversation.
 */
function useSwipe(onDismiss: () => void) {
    const start = useRef<{ x: number; pointer: number } | null>(null);
    const moved = useRef(false);
    const offset = useRef(0);
    const [dx, setDx] = useState(0);
    const [dragging, setDragging] = useState(false);

    const end = () => {
        if (!start.current) return;
        start.current = null;
        setDragging(false);
        if (Math.abs(offset.current) >= SWIPE_PX) {
            onDismiss();
            return;
        }
        offset.current = 0;
        setDx(0);
    };

    return {
        dragging,
        style: dx
            ? {
                  transform: `translateX(${dx}px)`,
                  opacity: Math.max(0.2, 1 - Math.abs(dx) / (SWIPE_PX * 2.5))
              }
            : undefined,
        handlers: {
            onPointerDown: (event: PointerEvent<HTMLDivElement>) => {
                if (event.button !== 0) return;
                if ((event.target as Element).closest("input, textarea")) return;
                start.current = { x: event.clientX, pointer: event.pointerId };
                moved.current = false;
            },
            onPointerMove: (event: PointerEvent<HTMLDivElement>) => {
                if (!start.current || start.current.pointer !== event.pointerId) return;
                const distance = event.clientX - start.current.x;
                if (!moved.current) {
                    if (Math.abs(distance) < DRAG_PX) return;
                    moved.current = true;
                    setDragging(true);
                    event.currentTarget.setPointerCapture?.(event.pointerId);
                }
                offset.current = distance;
                setDx(distance);
            },
            onPointerUp: end,
            onPointerCancel: end,
            onClickCapture: (event: { stopPropagation: () => void; preventDefault: () => void }) => {
                if (!moved.current) return;
                moved.current = false;
                event.stopPropagation();
                event.preventDefault();
            }
        }
    };
}
