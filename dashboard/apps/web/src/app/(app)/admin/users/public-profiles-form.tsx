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
import { Card, CardBody, Switch } from "@polaris/ui";
import { setPublicProfilesAction } from "./actions";

export function PublicProfilesForm({ enabled }: { enabled: boolean }) {
    const [on, setOn] = useState(enabled);
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
                {error ? <p className="text-sm text-danger">{error}</p> : null}
            </CardBody>
        </Card>
    );
}
