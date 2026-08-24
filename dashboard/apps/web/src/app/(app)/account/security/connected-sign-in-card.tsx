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
import { StepUpDialog } from "@/components/step-up-dialog";
import { stepUpRemainingAction } from "@/app/(app)/account/step-up-actions";
import { useCallback, useEffect, useState, useTransition } from "react";
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

/** The purpose these switches are proved under. One screen, one purpose: a
 *  proof given here is not permission to do anything else. */
const PURPOSE = "connected-sign-in";

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
    /**
     * Whether this browser has already proved itself for this screen, and what
     * to do the moment it has.
     *
     * Which way in an account has is what decides whether it is signed in at
     * all, so changing one costs the account's strongest proof - not the open
     * session, which is exactly what somebody holding a stolen laptop already
     * has. Asked once and held for two minutes, because a challenge that fires
     * per switch is a challenge people stop reading by the third.
     */
    const [proved, setProved] = useState(false);
    const [asking, setAsking] = useState<(() => void) | null>(null);

    // Re-read on arrival rather than assumed: a proof given on this screen a
    // minute ago is still good, and asking again for it would be asking for
    // nothing.
    useEffect(() => {
        let live = true;
        void stepUpRemainingAction(PURPOSE)
            .then((result) => live && setProved(result.remainingMs > 0))
            .catch(() => undefined);
        return () => {
            live = false;
        };
    }, []);

    /**
     * Run this change, or ask first and run it after.
     *
     * The pending change is held rather than replayed by the caller, so the
     * switch somebody actually pressed is the one that moves - a dialog that
     * confirmed and then did nothing would read as a broken control.
     */
    const guard = useCallback(
        (change: () => void) => {
            if (proved) {
                change();
                return;
            }
            setAsking(() => change);
        },
        [proved]
    );

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
                            <AccountRow
                                key={account.id}
                                account={account}
                                locked={Boolean(lock)}
                                guard={guard}
                            />
                        ))}
                    </ul>
                )}
                {/* Only where it decides something: an account with no second
                    factor is never challenged, and one with nothing connected has
                    no sign-in of this kind to challenge. */}
                {twoFactorEnabled && accounts.length > 0 ? (
                    <ChallengeRow challenge={challenge} locked={Boolean(lock)} guard={guard} />
                ) : null}

                <StepUpDialog
                    open={asking !== null}
                    purpose={PURPOSE}
                    title="Confirm it is you"
                    description="Changing which accounts can sign you in decides how this account is reached. You will not be asked again for a couple of minutes."
                    onOpenChange={(open) => !open && setAsking(null)}
                    onProved={() => {
                        setProved(true);
                        const change = asking;
                        setAsking(null);
                        change?.();
                    }}
                />
            </CardBody>
        </Card>
    );
}

function ChallengeRow({
    challenge,
    locked,
    guard
}: {
    challenge: ConnectionChallenge;
    locked: boolean;
    /** Runs the change, asking for a proof first when this browser owes one. */
    guard: (change: () => void) => void;
}) {
    const [enabled, setEnabled] = useState(challenge.enabled);
    const [error, setError] = useState<string | null>(null);
    const [pending, startTransition] = useTransition();

    function toggle(next: boolean) {
        setError(null);
        guard(() => {
            setEnabled(next);
            startTransition(async () => {
                const result = await runAction(
                    () => setConnectionSignInChallengeAction(next),
                    setError
                );
                if (!result || result.error) {
                    setEnabled(!next);
                    if (result?.error) setError(result.error);
                }
            });
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

function AccountRow({
    account,
    locked,
    guard
}: {
    account: ConnectedSignIn;
    locked: boolean;
    guard: (change: () => void) => void;
}) {
    const [enabled, setEnabled] = useState(account.signInEnabled);
    const [error, setError] = useState<string | null>(null);
    const [pending, startTransition] = useTransition();

    function toggle(next: boolean) {
        setError(null);
        guard(() => {
            setEnabled(next);
            startTransition(async () => {
                const result = await runAction(
                    () => setConnectionSignInAction(account.id, next),
                    setError
                );
                if (!result || result.error) {
                    setEnabled(!next);
                    if (result?.error) setError(result.error);
                }
            });
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
