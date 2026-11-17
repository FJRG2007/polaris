"use client";

/**
 * "Require Polaris login" for one service, without going to the firewall.
 *
 * Not a setting of its own: the switch and the lists here read and write the
 * firewall's rule on the service's own scope, the same row the firewall's Service
 * scope shows. Turning it on here shows it on there, and an edit made there is what
 * this card reads the next time it opens. The card links to that rule for anything
 * beyond who gets in.
 *
 * The new-service form offers the same thing before the service exists; the server
 * writes it once the service has been created, and it covers whichever addresses
 * the service gets, now or later.
 */

import Link from "next/link";
import { Switch, useToast } from "@polaris/ui";
import type { WafPrincipalGrant } from "@polaris/core";
import { ArrowUpRight, ChevronRight } from "lucide-react";
import { useCallback, useEffect, useId, useRef, useState } from "react";
import { LoginPrincipals, type LoginPrincipalsPatch } from "@/app/(app)/apps/firewall/login-principals";
import {
    getServiceLoginAction,
    serviceLoginAccessAction,
    setServiceLoginAction,
    type ServiceLoginRefusal,
    type ServiceLoginView
} from "@/app/(app)/apps/firewall/actions";
import { useTranslations } from "@/components/i18n/i18n-provider";
import { CardError, CardSkeleton, SettingsCard } from "./settings-kit";

/** Where the firewall opens straight on this service's login rule. */
export function serviceLoginRuleHref(applicationId: string): string {
    return `/apps/firewall?scope=application&id=${encodeURIComponent(applicationId)}&rule=login`;
}

type Loaded = { login?: ServiceLoginView; refusal?: ServiceLoginRefusal };

/** The last answer per service, so reopening the tab draws it at once while it is
 *  read again. Never trusted for the write: every save is checked by the server. */
const lastRead = new Map<string, Loaded>();

export function ServiceLoginCard({ applicationId }: { applicationId: string }) {
    const t = useTranslations("deployService");
    const toast = useToast();
    const reasonId = useId();
    const [loaded, setLoaded] = useState<Loaded | null>(() => lastRead.get(applicationId) ?? null);
    const [error, setError] = useState<string | null>(null);
    const [saving, setSaving] = useState(false);
    const confirmed = useRef<ServiceLoginView | null>(loaded?.login ?? null);

    const load = useCallback(() => {
        setError(null);
        void getServiceLoginAction(applicationId).then((result) => {
            if (result.error) {
                setError(result.error);
                return;
            }
            const next = { login: result.login, refusal: result.refusal };
            lastRead.set(applicationId, next);
            confirmed.current = result.login ?? null;
            setLoaded(next);
        });
    }, [applicationId]);

    useEffect(load, [load]);

    const title = t("login.title");
    if (!loaded && error)
        return <CardError entry="polarisLogin" title={title} message={error} onRetry={load} />;
    if (!loaded) return <CardSkeleton entry="polarisLogin" title={title} />;

    const login = loaded.login;
    const on = Boolean(login && (login.requireLogin || login.requiredAbove));
    const noAddress = Boolean(login && login.hostnameCount === 0);
    // Why the switch cannot be used, when it cannot - said under it, never a
    // control that answers with a refusal after the click.
    const reason = loaded.refusal
        ? t(`login.refusal.${loaded.refusal}`)
        : login?.requiredAbove
          ? t("login.aboveNote")
          : noAddress && !on
            ? t("login.noAddress")
            : null;
    const locked = !login || Boolean(loaded.refusal) || login.requiredAbove || (noAddress && !on);

    /** Optimistic: drawn at once, put back as the server last had it if refused. */
    function save(patch: LoginPrincipalsPatch & { requireLogin?: boolean }): void {
        const before = confirmed.current;
        if (!before) return;
        const next = { ...before, ...patch };
        setLoaded((current) => (current ? { ...current, login: next } : current));
        setSaving(true);
        void setServiceLoginAction({ applicationId, ...patch }).then((result) => {
            setSaving(false);
            if (result.error) {
                setLoaded((current) => (current ? { ...current, login: before } : current));
                toast.show({ title: result.error });
                return;
            }
            confirmed.current = next;
            lastRead.set(applicationId, { login: next });
        });
    }

    return (
        <SettingsCard
            entry="polarisLogin"
            title={title}
            description={t("login.hint")}
            busy={saving}
            actions={
                loaded.refusal ? undefined : (
                    <Link
                        href={serviceLoginRuleHref(applicationId)}
                        className="inline-flex items-center gap-1 text-xs font-medium text-primary hover:underline"
                    >
                        {t("login.openRule")}
                        <ArrowUpRight className="size-3.5 shrink-0" aria-hidden="true" />
                    </Link>
                )
            }
        >
            <div className="flex flex-col gap-3">
                <div className="flex items-center gap-3">
                    <Switch
                        checked={on}
                        disabled={locked || saving}
                        onChange={(next) => save({ requireLogin: next })}
                        aria-label={t("login.title")}
                        aria-describedby={reason ? reasonId : undefined}
                    />
                    <span className="min-w-0 text-sm">
                        {on ? t("login.on") : t("login.off")}
                    </span>
                </div>
                {reason ? (
                    <p id={reasonId} className="text-xs text-muted-foreground">
                        {reason}
                    </p>
                ) : null}
                {login && login.hostnameCount > 0 ? (
                    <p
                        className="min-w-0 truncate text-xs text-muted-foreground"
                        title={login.hostnames.join(", ")}
                    >
                        {login.hostnameCount > login.hostnames.length
                            ? t("login.guardsMore", {
                                  hosts: login.hostnames.join(", "),
                                  count: login.hostnameCount - login.hostnames.length
                              })
                            : t("login.guards", { hosts: login.hostnames.join(", ") })}
                    </p>
                ) : null}
                {login && on ? (
                    <div className="flex flex-col gap-2">
                        <span className="text-xs font-medium text-muted-foreground">
                            {t("login.admits")}
                        </span>
                        <LoginPrincipals
                            scope={{ scopeType: "application", scopeId: applicationId }}
                            admitted={login.loginAllowPrincipals}
                            refused={login.loginDenyPrincipals}
                            disabled={Boolean(loaded.refusal) || saving}
                            onChange={save}
                        />
                    </div>
                ) : null}
            </div>
        </SettingsCard>
    );
}

/** Who a new service lets in, or null to leave it open as before. */
export type LoginOnCreateValue = {
    loginAllowPrincipals: WafPrincipalGrant[];
    loginDenyPrincipals: WafPrincipalGrant[];
} | null;

/**
 * The new-service form's advanced option: put the service behind a Polaris login
 * from its first deploy. Whether the creator may is asked when the option is first
 * opened, with the same checks the write makes.
 */
export function LoginOnCreate({
    environmentId,
    value,
    onChange
}: {
    environmentId: string;
    value: LoginOnCreateValue;
    onChange: (next: LoginOnCreateValue) => void;
}) {
    const t = useTranslations("deployService");
    const reasonId = useId();
    const [open, setOpen] = useState(value !== null);
    const [access, setAccess] = useState<{ refusal?: ServiceLoginRefusal; error?: string } | null>(
        null
    );

    useEffect(() => {
        if (!open || access) return;
        let active = true;
        void serviceLoginAccessAction(environmentId).then((result) => {
            if (active) setAccess(result);
        });
        return () => {
            active = false;
        };
    }, [open, access, environmentId]);

    const reason = access?.refusal
        ? t(`login.refusal.${access.refusal}`)
        : (access?.error ?? null);
    const usable = access !== null && !reason;

    return (
        <div className="flex flex-col gap-3">
            <button
                type="button"
                onClick={() => setOpen((shown) => !shown)}
                aria-expanded={open}
                className="flex items-center gap-1 self-start text-xs font-medium text-muted-foreground transition-colors hover:text-foreground"
            >
                <ChevronRight
                    className={`size-3.5 shrink-0 transition-transform ${open ? "rotate-90" : ""}`}
                    aria-hidden="true"
                />
                {t("login.advanced")}
            </button>
            {open && (
                <div className="flex flex-col gap-3 rounded-md border border-border/60 p-3">
                    <div className="flex items-start gap-3">
                        <Switch
                            checked={value !== null}
                            disabled={!usable}
                            onChange={(next) =>
                                onChange(
                                    next ? { loginAllowPrincipals: [], loginDenyPrincipals: [] } : null
                                )
                            }
                            aria-label={t("login.title")}
                            aria-describedby={reasonId}
                        />
                        <div className="flex min-w-0 flex-col gap-0.5">
                            <span className="text-sm font-medium">{t("login.title")}</span>
                            <span id={reasonId} className="text-xs text-muted-foreground">
                                {reason ?? t("login.createHint")}
                            </span>
                        </div>
                    </div>
                    {value !== null && usable && (
                        <LoginPrincipals
                            scope={{ scopeType: "environment", scopeId: environmentId }}
                            admitted={value.loginAllowPrincipals}
                            refused={value.loginDenyPrincipals}
                            onChange={(patch) => onChange({ ...value, ...patch })}
                        />
                    )}
                </div>
            )}
        </div>
    );
}
