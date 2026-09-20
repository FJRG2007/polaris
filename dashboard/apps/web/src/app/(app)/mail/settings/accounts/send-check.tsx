"use client";

/**
 * "Is sending from this mailbox actually set up right?"
 *
 * The one question the rest of this screen cannot answer. A green tick beside a
 * mailbox means the last conversation with its servers worked - which is a
 * password being accepted, not a message arriving. So this sends one, from the
 * mailbox to itself, through the ordinary queue, and reports what came back.
 *
 * The wording holds the line the whole feature exists for. For a mailbox at
 * somebody else's provider the best honest answer after sending is "your
 * provider took it", and that is what it says while nothing further is known.
 * Only the message coming back into the mailbox is allowed to say sending works.
 */

import { z } from "zod";
import { Button, cn, useToast } from "@polaris/ui";
import { useCallback, useEffect, useRef, useState } from "react";
import { CheckCircle2, Loader2, MailCheck, Send, TriangleAlert } from "lucide-react";

const checkSchema = z.object({
    stage: z.enum(["none", "sending", "refused", "accepted", "arrived", "bounced"]),
    startedAt: z.string(),
    detail: z.string(),
    waiting: z.boolean()
});

type Check = z.infer<typeof checkSchema>;

/** How often the answer is asked for again while something is still expected.
 *  The round trip through two servers is measured in seconds to minutes, and a
 *  screen that asked every second would be asking a hundred times for nothing. */
const POLL_MS = 5_000;
/** Long enough for a slow provider, short enough that a tab left open overnight
 *  is not still asking. Past it the answer stands as whatever it last was, which
 *  is "accepted, and it has not come back", and that is a true thing to leave on
 *  the screen. */
const POLL_FOR_MS = 5 * 60 * 1000;

export function SendCheck({ accountId }: { accountId: string }) {
    const toast = useToast();
    const [check, setCheck] = useState<Check | null>(null);
    const [busy, setBusy] = useState(false);
    /** When this screen started waiting, so the polling stops on its own. */
    const since = useRef(0);

    const read = useCallback(async () => {
        const response = await fetch(
            `/api/mail/send-check?accountId=${encodeURIComponent(accountId)}`,
            { cache: "no-store" }
        ).catch(() => null);
        if (!response?.ok) return;
        const parsed = checkSchema.safeParse(await response.json().catch(() => null));
        // A tab left open across an update is talking to a server that may answer
        // in a shape it has not seen. Nothing is better than a wrong verdict here.
        if (parsed.success) setCheck(parsed.data);
    }, [accountId]);

    // What the last check found, before anybody presses anything: a check
    // started before this page was reloaded still has its answer.
    useEffect(() => {
        void read();
    }, [read]);

    useEffect(() => {
        if (!check?.waiting) return;
        if (since.current === 0) since.current = Date.now();
        if (Date.now() - since.current > POLL_FOR_MS) return;
        const timer = setTimeout(() => void read(), POLL_MS);
        return () => clearTimeout(timer);
    }, [check, read]);

    const start = () => {
        setBusy(true);
        since.current = Date.now();
        void (async () => {
            const response = await fetch("/api/mail/send-check", {
                method: "POST",
                cache: "no-store",
                headers: { "content-type": "application/json" },
                body: JSON.stringify({ accountId })
            }).catch(() => null);
            setBusy(false);
            const body: unknown = await response?.json().catch(() => null);
            const parsed = checkSchema.safeParse(body);
            if (parsed.success) {
                setCheck(parsed.data);
                return;
            }
            const said = (body as { error?: unknown } | null)?.error;
            toast.show({
                title: typeof said === "string" ? said : "That check could not be started."
            });
        })();
    };

    const look = lookOf(check);
    return (
        <div className="mt-2 flex flex-wrap items-start gap-2 border-t border-border/60 pt-2">
            <p
                className={cn(
                    "flex min-w-0 flex-1 items-start gap-1.5 text-[12px]",
                    look.tone
                )}
            >
                <look.Icon
                    className={cn("mt-px size-3.5 shrink-0", look.spin && "animate-spin")}
                    aria-hidden
                />
                <span className="min-w-0">{look.text}</span>
            </p>
            <Button
                size="sm"
                variant="outline"
                className="shrink-0"
                disabled={busy || check?.stage === "sending"}
                onClick={start}
            >
                {check && check.stage !== "none" ? "Check again" : "Check sending"}
            </Button>
        </div>
    );
}

/** The sentence and the mark that goes with it. */
function lookOf(check: Check | null): {
    text: string;
    tone: string;
    spin: boolean;
    Icon: typeof Send;
} {
    if (!check || check.stage === "none") {
        return {
            text: "Sends a message from this mailbox to itself and reports what happens to it.",
            tone: "text-muted-foreground",
            spin: false,
            Icon: Send
        };
    }
    if (check.stage === "sending") {
        return { text: check.detail, tone: "text-muted-foreground", spin: true, Icon: Loader2 };
    }
    if (check.stage === "refused" || check.stage === "bounced") {
        return { text: check.detail, tone: "text-danger", spin: false, Icon: TriangleAlert };
    }
    if (check.stage === "arrived") {
        return { text: check.detail, tone: "text-foreground-subtle", spin: false, Icon: CheckCircle2 };
    }
    return { text: check.detail, tone: "text-foreground-subtle", spin: false, Icon: MailCheck };
}
