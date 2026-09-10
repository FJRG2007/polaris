"use client";

/**
 * What the Mail server screens show before the app is installed.
 *
 * Not a 404 and not a redirect: somebody who followed an old link, a pinned
 * shortcut or the capabilities page has arrived at the right place, and the
 * one thing missing is the install - so the screen says what the app is and
 * offers it. Installing runs nothing; the engine is pulled only when a server
 * is set up afterwards.
 */

import Link from "next/link";
import { Loader2, Mails } from "lucide-react";
import { useState, useTransition } from "react";
import { Button, EmptyState } from "@polaris/ui";
import { installMailServerAppAction } from "./actions";

/** Where the app sits in the marketplace; the marketplace opens on it. */
const MAIL_SERVER_LISTING = "/apps/marketplace?app=mail-server";

export function MailServerInstallState({ canInstall }: { canInstall: boolean }) {
    const [pending, startTransition] = useTransition();
    const [error, setError] = useState<string | null>(null);

    function install(): void {
        setError(null);
        startTransition(async () => {
            const result = await installMailServerAppAction();
            if (result.error) {
                setError(result.error);
                return;
            }
            // A full load rather than a refresh: the rail and the search are
            // drawn by the layout above this page, and they gain the app too.
            window.location.assign("/apps/mail-server");
        });
    }

    return (
        <div className="flex flex-col gap-3">
            <EmptyState
                icon={<Mails />}
                title="Install Mail server from the Marketplace"
                description={
                    canInstall
                        ? "Mail at your own domains: SPF, DKIM and DMARC written and checked, mailboxes and aliases. Installing downloads nothing - a server is set up only when you choose a machine for it."
                        : "Mail at your own domains: SPF, DKIM and DMARC written and checked, mailboxes and aliases. Ask somebody who can install apps to add it."
                }
                action={
                    canInstall ? (
                        <>
                            <Button size="sm" onClick={install} disabled={pending}>
                                {pending ? <Loader2 className="animate-spin" /> : null}
                                {pending ? "Installing" : "Install"}
                            </Button>
                            <Button asChild size="sm" variant="ghost">
                                <Link href={MAIL_SERVER_LISTING}>View in Marketplace</Link>
                            </Button>
                        </>
                    ) : null
                }
            />
            {error ? (
                <p role="alert" className="text-center text-sm text-danger">
                    {error}
                </p>
            ) : null}
        </div>
    );
}
