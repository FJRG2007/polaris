"use client";

/**
 * The way off a mailing list, wherever it is offered.
 *
 * One component because there are three places it appears - above an open
 * message, on a row of the subscriptions screen, and on a conversation in the
 * list - and a button that does something this consequential must not behave
 * differently depending on which of them somebody pressed.
 *
 * What it does depends on what the sender published, and the difference is not
 * cosmetic:
 *
 * - A page (`link`) is a link, not a button. It opens in the reader's own tab
 *   the instant they press it, with no round trip in between, because a tab
 *   opened after an `await` is a tab the browser blocks as a popup - and the
 *   marking is fired off alongside rather than waited for.
 * - A one-click (`one-click`) or a `mailto` is something Polaris does on the
 *   reader's behalf, to somebody else's server, from their address. That is
 *   confirmed first, in a dialog that says which of the two it is going to be.
 *
 * A one-click the sender's own server refuses is not reported as a failure and
 * not silently swallowed: the same address works in a browser, so the dialog
 * turns into the link, which is the honest outcome and the one thing the reader
 * can still act on.
 *
 * The dialog also says where the way out came from, and it only matters for one
 * combination: a `mailto` Polaris read out of a message body. A header is
 * something the sender published on every message they send; an address in a
 * body is whatever was written in a body, and one written to look like an
 * unsubscribe footer is how somebody finds out a mailbox is real. Polaris still
 * offers it - the small newsletters this feature exists for put their only way
 * out there - but it says plainly what pressing it reveals, rather than the
 * "nothing else is shared with them" that is true of a published header.
 */

import * as core from "@polaris/core";
import { refusalOf } from "./refusal";
import { useRouter } from "next/navigation";
import type { ButtonProps } from "@polaris/ui";
import { useState, useTransition } from "react";
import { BellOff, ExternalLink, Loader2 } from "lucide-react";
import { unsubscribeAction, unsubscribeFromMessageAction } from "./actions";
import { Button, Dialog, DialogContent, DialogHeader, DialogTitle, useToast } from "@polaris/ui";

/** What is being left, and which of the two ways in the row was pressed. */
export interface UnsubscribeTarget {
    readonly kind: core.UnsubscribeOffer["kind"];
    readonly url: string;
    /** Whether the sender published this or Polaris read it out of the message.
     *  What the dialog promises depends on it. */
    readonly source: core.UnsubscribeOffer["source"];
    /** Who the mail is from, for the sentence in the dialog and the toast. */
    readonly sender: string;
    /** The registry row, when the press came from the subscriptions screen. */
    readonly subscriptionId?: string;
    /** The message, when it came from one being read. Works on mail that arrived
     *  before the registry existed. */
    readonly messageId?: string;
}

export function UnsubscribeButton({
    target,
    label = "Unsubscribe",
    variant = "secondary",
    size = "sm",
    iconOnly = false,
    className
}: {
    target: UnsubscribeTarget;
    label?: string;
    variant?: ButtonProps["variant"];
    size?: ButtonProps["size"];
    /** For the toolbar that appears on a row under the pointer, where every
     *  other action is an icon and a label would be a column of its own. The
     *  words stay, as the accessible name and the tooltip. */
    iconOnly?: boolean;
    className?: string;
}) {
    const router = useRouter();
    const toast = useToast();
    const [asking, setAsking] = useState(false);
    /** Set when the only thing left is their page: a plain link nobody has
     *  opened yet, or a one-click their server would not take. */
    const [fallback, setFallback] = useState("");
    const [working, startWorking] = useTransition();

    function run(): void {
        startWorking(async () => {
            const answer = target.subscriptionId
                ? await unsubscribeAction(target.subscriptionId)
                : await unsubscribeFromMessageAction(target.messageId ?? "");
            const said = refusalOf(answer);
            if (said) {
                toast.show({ title: said });
                return;
            }
            const outcome = "outcome" in answer ? answer.outcome : null;
            setAsking(false);
            router.refresh();
            if (outcome?.done) {
                toast.show({
                    title:
                        outcome.kind === "mailto"
                            ? `Asked ${target.sender} to stop, by mail.`
                            : `Unsubscribed from ${target.sender}.`
                });
                return;
            }
            // Their server would not take the one-click. The page still works.
            if (outcome?.open) setFallback(outcome.open);
        });
    }

    /** A page is opened by the press itself, and the row is marked alongside. */
    function markInBackground(): void {
        startWorking(async () => {
            const answer = target.subscriptionId
                ? await unsubscribeAction(target.subscriptionId)
                : await unsubscribeFromMessageAction(target.messageId ?? "");
            if (!refusalOf(answer)) router.refresh();
        });
    }

    if (target.kind === "link") {
        return (
            <Button
                variant={iconOnly ? "ghost" : variant}
                size={iconOnly ? "icon-xs" : size}
                className={className}
                aria-label={iconOnly ? label : undefined}
                title={iconOnly ? label : undefined}
                asChild
            >
                <a
                    href={target.url}
                    target="_blank"
                    rel="noopener noreferrer nofollow"
                    onClick={(event) => {
                        event.stopPropagation();
                        markInBackground();
                    }}
                >
                    <BellOff className="size-3.5 shrink-0" aria-hidden />
                    {iconOnly ? null : label}
                </a>
            </Button>
        );
    }

    return (
        <>
            <Button
                variant={iconOnly ? "ghost" : variant}
                size={iconOnly ? "icon-xs" : size}
                className={className}
                disabled={working}
                aria-label={iconOnly ? label : undefined}
                title={iconOnly ? label : undefined}
                // The row this can sit on is itself a link to the
                // conversation, so the press is stopped from reaching it.
                onClick={(event) => {
                    event.preventDefault();
                    event.stopPropagation();
                    setAsking(true);
                }}
            >
                {working ? (
                    <Loader2 className="size-3.5 shrink-0 animate-spin" aria-hidden />
                ) : (
                    <BellOff className="size-3.5 shrink-0" aria-hidden />
                )}
                {iconOnly ? null : label}
            </Button>

            <Dialog
                open={asking || Boolean(fallback)}
                onOpenChange={(next) => {
                    if (next) return;
                    setAsking(false);
                    setFallback("");
                }}
            >
                <DialogContent>
                    <DialogHeader>
                        <DialogTitle>
                            {fallback
                                ? "Finish this on their page"
                                : `Unsubscribe from ${target.sender}?`}
                        </DialogTitle>
                    </DialogHeader>

                    {fallback ? (
                        <p className="text-[13px] text-muted-foreground">
                            Their server did not accept the request Polaris sent. The page below is
                            the same address, opened as you rather than as this server.
                        </p>
                    ) : (
                        <p className="text-[13px] text-muted-foreground">
                            {target.kind !== "mailto"
                                ? "Polaris will tell their server directly. Nothing is opened, and they learn nothing about you that this message did not already carry."
                                : target.source === "body"
                                  ? `Polaris will send a message from this mailbox to an address it found inside the mail, not in a header ${target.sender} published. If the mail was not really from them, sending it tells whoever wrote it that this address is read.`
                                  : "Polaris will send them a message from this mailbox asking to be taken off. Nothing else is shared with them."}
                        </p>
                    )}

                    <div className="mt-4 flex justify-end gap-2">
                        <Button
                            variant="ghost"
                            size="sm"
                            onClick={() => {
                                setAsking(false);
                                setFallback("");
                            }}
                        >
                            {fallback ? "Close" : "Keep receiving"}
                        </Button>
                        {fallback ? (
                            <Button size="sm" asChild>
                                <a
                                    href={fallback}
                                    target="_blank"
                                    rel="noopener noreferrer nofollow"
                                    onClick={() => setFallback("")}
                                >
                                    <ExternalLink className="size-3.5 shrink-0" aria-hidden />
                                    Open their page
                                </a>
                            </Button>
                        ) : (
                            <Button size="sm" disabled={working} onClick={run}>
                                {working ? (
                                    <Loader2
                                        className="size-3.5 shrink-0 animate-spin"
                                        aria-hidden
                                    />
                                ) : null}
                                Unsubscribe
                            </Button>
                        )}
                    </div>
                </DialogContent>
            </Dialog>
        </>
    );
}
