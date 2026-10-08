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
import {
    LoginPrincipals,
    type LoginPrincipalsPatch,
    type WafPrincipalScope
} from "./login-principals";
import { useTranslations } from "@/components/i18n/i18n-provider";

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
    const t = useTranslations("firewall");
    const setAllow = (next: string[]): void => onEdit(next, deny);
    const setDeny = (next: string[]): void => onEdit(allow, next);

    const overlap = allow.find((entry) => deny.includes(entry));
    const dirty = JSON.stringify([allow, deny]) !== JSON.stringify([allowlist, denylist]);
    // An allowlist that does not include the address this page is being read over is
    // the one way to lose access to the thing being configured.
    const wouldLockOut = allow.length > 0 && Boolean(callerIp) && !allow.includes(callerIp!);

    return (
        <div className="flex flex-col gap-4">
            <PageHeader title={t("access.addressesTitle")} onBack={onBack} />

            <Section title={t("addresses.title")} hint={t("addresses.hint")}>
                <div className="grid gap-5 md:grid-cols-2">
                    <div className="flex flex-col gap-2">
                        <div className="flex items-center gap-2 text-sm font-medium">
                            <ShieldCheck
                                className="size-4 shrink-0 text-muted-foreground"
                                aria-hidden="true"
                            />
                            {t("addresses.allowed")}
                        </div>
                        <p className="text-xs text-muted-foreground">
                            {t("addresses.allowedHint")}
                        </p>
                        <ChipList
                            entries={allow}
                            disabled={disabled}
                            onChange={setAllow}
                            placeholder="203.0.113.0/24"
                            validate={validAddress}
                            invalidMessage={t("addresses.invalid")}
                        />
                        {callerIp && !allow.includes(callerIp) ? (
                            <button
                                type="button"
                                onClick={() => setAllow([...allow, callerIp])}
                                className="w-fit text-xs text-primary underline-offset-2 hover:underline"
                            >
                                {t("addresses.addMine", { ip: callerIp })}
                            </button>
                        ) : null}
                    </div>
                    <div className="flex flex-col gap-2">
                        <div className="flex items-center gap-2 text-sm font-medium">
                            <Ban
                                className="size-4 shrink-0 text-muted-foreground"
                                aria-hidden="true"
                            />
                            {t("addresses.blocked")}
                        </div>
                        <p className="text-xs text-muted-foreground">
                            {t("addresses.blockedHint")}
                        </p>
                        <ChipList
                            entries={deny}
                            accent="deny"
                            disabled={disabled}
                            onChange={setDeny}
                            placeholder="198.51.100.7"
                            validate={validAddress}
                            invalidMessage={t("addresses.invalid")}
                        />
                    </div>
                </div>

                {overlap ? (
                    <p className="text-xs text-danger">
                        {t("addresses.overlap", { address: overlap })}
                    </p>
                ) : null}
                {wouldLockOut ? (
                    <p className="flex items-start gap-1.5 rounded-md border border-warning-edge bg-warning-soft px-3 py-2 text-xs text-warning-ink">
                        <TriangleAlert className="mt-0.5 size-3 shrink-0" aria-hidden="true" />
                        {t("addresses.lockOut", { ip: callerIp ?? "" })}
                    </p>
                ) : null}

                <div className="flex items-center gap-3">
                    <Button
                        type="button"
                        size="sm"
                        disabled={!dirty || disabled || Boolean(overlap)}
                        title={dirty ? undefined : t("addresses.noChanges")}
                        onClick={() => onSave(allow, deny)}
                    >
                        {t("addresses.save")}
                    </Button>
                    {dirty ? (
                        <button
                            type="button"
                            onClick={() => onEdit([...allowlist], [...denylist])}
                            className="text-xs text-muted-foreground underline-offset-2 hover:text-foreground hover:underline"
                        >
                            {t("addresses.discard")}
                        </button>
                    ) : null}
                </div>
            </Section>
        </div>
    );
}

export function LoginRulePage({
    scope,
    required,
    requiredAbove = false,
    admitted,
    refused,
    disabled,
    onBack,
    onChange
}: {
    scope: WafPrincipalScope;
    required: boolean;
    /** A scope above this one already demands a login. It unions downward, so this
     *  scope cannot waive it and the switch must not pretend otherwise. */
    requiredAbove?: boolean;
    admitted: WafPrincipalGrant[];
    refused: WafPrincipalGrant[];
    disabled?: boolean;
    onBack: () => void;
    onChange: (patch: LoginPrincipalsPatch & { requireLogin?: boolean }) => void;
}) {
    const t = useTranslations("firewall");
    const on = required || requiredAbove;
    return (
        <div className="flex flex-col gap-4">
            <PageHeader title={t("access.loginTitle")} onBack={onBack} />

            <Section title={t("managedPage.whatItDoes")}>
                <p className="text-sm text-muted-foreground">{t("login.what")}</p>
                <p className="text-xs text-muted-foreground">
                    <span className="font-medium text-foreground">
                        {t("managedPage.acrossScopes")}
                    </span>{" "}
                    {t("login.across")}
                </p>
            </Section>

            <Section title={t("list.columns.status")} hint={t("login.statusHint")}>
                <div className="flex items-center gap-3">
                    <Switch
                        checked={on}
                        disabled={disabled || requiredAbove}
                        onChange={(next) => onChange({ requireLogin: next })}
                        aria-label={on ? t("login.stopRequiring") : t("login.require")}
                    />
                    <span className="text-sm">
                        {on ? t("login.required") : t("login.notRequired")}
                    </span>
                </div>
                {requiredAbove ? (
                    <p className="text-xs text-muted-foreground">{t("login.aboveNote")}</p>
                ) : null}
            </Section>

            {/* Only under the switch that gives them meaning. The lists are kept either
                way, so switching the login off and back on comes back to the same
                people rather than to everybody. */}
            {on ? (
                <Section title={t("login.admits")} hint={t("login.admitsHint")}>
                    <LoginPrincipals
                        scope={scope}
                        admitted={admitted}
                        refused={refused}
                        disabled={disabled}
                        onChange={onChange}
                    />
                </Section>
            ) : null}
        </div>
    );
}
