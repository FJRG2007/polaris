"use client";

/**
 * What Mail is before there is any mail.
 *
 * A person who opens this app with nothing connected used to get an empty list
 * with a sentence in it, which reads as a broken screen rather than a first
 * step. This is the first step: it says what connecting a mailbox gets them,
 * says the two things Polaris will not do with it, and opens the one dialog.
 *
 * The privacy line is not decoration. It is the reason somebody would read their
 * mail here rather than in the tab they already have open, and burying it in a
 * settings screen they will never visit would waste the only argument this app
 * has.
 */

import { useState } from "react";
import { Button } from "@polaris/ui";
import { Eye, Inbox, Layers, ShieldCheck } from "lucide-react";
import { ConnectMailboxDialog, type LinkedAccount } from "./connect-dialog";

const PROMISES = [
    {
        icon: Layers,
        title: "Every mailbox in one place",
        body: "Connect as many as you like. One inbox holds all of them, and each keeps its own colour so you always know which is which."
    },
    {
        icon: ShieldCheck,
        title: "Nothing loads until you say so",
        body: "Polaris fetches every picture for you, so a sender learns that a server asked and nothing about you - not your address, not your browser, not when you opened it."
    },
    {
        icon: Eye,
        title: "It stays on your Polaris",
        body: "Your mail is read straight from your own mail server. Nothing about it is sent anywhere else."
    }
];

export function MailOnboarding({
    links,
    googleReady,
    microsoftReady,
    publicAddress,
    canSetDomain
}: {
    links: LinkedAccount[];
    googleReady: boolean;
    microsoftReady: boolean;
    publicAddress: boolean;
    canSetDomain: boolean;
}) {
    const [connecting, setConnecting] = useState(false);

    return (
        <div className="flex h-full items-center justify-center overflow-y-auto overscroll-contain p-6">
            <div className="w-full max-w-md">
                <div className="mb-5 flex size-10 items-center justify-center rounded-lg border border-border bg-card">
                    <Inbox className="size-5 shrink-0 text-foreground" aria-hidden />
                </div>
                <h1 className="text-[17px] font-semibold tracking-tight">Read your mail here</h1>
                <p className="mt-1 text-[13px] text-muted-foreground">
                    Connect the address you already use. Polaris works out the rest from it, so for
                    most services there is nothing else to fill in.
                </p>

                <ul className="mt-5 space-y-3">
                    {PROMISES.map((promise) => (
                        <li key={promise.title} className="flex gap-3">
                            <promise.icon
                                className="mt-0.5 size-4 shrink-0 text-foreground-subtle"
                                aria-hidden
                            />
                            <div className="min-w-0">
                                <p className="text-[13px] font-medium">{promise.title}</p>
                                <p className="text-[12px] text-muted-foreground">{promise.body}</p>
                            </div>
                        </li>
                    ))}
                </ul>

                <Button className="mt-6 w-full" onClick={() => setConnecting(true)}>
                    Connect a mailbox
                </Button>
                <p className="mt-2 text-[12px] text-foreground-subtle">
                    Gmail and Outlook connect by authorizing the account. Anything else takes the
                    password for that mailbox.
                </p>

                {connecting ? (
                    <ConnectMailboxDialog
                        links={links}
                        googleReady={googleReady}
                        microsoftReady={microsoftReady}
                        publicAddress={publicAddress}
                        canSetDomain={canSetDomain}
                        onClose={() => setConnecting(false)}
                    />
                ) : null}
            </div>
        </div>
    );
}
