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
import { useTranslations } from "@/components/i18n/i18n-provider";

/** What connecting a mailbox promises, each drawn from `mail.onboarding.<id>`. */
const PROMISES = [
    { id: "together", icon: Layers },
    { id: "private", icon: ShieldCheck },
    { id: "local", icon: Eye }
] as const;

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
    const t = useTranslations("mail");

    return (
        <div className="flex h-full items-center justify-center overflow-y-auto overscroll-contain p-6">
            <div className="w-full max-w-md">
                <div className="mb-5 flex size-10 items-center justify-center rounded-lg border border-border bg-card">
                    <Inbox className="size-5 shrink-0 text-foreground" aria-hidden />
                </div>
                <h1 className="text-[17px] font-semibold tracking-tight">{t("onboarding.title")}</h1>
                <p className="mt-1 text-[13px] text-muted-foreground">{t("onboarding.lead")}</p>

                <ul className="mt-5 space-y-3">
                    {PROMISES.map((promise) => (
                        <li key={promise.id} className="flex gap-3">
                            <promise.icon
                                className="mt-0.5 size-4 shrink-0 text-foreground-subtle"
                                aria-hidden
                            />
                            <div className="min-w-0">
                                <p className="text-[13px] font-medium">{t(`onboarding.${promise.id}.title`)}</p>
                                <p className="text-[12px] text-muted-foreground">{t(`onboarding.${promise.id}.body`)}</p>
                            </div>
                        </li>
                    ))}
                </ul>

                <Button className="mt-6 w-full" onClick={() => setConnecting(true)}>
                    {t("onboarding.connect")}
                </Button>
                <p className="mt-2 text-[12px] text-foreground-subtle">{t("onboarding.how")}</p>

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
