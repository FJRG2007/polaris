"use client";

/**
 * Which of the accounts somebody has connected may sign them in, and whether
 * that way in still owes the second step.
 *
 * One switch per connected account rather than one per service: a person with a
 * work GitHub and a personal one has every reason to let one of them in and not
 * the other. Turning one off never unlinks it - the repositories or the calendar
 * it was connected for go on working.
 *
 * The switch is optimistic and rolls back, because it is the whole answer to
 * "can this account get in" and waiting on a round trip to redraw it reads as a
 * dead control. It also says when the operator has closed the service anyway, so
 * a switch that is on but does nothing is never left looking like it works.
 *
 * The second-step switch below them is the same control the operator has under
 * Management > Security, from the other side: they can ask it of everybody, and
 * this asks it of one account. So it is drawn on and fixed when the instance has
 * already decided - a control that silently does nothing is worse than one that
 * says who is holding it.
 */

import { ShieldAlert } from "lucide-react";
import { runAction } from "@/lib/run-action";
import { useState, useTransition } from "react";
import { IntegrationLogo } from "@/components/logos";
import { Card, CardBody, Switch } from "@polaris/ui";
import { Feedback, type SettingLock } from "./setting-card";
import { setConnectionSignInAction, setConnectionSignInChallengeAction } from "./actions";

export interface ConnectedSignIn {
    id: string;
    provider: string;
    providerName: string;
    /** The GitHub login, the Google address. */
    label: string;
    signInEnabled: boolean;
    /** Whether the operator allows this service as a way in at all. */
    allowedHere: boolean;
    /** Why the service is a poor way in, when it is. */
    warning?: string;
}

/** What this account has decided about the second step after a connected sign-in,
 *  and whether the decision is still theirs to make. */
export interface ConnectionChallenge {
    enabled: boolean;
    /** The instance asks for it on every account, so the switch is drawn on and
     *  cannot be turned off here. */
    enforced: boolean;
}

export function ConnectedSignInCard({
    accounts,
    challenge,
    twoFactorEnabled,
    lock
}: {
    accounts: ConnectedSignIn[];
    challenge: ConnectionChallenge;
    /** Whether there is a second step to ask for at all. With no factor armed the
     *  switch would promise something nothing can deliver. */
    twoFactorEnabled: boolean;
    lock?: SettingLock;
}) {
    return (
        <Card>
            <CardBody className="flex flex-col gap-3">
                <div>
                    <h2 className="text-sm font-medium">Connected accounts</h2>
                    <p className="text-xs text-muted-foreground">
                        Choose which of the accounts you have connected can sign you in.
                    </p>
                </div>
                {accounts.length === 0 ? (
                    <p className="text-xs text-muted-foreground">
                        You have not connected any. Connect one under Connected accounts to use it here.
                    </p>
                ) : (
                    <ul className="flex flex-col gap-2">
                        {accounts.map((account) => (
                            <AccountRow key={account.id} account={account} locked={Boolean(lock)} />
                        ))}
                    </ul>
                )}
                {/* Only where it decides something: an account with no second
                    factor is never challenged, and one with nothing connected has
                    no sign-in of this kind to challenge. */}
                {twoFactorEnabled && accounts.length > 0 ? (
                    <ChallengeRow challenge={challenge} locked={Boolean(lock)} />
                ) : null}
            </CardBody>
        </Card>
    );
}

function ChallengeRow({ challenge, locked }: { challenge: ConnectionChallenge; locked: boolean }) {
    const [enabled, setEnabled] = useState(challenge.enabled);
    const [error, setError] = useState<string | null>(null);
    const [pending, startTransition] = useTransition();

    function toggle(next: boolean) {
        setEnabled(next);
        setError(null);
        startTransition(async () => {
            const result = await runAction(() => setConnectionSignInChallengeAction(next), setError);
            if (!result || result.error) {
                setEnabled(!next);
                if (result?.error) setError(result.error);
            }
        });
    }

    return (
        <div className="flex flex-col gap-1 border-t border-border pt-3">
            <div className="flex items-start justify-between gap-4">
                <div className="min-w-0">
                    <p className="text-sm">Ask for my second step too</p>
                    <p className="text-xs text-muted-foreground">
                        Signing in this way answers the other service first, so Polaris does not ask again
                        unless you want it to.
                    </p>
                </div>
                <Switch
                    checked={challenge.enforced || enabled}
                    disabled={locked || pending || challenge.enforced}
                    onChange={toggle}
                    aria-label="Ask for my second step after a connected account signs me in"
                />
            </div>
            {challenge.enforced ? (
                <p className="text-xs text-muted-foreground">This Polaris asks for it on every account.</p>
            ) : null}
            <Feedback error={error} />
        </div>
    );
}

function AccountRow({ account, locked }: { account: ConnectedSignIn; locked: boolean }) {
    const [enabled, setEnabled] = useState(account.signInEnabled);
    const [error, setError] = useState<string | null>(null);
    const [pending, startTransition] = useTransition();

    function toggle(next: boolean) {
        setEnabled(next);
        setError(null);
        startTransition(async () => {
            const result = await runAction(() => setConnectionSignInAction(account.id, next), setError);
            if (!result || result.error) {
                setEnabled(!next);
                if (result?.error) setError(result.error);
            }
        });
    }

    return (
        <li className="flex flex-col gap-1 rounded-md border border-border/60 px-3 py-2">
            <div className="flex items-center gap-3">
                <IntegrationLogo slug={account.provider} className="size-5 shrink-0" />
                <span className="flex min-w-0 flex-1 flex-col">
                    <span className="truncate text-sm">{account.label}</span>
                    <span className="text-xs text-muted-foreground">
                        {account.allowedHere
                            ? `Sign in with this ${account.providerName} account`
                            : `${account.providerName} is not allowed as a way in on this Polaris`}
                    </span>
                </span>
                <Switch
                    checked={enabled}
                    disabled={locked || pending || !account.allowedHere}
                    onChange={toggle}
                    aria-label={`Sign in with ${account.label}`}
                />
            </div>
            {enabled && account.warning ? (
                <p className="flex items-start gap-2 text-xs text-muted-foreground">
                    <ShieldAlert className="mt-0.5 size-3.5 shrink-0 text-warning" />
                    {account.warning}
                </p>
            ) : null}
            <Feedback error={error} />
        </li>
    );
}
