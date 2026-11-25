"use client";

/**
 * Conversation: the scrolling column of a chat that keeps to the newest line.
 *
 * Ported from AI Elements (github.com/vercel/ai-elements,
 * packages/elements/src/conversation.tsx at ca8be60), Apache-2.0 - see the
 * LICENSE beside this file. Changed: Tailwind 3 and Polaris tokens, and the
 * stick-to-bottom behaviour written here (a scroll listener and a
 * ResizeObserver) rather than taken from `use-stick-to-bottom`, so the panel
 * adds no dependency for one effect. As there, only the person's own scroll up
 * (a wheel, touch, key or press) leaves the end.
 */

import { ArrowDown } from "lucide-react";
import { Button, cn } from "@polaris/ui";
import {
    createContext,
    useCallback,
    useContext,
    useEffect,
    useMemo,
    useRef,
    useState,
    type HTMLAttributes,
    type KeyboardEvent,
    type ReactNode,
    type WheelEvent
} from "react";
import { useTranslations } from "@/components/i18n/i18n-provider";

/** How close to the end still counts as "at the end", in pixels. */
const STICK_SLACK = 48;

interface ConversationState {
    atBottom: boolean;
    scrollToBottom: () => void;
    contentRef: (node: HTMLDivElement | null) => void;
}

const ConversationContext = createContext<ConversationState | null>(null);

function useConversation(): ConversationState {
    const state = useContext(ConversationContext);
    if (!state) throw new Error("Conversation parts must be used within Conversation");
    return state;
}

export type ConversationProps = HTMLAttributes<HTMLDivElement>;

/** How long after a wheel, touch, key or press a scroll up is still the
 *  person's own, in milliseconds. */
const INTENT_MS = 1000;

/** Keys that move a scroller up. */
const UP_KEYS = new Set(["ArrowUp", "PageUp", "Home"]);

export function Conversation({ className, children, ...props }: ConversationProps) {
    const scroller = useRef<HTMLDivElement | null>(null);
    const stuck = useRef(true);
    // Where the box was last seen or put, and when the person last reached
    // for it: a scroll up with neither is the browser's, not theirs.
    const lastTop = useRef(0);
    const intent = useRef(0);
    const [atBottom, setAtBottom] = useState(true);
    const [content, setContent] = useState<HTMLDivElement | null>(null);

    const pin = useCallback(() => {
        const node = scroller.current;
        if (!node) return;
        node.scrollTop = node.scrollHeight;
        lastTop.current = node.scrollTop;
    }, []);

    const scrollToBottom = useCallback(() => {
        stuck.current = true;
        setAtBottom(true);
        pin();
    }, [pin]);

    // New text below the fold follows the reader down only while they are
    // already at the end: scrolling up to read something earlier must hold.
    // The box itself is watched too, so a composer growing under the thread
    // does not cover its last line.
    useEffect(() => {
        const node = scroller.current;
        if (!content || !node || typeof ResizeObserver === "undefined") return;
        const observer = new ResizeObserver(() => {
            if (stuck.current) pin();
        });
        observer.observe(content);
        observer.observe(node);
        return () => observer.disconnect();
    }, [content, pin]);

    const leave = () => {
        stuck.current = false;
        setAtBottom(false);
    };

    // Only the person leaves the end. A scroll event the browser raises on
    // its own - the pin's, delivered a frame late after more lines landed, a
    // clamp, an anchoring shift - is put back instead.
    const onScroll = () => {
        const node = scroller.current;
        if (!node) return;
        const top = node.scrollTop;
        const near = node.scrollHeight - top - node.clientHeight <= STICK_SLACK;
        const up = top < lastTop.current;
        lastTop.current = top;
        if (near) {
            stuck.current = true;
            setAtBottom(true);
        } else if (!stuck.current) setAtBottom(false);
        else if (up && Date.now() - intent.current < INTENT_MS) leave();
        else pin();
    };

    const reach = () => {
        intent.current = Date.now();
    };
    const onWheel = (event: WheelEvent<HTMLDivElement>) => {
        reach();
        const node = scroller.current;
        if (event.deltaY < 0 && node && node.scrollHeight > node.clientHeight) leave();
    };
    const onKeyDown = (event: KeyboardEvent<HTMLDivElement>) => {
        if (UP_KEYS.has(event.key) || (event.key === " " && event.shiftKey)) reach();
    };

    const value = useMemo(
        () => ({ atBottom, scrollToBottom, contentRef: setContent }),
        [atBottom, scrollToBottom]
    );
    return (
        <ConversationContext.Provider value={value}>
            <div className={cn("relative min-h-0 flex-1", className)} {...props}>
                <div
                    ref={scroller}
                    onScroll={onScroll}
                    onWheel={onWheel}
                    onTouchStart={reach}
                    onPointerDown={reach}
                    onKeyDown={onKeyDown}
                    role="log"
                    aria-live="polite"
                    className="h-full overflow-y-auto overscroll-contain"
                >
                    {children}
                </div>
                <ConversationScrollButton />
            </div>
        </ConversationContext.Provider>
    );
}

export type ConversationContentProps = HTMLAttributes<HTMLDivElement>;

export function ConversationContent({ className, ...props }: ConversationContentProps) {
    const { contentRef } = useConversation();
    return <div ref={contentRef} className={cn("flex flex-col gap-4 p-3", className)} {...props} />;
}

export function ConversationEmptyState({
    title,
    description,
    icon,
    children,
    className
}: {
    title?: ReactNode;
    description?: ReactNode;
    icon?: ReactNode;
    children?: ReactNode;
    className?: string;
}) {
    return (
        <div className={cn("flex flex-col items-center gap-3 px-4 py-10 text-center", className)}>
            {icon}
            {title ? <p className="text-sm font-medium text-foreground">{title}</p> : null}
            {description ? <p className="text-sm text-muted-foreground">{description}</p> : null}
            {children}
        </div>
    );
}

function ConversationScrollButton() {
    const t = useTranslations("polar");
    const { atBottom, scrollToBottom } = useConversation();
    if (atBottom) return null;
    return (
        <Button
            type="button"
            variant="outline"
            size="icon-sm"
            aria-label={t("elements.scrollDown")}
            title={t("elements.scrollDown")}
            onClick={scrollToBottom}
            className="absolute bottom-3 left-1/2 -translate-x-1/2 bg-elevated shadow-popover"
        >
            <ArrowDown />
        </Button>
    );
}
