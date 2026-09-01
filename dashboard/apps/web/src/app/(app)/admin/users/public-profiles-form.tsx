"use client";

/**
 * Whether somebody's page can be read without signing in.
 *
 * It sits with the other rules about people rather than under Security, because
 * what it decides is not who gets in - it is how far out an account's own page
 * reaches. Each account already decides what its page says; this decides whether
 * a stranger with no session is a reader at all.
 *
 * Off unless an operator turns it on, and the reason is that the two kinds of
 * deployment want opposite answers. A company's Polaris publishing its roster to
 * the internet is a directory of its staff nobody agreed to; a public project's
 * is exactly the point. The person who would be exposed by the wrong default is
 * not the person choosing it, so the default is the closed one.
 *
 * Turning it on publishes nothing on its own. A signed-out reader is a stranger:
 * on nobody's friends list and in nobody's exceptions, so they see only what an
 * account has set to "everybody", and an account set to anything narrower stays
 * invisible to them.
 */

import { useState, useTransition } from "react";
import { Card, CardBody, Select, Switch } from "@polaris/ui";
import { PRIVACY_AUDIENCES, PRIVACY_AUDIENCE_LABELS, type PrivacyAudience } from "@polaris/core";
import { setFollowerDefaultAction, setPublicProfilesAction } from "./actions";

export function PublicProfilesForm({
    enabled,
    followerDefault
}: {
    enabled: boolean;
    /** What a new account's follower lists are shown to, until it says
     *  otherwise. */
    followerDefault: PrivacyAudience;
}) {
    const [on, setOn] = useState(enabled);
    const [audience, setAudience] = useState<PrivacyAudience>(followerDefault);
    const [error, setError] = useState<string | null>(null);
    const [pending, startTransition] = useTransition();

    return (
        <Card>
            <CardBody className="flex flex-col gap-3">
                <div className="flex flex-wrap items-start justify-between gap-3">
                    <div className="flex flex-col gap-1">
                        <h2 className="text-sm font-medium">Profiles without signing in</h2>
                        <p className="max-w-xl text-sm text-muted-foreground">
                            A person&rsquo;s page lives at <code>/u/their-username</code> and can be handed out.
                            With this off it is only readable by people signed in here, which is what a
                            deployment for one company usually wants. With it on, a stranger still sees only
                            what an account has set to &ldquo;everybody&rdquo; - and an account set to anything
                            narrower stays invisible to them.
                        </p>
                    </div>
                    <Switch
                        checked={on}
                        disabled={pending}
                        aria-label="Show profiles to people who are not signed in"
                        onChange={(next: boolean) => {
                            // Applied on the press and put back if the server
                            // refuses it, so the switch never reads as saved when
                            // it is not - this one decides what leaves the box.
                            setOn(next);
                            setError(null);
                            startTransition(async () => {
                                const result = await setPublicProfilesAction(next);
                                if (result.error) {
                                    setOn(!next);
                                    setError(result.error);
                                }
                            });
                        }}
                    />
                </div>
                <div className="flex flex-col gap-1 border-t border-border pt-3">
                    <label className="flex flex-col gap-1 text-sm">
                        Who a new account&rsquo;s followers are shown to
                        <Select
                            value={audience}
                            disabled={pending}
                            aria-label="Who a new account's followers are shown to"
                            options={PRIVACY_AUDIENCES.filter(
                                // The two that name a list of people cannot be a
                                // default: the list belongs to an account, and
                                // there is no account yet to have one.
                                (value) => value === "everyone" || value === "friends" || value === "nobody"
                            ).map((value) => ({ value, label: PRIVACY_AUDIENCE_LABELS[value] }))}
                            onValueChange={(value) => {
                                const next = value as PrivacyAudience;
                                const before = audience;
                                setAudience(next);
                                setError(null);
                                startTransition(async () => {
                                    const result = await setFollowerDefaultAction(next);
                                    if (result.error) {
                                        setAudience(before);
                                        setError(result.error);
                                    }
                                });
                            }}
                        />
                    </label>
                    <p className="max-w-xl text-xs text-muted-foreground">
                        Who follows somebody and who they follow are one disclosure and one setting on their
                        own privacy screen. This is what it says before anybody touches it - a directory for
                        one company and a place where people follow each other want opposite answers, and
                        only you can say which this is. Changing it never reaches back into an account that
                        has already chosen.
                    </p>
                </div>

                {error ? <p className="text-sm text-danger">{error}</p> : null}
            </CardBody>
        </Card>
    );
}
