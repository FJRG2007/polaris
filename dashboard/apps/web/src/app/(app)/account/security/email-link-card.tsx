"use client";

/**
 * Signing in with a link sent to the account's own address, instead of typing the
 * password.
 *
 * Off until somebody turns it on, and it stays that way for an account that never
 * does. It is a real trade rather than a convenience toggle: with it on, whoever
 * can read that mailbox can open the account, which is why nobody is entered into
 * it by an operator, a default, or an update.
 *
 * The switch is optimistic and rolls back, like the connected-account ones: it is
 * the whole answer to "can a link get me in", and waiting on a round trip to
 * redraw it reads as a dead control. Where the deployment cannot send mail at all
 * it says so and stays off, because a switch that is on and sends nothing is
 * worse than one that admits it.
 */

import { runAction } from "@/lib/run-action";
import { useState, useTransition } from "react";
import { Card, CardBody, Switch } from "@polaris/ui";
import { setEmailLinkSignInAction } from "./actions";
import { Feedback, type SettingLock } from "./setting-card";

export function EmailLinkCard({
    enabled,
    canSend,
    lock
}: {
    enabled: boolean;
    /** Whether this Polaris has a way to send mail. Without one the link exists
     *  nowhere, so the control says that rather than pretending. */
    canSend: boolean;
    lock?: SettingLock;
}) {
    const [on, setOn] = useState(enabled);
    const [error, setError] = useState<string | null>(null);
    const [pending, startTransition] = useTransition();
    const locked = Boolean(lock) || !canSend;

    function toggle(next: boolean) {
        setOn(next);
        setError(null);
        startTransition(async () => {
            const result = await runAction(() => setEmailLinkSignInAction(next), setError);
            if (!result || result.error) {
                setOn(!next);
                if (result?.error) setError(result.error);
            }
        });
    }

    return (
        <Card>
            <CardBody className="flex flex-col gap-1">
                <div className="flex items-start justify-between gap-4">
                    <div className="min-w-0">
                        <h2 className="text-sm font-medium">Sign in with an emailed link</h2>
                        <p className="text-xs text-muted-foreground">
                            A link sent to your address opens the account without your password. It
                            works once, expires in 10 minutes, and your second step is still asked for.
                        </p>
                    </div>
                    <Switch
                        checked={on}
                        disabled={locked || pending}
                        onChange={toggle}
                        aria-label="Sign in with a link emailed to me"
                    />
                </div>
                {canSend ? null : (
                    <p className="text-xs text-muted-foreground">
                        This Polaris cannot send email yet, so there is nowhere to send the link.
                    </p>
                )}
                {lock ? <p className="text-xs text-muted-foreground">{lock.reason}</p> : null}
                <Feedback error={error} />
            </CardBody>
        </Card>
    );
}
