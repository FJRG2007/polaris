"use client";

/**
 * Whether this account can be signed in to by its username.
 *
 * A username is public here by design: it is how somebody is mentioned in a
 * message, found in a search, and linked to on their profile. So an account that
 * accepts it at sign-in has published the first half of its credential, and
 * whoever wants in is left with one thing to guess instead of two.
 *
 * On by default and not because it is the better setting - it is how the account
 * has always worked, and switching it off for everybody would lock out whoever
 * signs in that way tomorrow morning. The card says which way is safer and lets
 * the person decide, which is the honest shape for a setting whose cost is
 * convenience and whose benefit is not being enumerable.
 *
 * Turning it off changes nothing else: the address still works, and so does
 * every other way in this account has.
 */

import { runAction } from "@/lib/run-action";
import { useState, useTransition } from "react";
import { setUsernameSignInAction } from "./actions";
import { Card, CardBody, Switch } from "@polaris/ui";
import { Feedback, type SettingLock } from "./setting-card";

export function UsernameSignInCard({
    enabled,
    username,
    lock
}: {
    enabled: boolean;
    /** Shown so the sentence is about something concrete rather than about a
     *  concept. Empty for an account that has not taken one. */
    username: string;
    lock?: SettingLock;
}) {
    const [on, setOn] = useState(enabled);
    const [error, setError] = useState<string | null>(null);
    const [pending, startTransition] = useTransition();

    function toggle(next: boolean) {
        setOn(next);
        setError(null);
        startTransition(async () => {
            const result = await runAction(() => setUsernameSignInAction(next), setError);
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
                        <h2 className="text-sm font-medium">Sign in with your username</h2>
                        <p className="text-xs text-muted-foreground">
                            {username
                                ? `Either ${username} or your email address opens the account.`
                                : "Either your username or your email address opens the account."}{" "}
                            Your username is public - it is how people mention you and find you -
                            so leaving this on means half the credential is already known. Off,
                            your address is needed as well, and Polaris does not hand that out.
                        </p>
                    </div>
                    <Switch
                        checked={on}
                        disabled={Boolean(lock) || pending}
                        onChange={toggle}
                        aria-label="Sign in with my username"
                    />
                </div>
                {lock ? <p className="text-xs text-muted-foreground">{lock.reason}</p> : null}
                <Feedback error={error} />
            </CardBody>
        </Card>
    );
}
