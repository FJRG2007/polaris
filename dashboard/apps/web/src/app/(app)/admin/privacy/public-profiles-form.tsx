"use client";

/**
 * Whether somebody's page can be read without signing in.
 *
 * It sits under Privacy rather than Security, because what it decides is not
 * who gets in - it is how far out an account's own page reaches. Each account already decides what its page says; this decides whether
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

import { useState } from "react";
import { Card, CardBody, Switch, useOptimisticToggle } from "@polaris/ui";
import { setPublicProfilesAction } from "./actions";
import { useTranslations } from "@/components/i18n/i18n-provider";

export function PublicProfilesForm({ enabled }: { enabled: boolean }) {
    const t = useTranslations("admin");
    const [error, setError] = useState<string | null>(null);
    // Applied on the press and put back if the server refuses it, so the switch
    // never reads as saved when it is not - this one decides what leaves the box.
    const [on, toggle] = useOptimisticToggle(
        enabled,
        async (next) => {
            setError(null);
            return setPublicProfilesAction(next);
        },
        { onRefused: setError }
    );

    return (
        <Card>
            <CardBody className="flex flex-col divide-y divide-border py-1">
                <div className="flex items-start justify-between gap-3 py-3">
                    <div className="flex min-w-0 flex-col gap-0.5">
                        <span className="text-sm">{t("privacy.profiles.publicLabel")}</span>
                        <span id="privacy-public-profiles" className="text-xs text-muted-foreground">
                            {t.rich("privacy.profiles.publicHint", {
                                code: (chunks) => <code key="code">{chunks}</code>
                            })}
                        </span>
                    </div>
                    <Switch
                        checked={on}
                        aria-label={t("privacy.profiles.publicLabel")}
                        aria-describedby="privacy-public-profiles"
                        onChange={toggle}
                    />
                </div>
                {error ? <p className="py-3 text-sm text-danger">{error}</p> : null}
            </CardBody>
        </Card>
    );
}
