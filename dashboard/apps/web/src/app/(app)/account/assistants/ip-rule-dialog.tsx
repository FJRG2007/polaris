"use client";

/**
 * Where one connected app may call from: anywhere, only the address it was
 * approved from, an allow and deny list, or only where the person is signed in
 * to Polaris. The lists use the same entry field and the same rule as API keys
 * and sign-in rules, so an address or a range is checked the same way here.
 *
 * Below it, when the account's network rules restrict anything (or the
 * connection already has one), the connection's exception to those rules:
 * countries, continents, addresses and published lists it may call from even
 * though the account may not. Only an administrator may add to it; for anybody
 * else it is shown and cannot be changed.
 */

import { useState } from "react";
import { ipRuleField } from "@polaris/core";
import { GeoPicker } from "@/components/geo-picker";
import { RuleListInput } from "@/components/rule-list-input";
import { useTranslations } from "@/components/i18n/i18n-provider";
import {
    IP_LIST_MAX,
    IP_POLICY_MODES,
    ipPolicySchema,
    type IpPolicy,
    type IpPolicyMode
} from "@/lib/mcp/oauth/ip-policy";
import {
    EXCEPTION_LIST_MAX,
    exceptionIsEmpty,
    sameException,
    type NetworkException
} from "@/lib/mcp/oauth/network-exception";
import {
    Button,
    Dialog,
    DialogContent,
    DialogDescription,
    DialogHeader,
    DialogTitle,
    cn
} from "@polaris/ui";

function samePolicy(a: IpPolicy, b: IpPolicy): boolean {
    const same = (left: string[], right: string[]) =>
        [...left].sort().join(" ") === [...right].sort().join(" ");
    if (a.mode !== b.mode) return false;
    return a.mode !== "list" || (same(a.allow, b.allow) && same(a.deny, b.deny));
}

export function IpRuleDialog({
    name,
    current,
    approvedIp,
    exception: currentException,
    restricted,
    canExcept,
    onCancel,
    onSave
}: {
    name: string;
    current: IpPolicy;
    approvedIp: string | null;
    /** The connection's exception to the account's network rules. */
    exception: NetworkException;
    /** Whether the account's network rules restrict anything. */
    restricted: boolean;
    /** Whether this person may add to an exception. */
    canExcept: boolean;
    onCancel: () => void;
    onSave: (policy: IpPolicy, exception: NetworkException) => void;
}) {
    const t = useTranslations("mcp");
    const tc = useTranslations("common");
    const [mode, setMode] = useState<IpPolicyMode>(current.mode);
    const [allow, setAllow] = useState<string[]>(current.allow);
    const [deny, setDeny] = useState<string[]>(current.deny);
    const [exception, setException] = useState<NetworkException>(currentException);
    const showException = restricted || !exceptionIsEmpty(currentException);

    const draft: IpPolicy = mode === "list" ? { mode, allow, deny } : { mode, allow: [], deny: [] };
    const valid = ipPolicySchema.safeParse(draft).success;
    const unchanged = samePolicy(draft, current) && sameException(exception, currentException);

    function validate(value: string): { value: string } | { error: string } {
        const parsed = ipRuleField.safeParse(value);
        return parsed.success ? { value: parsed.data } : { error: t("connectedApps.ip.invalid") };
    }

    return (
        <Dialog open onOpenChange={(open) => !open && onCancel()}>
            <DialogContent className="w-[calc(100%-2rem)] max-w-md">
                <DialogHeader>
                    <DialogTitle className="break-words pr-6 [overflow-wrap:anywhere]">
                        {t("connectedApps.ip.title", { app: name })}
                    </DialogTitle>
                    <DialogDescription>{t("connectedApps.ip.hint")}</DialogDescription>
                </DialogHeader>
                <fieldset className="flex flex-col gap-2">
                    <legend className="sr-only">{t("connectedApps.ip.legend")}</legend>
                    {IP_POLICY_MODES.map((option) => {
                        const unavailable = option === "origin" && !approvedIp;
                        return (
                            <label
                                key={option}
                                className={cn(
                                    "flex min-w-0 items-start gap-2 rounded-md border border-border p-2.5 text-sm",
                                    mode === option && "border-primary/60 bg-primary/5",
                                    unavailable && "cursor-not-allowed opacity-60"
                                )}
                            >
                                <input
                                    type="radio"
                                    name="ip-rule"
                                    className="mt-1"
                                    checked={mode === option}
                                    disabled={unavailable}
                                    onChange={() => setMode(option)}
                                />
                                <span className="flex min-w-0 flex-col">
                                    <span>{t(`connectedApps.ip.modes.${option}.label`)}</span>
                                    <span className="text-xs text-muted-foreground [overflow-wrap:anywhere]">
                                        {option === "origin"
                                            ? approvedIp
                                                ? t("connectedApps.ip.modes.origin.hint", {
                                                      ip: approvedIp
                                                  })
                                                : t("connectedApps.ip.noOrigin")
                                            : t(`connectedApps.ip.modes.${option}.hint`)}
                                    </span>
                                </span>
                            </label>
                        );
                    })}
                </fieldset>
                {mode === "list" ? (
                    <div className="flex flex-col gap-3">
                        <RuleListInput
                            label={t("connectedApps.ip.allow")}
                            placeholder={t("connectedApps.ip.placeholder")}
                            hint={t("connectedApps.ip.allowHint")}
                            values={allow}
                            validate={validate}
                            onChange={(next) => setAllow(next.slice(0, IP_LIST_MAX))}
                        />
                        <RuleListInput
                            label={t("connectedApps.ip.deny")}
                            placeholder={t("connectedApps.ip.placeholder")}
                            hint={t("connectedApps.ip.denyHint")}
                            tone="deny"
                            values={deny}
                            validate={validate}
                            onChange={(next) => setDeny(next.slice(0, IP_LIST_MAX))}
                        />
                        {!valid ? (
                            <p className="text-xs text-muted-foreground">
                                {t("connectedApps.ip.listEmpty")}
                            </p>
                        ) : null}
                    </div>
                ) : null}
                {showException ? (
                    <fieldset
                        className="flex min-w-0 flex-col gap-2 border-t border-border pt-3"
                        disabled={!canExcept}
                        aria-describedby="exception-hint"
                    >
                        <legend className="pt-3 text-sm font-medium">
                            {t("connectedApps.exception.title")}
                        </legend>
                        <p id="exception-hint" className="text-xs text-muted-foreground">
                            {canExcept
                                ? t("connectedApps.exception.hint")
                                : t("connectedApps.exception.adminOnly")}
                        </p>
                        <label className="flex min-w-0 items-start gap-2 text-sm">
                            <input
                                type="checkbox"
                                className="mt-1"
                                checked={exception.presets.includes("openai")}
                                onChange={(event) =>
                                    setException({
                                        ...exception,
                                        presets: event.target.checked ? ["openai"] : []
                                    })
                                }
                            />
                            <span className="flex min-w-0 flex-col">
                                <span>{t("connectedApps.exception.openai.label")}</span>
                                <span className="text-xs text-muted-foreground">
                                    {t("connectedApps.exception.openai.hint")}
                                </span>
                            </span>
                        </label>
                        <GeoPicker
                            countries={exception.allowedCountries}
                            continents={exception.allowedContinents}
                            onCountries={(allowedCountries) =>
                                setException({
                                    ...exception,
                                    allowedCountries: allowedCountries.slice(0, EXCEPTION_LIST_MAX)
                                })
                            }
                            onContinents={(allowedContinents) =>
                                setException({ ...exception, allowedContinents })
                            }
                        />
                        <RuleListInput
                            label={t("connectedApps.exception.addresses")}
                            placeholder={t("connectedApps.ip.placeholder")}
                            values={exception.allowedCidrs}
                            validate={validate}
                            onChange={(next) =>
                                setException({
                                    ...exception,
                                    allowedCidrs: next.slice(0, EXCEPTION_LIST_MAX)
                                })
                            }
                        />
                    </fieldset>
                ) : null}
                <div className="mt-4 flex justify-end gap-2">
                    <Button variant="ghost" onClick={onCancel}>
                        {tc("actions.cancel")}
                    </Button>
                    <Button
                        disabled={unchanged || !valid}
                        aria-disabled={unchanged || !valid}
                        onClick={() => onSave(draft, exception)}
                    >
                        {t("connectedApps.save")}
                    </Button>
                </div>
            </DialogContent>
        </Dialog>
    );
}
