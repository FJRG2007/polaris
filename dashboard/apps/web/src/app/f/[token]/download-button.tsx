"use client";

/**
 * One file's download button on a quick-send page.
 *
 * Still a plain form post, so nothing is spent by a link previewer that only
 * opens the page. It adds a download ticket to the address and says
 * "Preparing" until the server answers - a file read off a NAS can take a while
 * to start, and a button that looks like it did nothing gets pressed again,
 * which on a one-download file is the download gone. Once it has started the
 * page is read again, so a file with no downloads left is not offered twice.
 */

import { useEffect, useState } from "react";
import { Download, Loader2 } from "lucide-react";
import { useRouter } from "next/navigation";
import { downloadStarted, forgetDownloadTicket, newDownloadTicket } from "@/lib/download-ticket";

/** How often the page looks for the cookie, and for how long. */
const POLL_MS = 250;
const GIVE_UP_MS = 120_000;

export function QuickSendDownload({
    action,
    label,
    namedLabel,
    preparing
}: {
    action: string;
    label: string;
    namedLabel: string;
    preparing: string;
}) {
    const router = useRouter();
    const [ticket, setTicket] = useState<string | null>(null);

    useEffect(() => {
        if (!ticket) return;
        const started = Date.now();
        const timer = setInterval(() => {
            const done = downloadStarted(ticket);
            if (!done && Date.now() - started < GIVE_UP_MS) return;
            clearInterval(timer);
            forgetDownloadTicket(ticket);
            setTicket(null);
            if (done) router.refresh();
        }, POLL_MS);
        return () => clearInterval(timer);
    }, [ticket, router]);

    return (
        <form
            method="post"
            action={action}
            onSubmit={(event) => {
                if (ticket) {
                    event.preventDefault();
                    return;
                }
                const next = newDownloadTicket();
                event.currentTarget.action = `${action}?dl=${next}`;
                setTicket(next);
            }}
        >
            <button
                type="submit"
                aria-disabled={ticket !== null}
                className="inline-flex h-8 shrink-0 items-center gap-1.5 rounded-md bg-primary px-3 text-sm font-medium text-primary-foreground hover:bg-primary/90 aria-disabled:opacity-70"
                aria-label={ticket ? preparing : namedLabel}
            >
                {ticket ? (
                    <Loader2 className="size-4 shrink-0 animate-spin" aria-hidden />
                ) : (
                    <Download className="size-4 shrink-0" aria-hidden />
                )}
                <span className="hidden sm:inline">{ticket ? preparing : label}</span>
            </button>
        </form>
    );
}
