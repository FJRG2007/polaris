"use client";

/**
 * The consent card: which app, where it sends you back to, and a box per thing
 * it may do.
 *
 * The return address is shown as prominently as the name, because it is the
 * only part of this screen the app cannot make up - a registration can call
 * itself "Claude", but the code goes to the address it registered. A loopback
 * address gets its own warning: it means an app on this computer, and the MCP
 * spec asks for that to be said.
 *
 * Ticking a broad permission ticks what it cannot work without, locked, the way
 * the API key picker does; the server expands the same way whatever is posted.
 */

import { useMemo, useState } from "react";
import { answerAuthorizationAction } from "./actions";
import { scopeLabelKey } from "@/lib/mcp/oauth/scope-labels";
import { useTranslations } from "@/components/i18n/i18n-provider";
import { AlertTriangle, Blocks, Globe, Info, Undo2 } from "lucide-react";
import { expandPermissions, impliedBy, type Permission } from "@polaris/core";
import { Checkbox } from "@polaris/ui";
import { ConsentCard, ConsentFacts } from "@/components/consent-card";

interface AppSummary {
    readonly name: string;
    readonly website: string | null;
    readonly returnsTo: string;
    readonly loopback: boolean;
}

export function ConsentView({
    query,
    app,
    person,
    offered,
    withheld
}: {
    query: string;
    app: AppSummary;
    person: string;
    offered: Permission[];
    withheld: Permission[];
}) {
    const t = useTranslations("mcp");
    const [selected, setSelected] = useState<Permission[]>(offered);
    const [pending, setPending] = useState<"allow" | "deny" | null>(null);
    const [error, setError] = useState<string | null>(null);

    const effective = useMemo(
        () => new Set(expandPermissions(selected).filter((scope) => offered.includes(scope))),
        [selected, offered]
    );
    const name = app.name || t("consent.unnamed");

    function toggle(scope: Permission, checked: boolean) {
        setError(null);
        setSelected((current) =>
            checked ? [...current, scope] : current.filter((entry) => entry !== scope)
        );
    }

    async function answer(allow: boolean) {
        if (allow && effective.size === 0) {
            setError(t("consent.pickOne"));
            return;
        }
        setPending(allow ? "allow" : "deny");
        setError(null);
        try {
            const result = await answerAuthorizationAction({
                query,
                allow,
                scopes: [...effective]
            });
            if (result.redirectTo) {
                // A full navigation, not the router: the address is the app's,
                // often on another origin or on this computer.
                window.location.assign(result.redirectTo);
                return;
            }
            setError(result.error ?? t("consent.errors.failed"));
        } catch {
            setError(t("consent.errors.failed"));
        }
        setPending(null);
    }

    return (
        <main className="grid min-h-dvh place-items-center p-4">
            <ConsentCard
                requester={<Blocks className="text-muted-foreground" />}
                title={t("consent.title", { app: name })}
                account={t("consent.signedInAs", { name: person })}
                error={error}
                deny={{
                    label: t("consent.deny"),
                    disabled: pending !== null,
                    onClick: () => void answer(false)
                }}
                allow={{
                    label: pending === "allow" ? t("consent.allowing") : t("consent.allow"),
                    disabled: pending !== null || offered.length === 0,
                    ariaDisabled: effective.size === 0,
                    onClick: () => void answer(true)
                }}
                footer={
                    <>
                        <Info className="mt-0.5 size-3 shrink-0" aria-hidden />
                        {t("consent.later")}
                    </>
                }
            >
                <ConsentFacts
                    facts={[
                        { icon: <Undo2 />, label: t("consent.returnsTo"), value: app.returnsTo },
                        ...(app.website
                            ? [{ icon: <Globe />, label: t("consent.website"), value: app.website }]
                            : [])
                    ]}
                    note={t("consent.unverified")}
                />

                {app.loopback ? (
                    <p className="flex gap-2 rounded-md border border-warning-edge bg-warning-soft p-3 text-xs text-warning-ink">
                        <AlertTriangle className="size-4 shrink-0" aria-hidden />
                        <span>{t("consent.loopback")}</span>
                    </p>
                ) : null}

                {offered.length > 0 ? (
                    <fieldset className="flex flex-col gap-2">
                        <legend className="mb-1 font-medium">{t("consent.scopesTitle")}</legend>
                        <p className="text-xs text-muted-foreground">{t("consent.scopesHint")}</p>
                        <ul className="flex flex-col gap-1.5">
                            {offered.map((scope) => {
                                const implied = effective.has(scope) && !selected.includes(scope);
                                const source = implied
                                    ? selected.find((entry) => impliedBy(entry).includes(scope))
                                    : undefined;
                                return (
                                    <li key={scope}>
                                        <label className="flex min-w-0 items-start gap-2">
                                            <Checkbox
                                                checked={effective.has(scope)}
                                                disabled={implied || pending !== null}
                                                onChange={(event) =>
                                                    toggle(scope, event.target.checked)
                                                }
                                                className="mt-0.5"
                                            />
                                            <span className="flex min-w-0 flex-col">
                                                <span>{t(scopeLabelKey(scope))}</span>
                                                <span className="truncate font-mono text-xs text-muted-foreground">
                                                    {source
                                                        ? t("consent.impliedBy", {
                                                              scope: t(scopeLabelKey(source))
                                                          })
                                                        : scope}
                                                </span>
                                            </span>
                                        </label>
                                    </li>
                                );
                            })}
                        </ul>
                    </fieldset>
                ) : (
                    <p className="text-muted-foreground">{t("consent.noneHeld")}</p>
                )}

                {withheld.length > 0 ? (
                    <p className="text-xs text-muted-foreground">
                        {t("consent.withheld", {
                            scopes: withheld.map((scope) => t(scopeLabelKey(scope))).join(", ")
                        })}
                    </p>
                ) : null}
            </ConsentCard>
        </main>
    );
}
