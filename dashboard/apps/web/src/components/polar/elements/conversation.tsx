"use client";

/**
 * Conversation: the scrolling column of a chat that keeps to the newest line.
 *
 * Ported from AI Elements (github.com/vercel/ai-elements,
 * packages/elements/src/conversation.tsx at ca8be60), Apache-2.0 - see the
 * LICENSE beside this file. Changed: Tailwind 3 and Polaris tokens, and the
 * stick-to-bottom behaviour written here (a scroll listener and a
 * ResizeObserver) rather than taken from `use-stick-to-bottom`, so the panel
 * adds no dependency for one effect.
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
    type ReactNode
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

export function Conversation({ className, children, ...props }: ConversationProps) {
    const scroller = useRef<HTMLDivElement | null>(null);
    const stuck = useRef(true);
    const [atBottom, setAtBottom] = useState(true);
    const [content, setContent] = useState<HTMLDivElement | null>(null);

    const scrollToBottom = useCallback(() => {
        const node = scroller.current;
        if (!node) return;
        stuck.current = true;
        setAtBottom(true);
        node.scrollTop = node.scrollHeight;
    }, []);

    // New text below the fold follows the reader down only while they are
    // already at the end: scrolling up to read something earlier must hold.
    useEffect(() => {
        if (!content || typeof ResizeObserver === "undefined") return;
        const observer = new ResizeObserver(() => {
            const node = scroller.current;
            if (node && stuck.current) node.scrollTop = node.scrollHeight;
        });
        observer.observe(content);
        return () => observer.disconnect();
    }, [content]);

    const onScroll = () => {
        const node = scroller.current;
        if (!node) return;
        const near = node.scrollHeight - node.scrollTop - node.clientHeight <= STICK_SLACK;
        stuck.current = near;
        setAtBottom(near);
    };

    const value = useMemo(() => ({ atBottom, scrollToBottom, contentRef: setContent }), [atBottom, scrollToBottom]);
    return (
        <ConversationContext.Provider value={value}>
            <div className={cn("relative min-h-0 flex-1", className)} {...props}>
                <div
                    ref={scroller}
                    onScroll={onScroll}
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
