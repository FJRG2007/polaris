"use client";

/**
 * The firewall screen: one editor, one scope at a time, chosen from a list on the
 * left. Shared by the standalone page and by a project's own, which differ only in
 * which scopes they hand it.
 *
 * It used to be a dialog with two IP fields in it, which is about as far as a dialog
 * goes: there was nowhere to put a rule, nowhere to say what a scope covers, and no
 * room to warn an operator that the allowlist they are typing does not include the
 * address they are typing it over. A page has all three.
 */

import Link from "next/link";
import { useState } from "react";
import { WafEditor } from "./waf-editor";
import type { WafScopeType } from "@polaris/core";
import { ArrowLeft, ShieldCheck } from "lucide-react";
import { Card, CardBody, CardHeader, CardTitle } from "@polaris/ui";

export interface FirewallScope {
    readonly type: WafScopeType;
    readonly id: string;
    readonly label: string;
    readonly description: string;
    /** Whether the require-login control belongs on this scope. */
    readonly offerLogin?: boolean;
}

export function FirewallView({
    title,
    backHref,
    backLabel,
    intro,
    scopes,
    callerIp
}: {
    title: string;
    /** Where the page was opened from. Omitted when it is a destination of its own
     *  rather than a detour out of a project. */
    backHref?: string;
    backLabel?: string;
    intro?: string;
    scopes: readonly FirewallScope[];
    callerIp: string | null;
}) {
    const [active, setActive] = useState(0);
    const scope = scopes[Math.min(active, scopes.length - 1)];

    return (
        <div className="mx-auto flex w-full max-w-5xl flex-col gap-4">
            <div className="flex flex-wrap items-center gap-3">
                {backHref && (
                    <Link
                        href={backHref}
                        className="inline-flex items-center gap-1.5 text-sm text-muted-foreground transition-colors hover:text-foreground"
                    >
                        <ArrowLeft className="size-4" /> {backLabel}
                    </Link>
                )}
                <h1 className="flex items-center gap-2 text-2xl font-semibold">
                    <ShieldCheck className="size-5 text-primary" />
                    {title}
                </h1>
            </div>

            {intro && <p className="max-w-3xl text-sm text-muted-foreground">{intro}</p>}

            {!scope && (
                <Card>
                    <CardBody className="py-10 text-center text-sm text-muted-foreground">
                        Nothing to guard yet. A project gets its own firewall rules as soon as you create one.
                    </CardBody>
                </Card>
            )}

            {scope && (
                <div className="flex flex-col gap-4 md:flex-row md:items-start">
                    {scopes.length > 1 ? (
                        <nav className="flex gap-1 overflow-x-auto md:w-56 md:shrink-0 md:flex-col md:overflow-visible">
                            {scopes.map((option, index) => (
                                <button
                                    key={`${option.type}:${option.id}`}
                                    type="button"
                                    onClick={() => setActive(index)}
                                    className={`shrink-0 rounded-md px-3 py-2 text-left text-sm transition-colors md:shrink ${
                                        index === active
                                            ? "bg-muted font-medium text-foreground"
                                            : "text-muted-foreground hover:bg-muted/60 hover:text-foreground"
                                    }`}
                                >
                                    {option.label}
                                </button>
                            ))}
                        </nav>
                    ) : null}

                    <Card className="min-w-0 flex-1">
                        <CardHeader>
                            <CardTitle>{scope.label}</CardTitle>
                        </CardHeader>
                        <CardBody>
                            <WafEditor
                                key={`${scope.type}:${scope.id}`}
                                scopeType={scope.type}
                                scopeId={scope.id}
                                description={scope.description}
                                offerLogin={scope.offerLogin !== false}
                                callerIp={callerIp}
                            />
                        </CardBody>
                    </Card>
                </div>
            )}
        </div>
    );
}
