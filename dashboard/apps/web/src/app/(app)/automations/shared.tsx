"use client";

/**
 * Pieces every /automations screen shares: a cached loader (last value drawn at
 * once, refetched behind it), the status chip, and run errors in words.
 */

import { Badge, Button, Skeleton } from "@polaris/ui";
import {
    Activity,
    Bell,
    CircleStop,
    Clock,
    Columns3,
    Ear,
    Gauge,
    GitBranch,
    Globe,
    Hand,
    Hourglass,
    LifeBuoy,
    ListChecks,
    ListOrdered,
    Megaphone,
    Merge,
    MessageCircle,
    MessageSquare,
    PhoneIncoming,
    Power,
    Puzzle,
    Radio,
    Repeat,
    Reply,
    Variable,
    Split,
    Sunrise,
    Timer,
    TriangleAlert,
    Webhook,
    Workflow,
    type LucideIcon
} from "lucide-react";
import { useTranslations } from "@/components/i18n/i18n-provider";
import { useCallback, useEffect, useRef, useState, type ReactNode } from "react";

function readCache<T>(key: string): { at: number; value: T } | null {
    try {
        const raw = sessionStorage.getItem(key);
        return raw ? (JSON.parse(raw) as { at: number; value: T }) : null;
    } catch {
        return null;
    }
}

function writeCache(key: string, value: unknown): void {
    try {
        sessionStorage.setItem(key, JSON.stringify({ at: Date.now(), value }));
    } catch {
        // Storage refused (private window, full): the screen works without it.
    }
}

/** Forget a cached answer, for a screen about to open on data that just changed on the server. */
export function dropCache(key: string): void {
    try {
        sessionStorage.removeItem(key);
    } catch {
        // Nothing was kept.
    }
}

export type Loaded<T> = { ok: true } & T;
type Answer<T> = Loaded<T> | { ok: false; error: string };

/**
 * Load through a server action, stale-while-revalidate: a cached answer is
 * shown at once and replaced only when the fresh one differs.
 */
export function useCachedAction<T extends object>(key: string, load: () => Promise<Answer<T>>) {
    const [data, setData] = useState<Loaded<T> | null>(null);
    const [error, setError] = useState<string | null>(null);
    const loader = useRef(load);
    loader.current = load;

    const refresh = useCallback(async () => {
        setError(null);
        try {
            const answer = await loader.current();
            if (!answer.ok) {
                setError(answer.error);
                return;
            }
            setData((before) =>
                JSON.stringify(before) === JSON.stringify(answer) ? before : answer
            );
            writeCache(key, answer);
        } catch {
            setError("");
        }
    }, [key]);

    useEffect(() => {
        const cached = readCache<Loaded<T>>(key);
        if (cached) setData(cached.value);
        // Always revalidated: the cache only spares the first paint the wait.
        void refresh();
    }, [key, refresh]);

    const replace = useCallback(
        (update: (current: Loaded<T>) => Loaded<T>) =>
            setData((current) => {
                if (!current) return current;
                const next = update(current);
                writeCache(key, next);
                return next;
            }),
        [key]
    );

    return { data, error, refresh, replace };
}

export function RowsSkeleton({ rows = 4 }: { rows?: number }) {
    return (
        <div className="space-y-2" aria-hidden="true">
            {Array.from({ length: rows }, (_, index) => (
                <Skeleton key={index} className="h-14 w-full" />
            ))}
        </div>
    );
}

export function LoadFailed({ message, onRetry }: { message: string; onRetry: () => void }) {
    const t = useTranslations("automations");
    return (
        <div
            role="alert"
            className="flex flex-wrap items-center justify-between gap-3 rounded-lg border border-destructive/40 p-4 text-sm"
        >
            <span className="min-w-0">{message}</span>
            <Button variant="outline" size="sm" onClick={onRetry}>
                {t("list.retry")}
            </Button>
        </div>
    );
}

const TONES: Record<string, "neutral" | "primary" | "success" | "warning" | "danger"> = {
    succeeded: "success",
    failed: "danger",
    refused: "danger",
    timedOut: "danger",
    running: "primary",
    waiting: "primary",
    queued: "warning",
    limited: "warning"
};

const STATUSES = [
    "queued",
    "running",
    "waiting",
    "succeeded",
    "failed",
    "stopped",
    "cancelled",
    "refused",
    "limited",
    "skipped",
    "timedOut"
] as const;
type Status = (typeof STATUSES)[number];

export function StatusChip({ status }: { status: string }) {
    const t = useTranslations("automations");
    const known = (STATUSES as readonly string[]).includes(status) ? (status as Status) : "failed";
    return <Badge variant={TONES[known] ?? "neutral"}>{t(`status.${known}`)}</Badge>;
}

const RUN_ERRORS = [
    "alreadyRunning",
    "queueFull",
    "rateLimited",
    "loop",
    "timeout",
    "interrupted",
    "appMissing",
    "runAsGone",
    "badConfig",
    "addressRefused",
    "unreachable",
    "secretMissing",
    "tooManySteps",
    "tooMuchData",
    "runTooLong",
    "cancelledByPerson",
    "restarted",
    "waitTooLong",
    "badUrl",
    "responseTooLarge",
    "tooManyRedirects",
    "graphUnreadable",
    "nodeMissing",
    "notAList",
    "tooManyItems",
    "listTooLarge",
    "stoppedAsFailed",
    "callForbidden",
    "callOff",
    "callNoTrigger",
    "callInputMissing",
    "callInputInvalid",
    "callFailed",
    "callerEnded",
    "answerTooLarge",
    "valuesTooLarge",
    "messageEmpty",
    "messageRefused",
    "webhookGone",
    "webhookReset",
    "webhookForbidden",
    "webhookLimited",
    "announceLimited",
    "announceFailed"
] as const;

/** A stored error code in the reader's words. */
export function useRunError(): (code: string | null) => string | null {
    const t = useTranslations("automations");
    return (code) => {
        if (!code) return null;
        const bare = code.replace(/^finally:/, "");
        if (bare.startsWith("httpStatus:"))
            return t("runErrors.httpStatus", { status: bare.slice("httpStatus:".length) });
        if ((RUN_ERRORS as readonly string[]).includes(bare))
            return t(`runErrors.${bare as (typeof RUN_ERRORS)[number]}`);
        return t("runErrors.other");
    };
}

const NODE_KEYS = {
    "core.manual": "manual",
    "core.schedule": "schedule",
    "core.webhook": "webhook",
    "core.if": "if",
    "core.wait": "wait",
    "core.notify": "notify",
    "core.http": "http",
    "core.chat": "chat",
    "core.message": "message",
    "core.called": "called",
    "core.onEvent": "onEvent",
    "core.failed": "failed",
    "core.switch": "switch",
    "core.parallel": "parallel",
    "core.join": "join",
    "core.forEach": "forEach",
    "core.repeat": "repeat",
    "core.stop": "stop",
    "core.waitEvent": "waitEvent",
    "core.run": "run",
    "core.answer": "answer",
    "core.set": "set",
    "core.announce": "announce",
    "core.try": "try",
    "core.waitCondition": "waitCondition"
} as const;

/**
 * The nodes installable apps bring, named here too: an automation that uses one
 * still reads in words where the app is not installed. Keyed by type.
 */
const APP_NODE_KEYS = {
    "home.trigger.time": "homeTime",
    "home.trigger.interval": "homeInterval",
    "home.trigger.change": "homeChange",
    "home.trigger.stays": "homeStays",
    "home.trigger.threshold": "homeThreshold",
    "home.trigger.sun": "homeSun",
    "home.condition.check": "homeCheck",
    "home.action.device": "homeDevice",
    "home.action.wait": "homeWait",
    "home.action.notify": "homeNotify",
    "home.action.run": "homeRun"
} as const;

type AppNodeKey = (typeof APP_NODE_KEYS)[keyof typeof APP_NODE_KEYS];

const NODE_ICONS: Record<string, LucideIcon> = {
    "home.trigger.time": Clock,
    "home.trigger.interval": Repeat,
    "home.trigger.change": Activity,
    "home.trigger.stays": Timer,
    "home.trigger.threshold": Gauge,
    "home.trigger.sun": Sunrise,
    "home.condition.check": ListChecks,
    "home.action.device": Power,
    "home.action.wait": Hourglass,
    "home.action.notify": Bell,
    "home.action.run": Workflow,
    "core.manual": Hand,
    "core.schedule": Clock,
    "core.webhook": Webhook,
    "core.if": GitBranch,
    "core.wait": Hourglass,
    "core.notify": Bell,
    "core.http": Globe,
    "core.chat": MessageSquare,
    "core.message": MessageCircle,
    "core.called": PhoneIncoming,
    "core.onEvent": Radio,
    "core.failed": TriangleAlert,
    "core.switch": Split,
    "core.parallel": Columns3,
    "core.join": Merge,
    "core.forEach": ListOrdered,
    "core.repeat": Repeat,
    "core.stop": CircleStop,
    "core.waitEvent": Ear,
    "core.run": Workflow,
    "core.answer": Reply,
    "core.set": Variable,
    "core.announce": Megaphone,
    "core.try": LifeBuoy,
    "core.waitCondition": Timer
};

/** A node type's icon; an app's node without one gets the generic piece. */
export function NodeIcon({ type, className }: { type: string; className?: string }) {
    const Icon = NODE_ICONS[type] ?? Puzzle;
    return (
        <Icon aria-hidden="true" className={className ?? "size-4 shrink-0 text-muted-foreground"} />
    );
}

/** A node type's one-line description, or null for an app's node. */
export function nodeHint(
    t: ReturnType<typeof useTranslations<"automations">>,
    type: string
): string | null {
    const key = (NODE_KEYS as Record<string, NodeKey>)[type];
    return key ? t(`nodeHints.${key}`) : null;
}

/** An output port in the reader's words: Then, Else, a Choose case (by its label), a lane, Each, Done, Error, Timed out. */
export function portLabel(
    t: ReturnType<typeof useTranslations<"automations">>,
    node: { readonly type: string; readonly config?: unknown },
    port: string
): string {
    const lane = /^lane(\d+)$/.exec(port);
    if (lane) return t("canvas.ports.lane", { number: lane[1]! });
    const choice = /^case(\d+)$/.exec(port);
    if (choice) {
        const label = ((node.config as { cases?: { label?: string }[] } | undefined)?.cases ?? [])[
            Number(choice[1]) - 1
        ]?.label;
        return label?.trim() || t("canvas.ports.case", { number: choice[1]! });
    }
    const known = [
        "then",
        "else",
        "otherwise",
        "each",
        "done",
        "error",
        "timeout",
        "body",
        "catch",
        "always"
    ] as const;
    return (known as readonly string[]).includes(port)
        ? t(`canvas.ports.${port as (typeof known)[number]}`)
        : t("canvas.ports.next");
}
/**
 * Which pass of each enclosing loop a step ran in, from its iteration path
 * ("0/<loop>:<pass>/..."), counted from 1 and outermost first; null outside a loop.
 */
export function passOf(iteration: string): string | null {
    const passes = iteration
        .split("/")
        .slice(1)
        .map((segment) => Number(segment.slice(segment.lastIndexOf(":") + 1)))
        .filter((pass) => Number.isInteger(pass) && pass >= 0)
        .map((pass) => String(pass + 1));
    return passes.length ? passes.join(".") : null;
}

type NodeKey = (typeof NODE_KEYS)[keyof typeof NODE_KEYS];

/** A node type in the reader's words. */
export function nodeTitle(
    t: ReturnType<typeof useTranslations<"automations">>,
    type: string
): string {
    const key = (NODE_KEYS as Record<string, NodeKey>)[type];
    if (key) return t(`nodes.${key}`);
    const app = (APP_NODE_KEYS as Record<string, AppNodeKey>)[type];
    return app ? t(`appNodes.${app}`) : t("nodes.unknown");
}

export function Section({
    title,
    hint,
    children,
    action
}: {
    title: string;
    hint?: string;
    children: ReactNode;
    action?: ReactNode;
}) {
    return (
        <section className="space-y-3">
            <div className="flex flex-wrap items-end justify-between gap-2">
                <div className="min-w-0">
                    <h2 className="text-sm font-semibold">{title}</h2>
                    {hint ? <p className="text-xs text-muted-foreground">{hint}</p> : null}
                </div>
                {action}
            </div>
            {children}
        </section>
    );
}

export function when(iso: string | null, locale: string): string {
    return iso
        ? new Date(iso).toLocaleString(locale, { dateStyle: "medium", timeStyle: "short" })
        : "";
}
