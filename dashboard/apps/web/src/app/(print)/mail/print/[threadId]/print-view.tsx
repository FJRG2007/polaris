"use client";

/**
 * The printed page.
 *
 * Black on white whatever the reader's theme is, because paper is white and a
 * dark theme printed is a page of toner. Each message is drawn through the same
 * sandboxed frame the reading pane uses, on its own white page, so what is
 * printed went through the same sanitizer and the same content policy as what
 * was read - printing is not a way round either of them.
 *
 * The print dialog is asked for once the frames have had a moment to lay out: a
 * frame that has not reported its height yet prints as a short box with its
 * message cut off. The button stays for anybody who cancelled it and wants it
 * back.
 */

import * as core from "@polaris/core";
import { Printer } from "lucide-react";
import { useEffect, useState } from "react";
import { SandboxedHtml } from "@/app/(app)/mail/message-body";
import { useDisplayFormat } from "@/components/display-format";
import type { PrintableThread } from "@/lib/mailbox/printable";

/** How long the frames are given to lay out before the dialog opens. They
 *  report their height on load and again at 300ms; a second covers both. */
const SETTLE_MS = 1000;

export function PrintView({ thread }: { thread: PrintableThread }) {
    const format = useDisplayFormat();
    const [asked, setAsked] = useState(false);

    useEffect(() => {
        if (asked) return;
        const timer = setTimeout(() => {
            setAsked(true);
            window.print();
        }, SETTLE_MS);
        return () => clearTimeout(timer);
    }, [asked]);

    return (
        // The whole window white, not only the column: on a dark theme the page
        // around a white column is what the preview shows before printing.
        <div className="min-h-screen bg-white">
            <main className="mx-auto max-w-3xl bg-white px-6 py-8 text-[#111111] print:max-w-none print:p-0">
                <header className="mb-6 flex items-start gap-4 border-b border-[#dddddd] pb-4">
                    <h1 className="min-w-0 flex-1 text-[20px] font-semibold leading-tight">
                        {thread.subject || "(no subject)"}
                    </h1>
                    <button
                        type="button"
                        className="flex shrink-0 items-center gap-1.5 rounded-md border border-[#cccccc] px-3 py-1.5 text-[13px] print:hidden"
                        onClick={() => window.print()}
                    >
                        <Printer className="size-4 shrink-0" aria-hidden />
                        Print
                    </button>
                </header>

                {thread.leftOut > 0 ? (
                    <p className="mb-4 text-[12px] text-[#555555]">
                        The {thread.leftOut} oldest{" "}
                        {thread.leftOut === 1 ? "message is" : "messages are"} not included.
                    </p>
                ) : null}

                <ol className="space-y-8">
                    {thread.messages.map((message) => (
                        <li key={message.id} className="break-inside-avoid-page">
                            <dl className="mb-3 grid grid-cols-[4rem_1fr] gap-x-2 gap-y-0.5 text-[12px]">
                                <dt className="text-[#555555]">From</dt>
                                <dd>{core.formatAddressList(message.from)}</dd>
                                <dt className="text-[#555555]">To</dt>
                                <dd>{core.formatAddressList(message.to) || "-"}</dd>
                                {message.cc.length > 0 ? (
                                    <>
                                        <dt className="text-[#555555]">Cc</dt>
                                        <dd>{core.formatAddressList(message.cc)}</dd>
                                    </>
                                ) : null}
                                <dt className="text-[#555555]">Date</dt>
                                <dd>{format.dateTime(message.sentAt)}</dd>
                                {message.subject !== thread.subject ? (
                                    <>
                                        <dt className="text-[#555555]">Subject</dt>
                                        <dd>{message.subject || "(no subject)"}</dd>
                                    </>
                                ) : null}
                            </dl>
                            {message.html.trim() || message.text.trim() ? (
                                <SandboxedHtml
                                    html={
                                        message.html.trim()
                                            ? message.html
                                            : core.textToHtml(message.text)
                                    }
                                    showRemote={message.remoteAllowed}
                                    paper="own"
                                />
                            ) : (
                                <p className="text-[13px] text-[#555555]">
                                    This message has nothing in it.
                                </p>
                            )}
                        </li>
                    ))}
                </ol>
            </main>
        </div>
    );
}
