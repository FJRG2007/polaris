"use client";

/**
 * The two rules that name who rather than what: addresses, and accounts.
 *
 * They are pages like every other rule now, and they earn it - each is two lists with
 * a warning attached, which is more than a switch in a table can carry honestly. They
 * are also the two that can shut their own author out, so each keeps the explicit Save
 * the rest of the screen does without: an allowlist is only ever right once it is
 * finished, and applying "10.0.0.0/8" the instant it is typed - before the second
 * entry - would shut out everyone the second entry was for.
 */

import { Button, Switch } from "@polaris/ui";
import { PageHeader, Section } from "./page-parts";
import { ChipList, validAddress } from "./chip-list";
import type { WafPrincipalGrant } from "@polaris/core";
import { Ban, ShieldCheck, TriangleAlert } from "lucide-react";
import { LoginPrincipals, type LoginPrincipalsPatch } from "./login-principals";

export function AddressRulesPage({
    allowlist,
    denylist,
    allow,
    deny,
    callerIp,
    disabled,
    onBack,
    onEdit,
    onSave
}: {
    /** What the server holds, which is what "unsaved" is measured against. */
    allowlist: readonly string[];
    denylist: readonly string[];
    /** What is on screen. Held by the screen rather than by this page, so walking
     *  back to the rule list and returning does not quietly bin a half-typed list. */
    allow: string[];
    deny: string[];
    /** The address this page is being read over, so an operator narrowing access does
     *  not narrow themselves out of it. */
    callerIp?: string | null;
    disabled?: boolean;
    onBack: () => void;
    onEdit: (allow: string[], deny: string[]) => void;
    onSave: (allowlist: string[], denylist: string[]) => void;
}) {
    const setAllow = (next: string[]): void => onEdit(next, deny);
    const setDeny = (next: string[]): void => onEdit(allow, next);

    const overlap = allow.find((entry) => deny.includes(entry));
    const dirty = JSON.stringify([allow, deny]) !== JSON.stringify([allowlist, denylist]);
    // An allowlist that does not include the address this page is being read over is
    // the one way to lose access to the thing being configured.
    const wouldLockOut = allow.length > 0 && Boolean(callerIp) && !allow.includes(callerIp!);

    return (
        <div className="flex flex-col gap-4">
            <PageHeader title="IP access rules" onBack={onBack} />

            <Section
                title="Addresses"
                hint="Checked before every other rule. The allowlist is enforced by the edge itself; the denylist always wins over it."
            >
                <div className="grid gap-5 md:grid-cols-2">
                    <div className="flex flex-col gap-2">
                        <div className="flex items-center gap-2 text-sm font-medium">
                            <ShieldCheck className="size-4 shrink-0 text-muted-foreground" aria-hidden="true" />
                            Allowed
                        </div>
                        <p className="text-xs text-muted-foreground">
                            If any address is listed, only those get through. A narrower scope can shorten this list,
                            never lengthen it.
                        </p>
                        <ChipList
                            entries={allow}
                            disabled={disabled}
                            onChange={setAllow}
                            placeholder="203.0.113.0/24"
                            validate={validAddress}
                            invalidMessage="Enter a valid IP address or CIDR range."
                        />
                        {callerIp && !allow.includes(callerIp) ? (
                            <button
                                type="button"
                                onClick={() => setAllow([...allow, callerIp])}
                                className="w-fit text-xs text-primary underline-offset-2 hover:underline"
                            >
                                Add my address ({callerIp})
                            </button>
                        ) : null}
                    </div>
                    <div className="flex flex-col gap-2">
                        <div className="flex items-center gap-2 text-sm font-medium">
                            <Ban className="size-4 shrink-0 text-muted-foreground" aria-hidden="true" />
                            Blocked
                        </div>
                        <p className="text-xs text-muted-foreground">
                            Always refused, even when they match the allowlist.
                        </p>
                        <ChipList
                            entries={deny}
                            accent="deny"
                            disabled={disabled}
                            onChange={setDeny}
                            placeholder="198.51.100.7"
                            validate={validAddress}
                            invalidMessage="Enter a valid IP address or CIDR range."
                        />
                    </div>
                </div>

                {overlap ? <p className="text-xs text-danger">&quot;{overlap}&quot; is in both lists.</p> : null}
                {wouldLockOut ? (
                    <p className="flex items-start gap-1.5 rounded-md border border-warning/30 bg-warning/5 px-3 py-2 text-xs text-warning">
                        <TriangleAlert className="mt-0.5 size-3 shrink-0" aria-hidden="true" />
                        This allowlist does not include the address you are reading this over ({callerIp}). Saving it
                        will shut you out of everything in this scope.
                    </p>
                ) : null}

                <div className="flex items-center gap-3">
                    <Button
                        type="button"
                        size="sm"
                        disabled={!dirty || disabled || Boolean(overlap)}
                        title={dirty ? undefined : "No changes to save"}
                        onClick={() => onSave(allow, deny)}
                    >
                        Save address lists
                    </Button>
                    {dirty ? (
                        <button
                            type="button"
                            onClick={() => onEdit([...allowlist], [...denylist])}
                            className="text-xs text-muted-foreground underline-offset-2 hover:text-foreground hover:underline"
                        >
                            Discard
                        </button>
                    ) : null}
                </div>
            </Section>
        </div>
    );
}

export function LoginRulePage({
    required,
    admitted,
    refused,
    disabled,
    onBack,
    onChange
}: {
    required: boolean;
    admitted: WafPrincipalGrant[];
    refused: WafPrincipalGrant[];
    disabled?: boolean;
    onBack: () => void;
    onChange: (patch: LoginPrincipalsPatch & { requireLogin?: boolean }) => void;
}) {
    return (
        <div className="flex flex-col gap-4">
            <PageHeader title="Require a Polaris login" onBack={onBack} />

            <Section title="What it does">
                <p className="text-sm text-muted-foreground">
                    Visitors must sign in to Polaris to reach anything in this scope. Existing sessions keep working if
                    the control plane is down; new sign-ins need it reachable.
                </p>
                <p className="text-xs text-muted-foreground">
                    <span className="font-medium text-foreground">Across scopes:</span> a scope that requires a login
                    cannot be overruled by a narrower one, and every scope that names who it admits gets a say.
                </p>
            </Section>

            <Section title="Status" hint="Whether this scope demands a login at all.">
                <div className="flex items-center gap-3">
                    <Switch
                        checked={required}
                        disabled={disabled}
                        onChange={(on) => onChange({ requireLogin: on })}
                        aria-label={`${required ? "Stop requiring" : "Require"} a Polaris login`}
                    />
                    <span className="text-sm">{required ? "A login is required" : "No login is required"}</span>
                </div>
            </Section>

            {/* Only under the switch that gives them meaning. The lists are kept either
                way, so switching the login off and back on comes back to the same
                people rather than to everybody. */}
            {required ? (
                <Section title="Who it admits" hint="Named nobody means anyone with a Polaris account.">
                    <LoginPrincipals admitted={admitted} refused={refused} disabled={disabled} onChange={onChange} />
                </Section>
            ) : null}
        </div>
    );
}
