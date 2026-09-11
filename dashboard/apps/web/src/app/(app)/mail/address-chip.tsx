"use client";

/**
 * One address in an open message, and what can be done with it.
 *
 * A mail client's header is a row of people, and every one of them is something
 * somebody wants to act on: copy it into a form, write to them, find the rest of
 * what they sent, stop them writing. Polaris drew them as text, so all of that
 * meant selecting the address by hand and hoping the selection did not take the
 * name with it.
 *
 * So each one is a chip: a copy button under the pointer, and the rest on the
 * right-click - which is where every mail client anybody has used keeps it.
 *
 * **The name and the address are shown together only when they differ.** Half of
 * what arrives sets the display name to the address itself, and that drew the
 * same string twice on one line with a dash between it, which reads as two
 * different people to somebody scanning.
 */

import * as core from "@polaris/core";
import { useMail } from "./mail-shell";
import { useCallback, useState } from "react";
import { Check, Copy, Mail, Search, ShieldBan } from "lucide-react";
import {
    cn,
    ContextMenu,
    ContextMenuContent,
    ContextMenuItem,
    ContextMenuSeparator,
    ContextMenuTrigger,
    useToast
} from "@polaris/ui";

/** How long the tick stays after a copy. Long enough to be seen, short enough
 *  that the button is a copy button again before anybody reaches for it twice. */
const COPIED_MS = 1200;

export function AddressChip({
    entry,
    /** The mailbox this message is in, which is whose block list a block would
     *  be written to. Without it the menu offers no block: a rule has to belong
     *  to a mailbox. */
    accountId,
    onBlock,
    className
}: {
    entry: core.MailAddress;
    accountId?: string;
    onBlock?: (accountId: string, address: string) => void;
    className?: string;
}) {
    const toast = useToast();
    const { openComposer } = useMail();
    const [copied, setCopied] = useState(false);

    const label = core.addressLabel(entry);
    // The address, unless it is what the label already says.
    const second = core.sameAddress(label, entry.address) ? "" : entry.address;

    const copy = useCallback(() => {
        void (async () => {
            try {
                await navigator.clipboard.writeText(entry.address);
                setCopied(true);
                setTimeout(() => setCopied(false), COPIED_MS);
            } catch {
                // A browser that refuses the clipboard - no permission, an
                // insecure origin - is not something to fail silently over:
                // the address is right there to be selected instead.
                toast.show({ title: "This browser would not let Polaris copy that." });
            }
        })();
    }, [entry.address, toast]);

    return (
        <ContextMenu>
            <ContextMenuTrigger asChild>
                <span className={cn("group/address inline-flex min-w-0 items-baseline gap-1", className)}>
                    <span className="truncate" title={entry.address}>
                        {label}
                    </span>
                    {second ? (
                        <span className="min-w-0 truncate text-foreground-subtle">{second}</span>
                    ) : null}
                    {/* Under the pointer, and reachable from the keyboard: the
                        chip is in a header somebody tabs through, and a control
                        that only exists on hover is one nobody using a keyboard
                        has. */}
                    <button
                        type="button"
                        onClick={(event) => {
                            event.stopPropagation();
                            copy();
                        }}
                        aria-label={`Copy ${entry.address}`}
                        title={`Copy ${entry.address}`}
                        className="shrink-0 rounded p-0.5 text-foreground-subtle opacity-0 transition-opacity hover:text-foreground focus-visible:opacity-100 group-hover/address:opacity-100"
                    >
                        {copied ? (
                            <Check className="size-3 shrink-0 text-success" aria-hidden />
                        ) : (
                            <Copy className="size-3 shrink-0" aria-hidden />
                        )}
                    </button>
                </span>
            </ContextMenuTrigger>
            <ContextMenuContent>
                <ContextMenuItem onSelect={copy}>
                    <Copy className="size-3.5 shrink-0" aria-hidden />
                    Copy address
                </ContextMenuItem>
                <ContextMenuItem
                    onSelect={() =>
                        openComposer({ to: [{ name: entry.name, address: entry.address }] })
                    }
                >
                    <Mail className="size-3.5 shrink-0" aria-hidden />
                    New message
                </ContextMenuItem>
                <ContextMenuItem asChild>
                    <a href={`/mail?q=${encodeURIComponent(entry.address)}`}>
                        <Search className="size-3.5 shrink-0" aria-hidden />
                        Find their mail
                    </a>
                </ContextMenuItem>
                {accountId && onBlock ? (
                    <>
                        <ContextMenuSeparator />
                        <ContextMenuItem
                            className="text-danger"
                            onSelect={() => onBlock(accountId, entry.address)}
                        >
                            <ShieldBan className="size-3.5 shrink-0" aria-hidden />
                            Block them
                        </ContextMenuItem>
                    </>
                ) : null}
            </ContextMenuContent>
        </ContextMenu>
    );
}
