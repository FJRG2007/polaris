"use client";

/**
 * The one "Advanced" section of every share-by-link dialog in Polaris: a
 * password, a start and an expiry, a weekly window, a cap on uses, whether it
 * needs an account and whose, and who may open it by address and by region.
 * Drive, snippets, notes, documents, drop points, sends, forms, meetings and
 * Places all draw this same section so a link offers the same limits, in the
 * same words and order, wherever it is made. A surface leaves out only what
 * genuinely cannot apply to it, and says why where it does.
 *
 * Controlled: the parent owns the value. What is shown here is only what will
 * be saved; the public route enforces it (`lib/link-guards` `checkLink`).
 */

import { useEffect, useMemo, useState } from "react";
import * as core from "@polaris/core";
import { Lock } from "lucide-react";
import { Input, Switch, cn } from "@polaris/ui";
import { AccountInput } from "@/components/account-input";
import type { LinkGuardsView } from "@/lib/link-guards";
import { useDisplayFormat } from "@/components/display-format";
import { useLocale, useTranslations } from "@/components/i18n/i18n-provider";
import { AccessRulesEditor, type AccessRulesValue } from "@/components/access-rules-editor";

/** The parts a surface can leave out. */
export type LinkAdvancedPart =
    "password" | "starts" | "expiry" | "uses" | "schedule" | "signin" | "people" | "places";

export interface LinkAdvancedValue {
    password: string;
    /** Take off the password the link already has. */
    clearPassword?: boolean;
    /** A `yyyy-mm-dd` day, or empty for no expiry. */
    expiresAt: string;
    /** A positive whole number as typed, or empty for no cap. */
    maxUses: string;
    allowedCidrs: string[];
    allowedCountries: string[];
    allowedContinents: string[];
    /** A `yyyy-mm-dd` day it opens on, or empty for now. */
    startsAt: string;
    /** The days of the week it opens on, as the presence-schedule bitmask. */
    days: number;
    /** `hh:mm` it opens and closes each of those days; both empty is all day. */
    hoursFrom: string;
    hoursTo: string;
    /** The time zone the hours are read in, or empty for the reader's own. */
    timeZone: string;
    /** Only somebody signed in to an account here may open it. */
    requireLogin: boolean;
    /** Only these accounts (username or address) may open it. */
    allowedUsers: string[];
}

export const EMPTY_LINK_ADVANCED: LinkAdvancedValue = {
    password: "",
    expiresAt: "",
    maxUses: "",
    allowedCidrs: [],
    allowedCountries: [],
    allowedContinents: [],
    startsAt: "",
    days: core.EVERY_DAY,
    hoursFrom: "",
    hoursTo: "",
    timeZone: "",
    requireLogin: false,
    allowedUsers: []
};

/** The address rules of a value, as a link's schema takes them. */
export function linkAddressRules(value: LinkAdvancedValue): {
    allowedCidrs: string[];
    allowedCountries: string[];
    allowedContinents: string[];
} {
    return {
        allowedCidrs: value.allowedCidrs,
        allowedCountries: value.allowedCountries,
        allowedContinents: value.allowedContinents
    };
}

/** The end of a `yyyy-mm-dd` day in the reader's time, or null for none. */
export function linkExpiry(day: string): Date | null {
    return day ? new Date(`${day}T23:59:59.999`) : null;
}

/** A stored expiry as the `yyyy-mm-dd` day it ends, in the reader's time. */
export function linkExpiryDay(iso: string | null): string {
    if (!iso) return "";
    const date = new Date(iso);
    const pad = (n: number) => String(n).padStart(2, "0");
    return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}`;
}

/** A link with no start, window or account rules, for a row drawn before it is saved. */
export const NO_LINK_GUARDS: LinkGuardsView = {
    startsAt: null,
    schedule: null,
    requireLogin: false,
    allowedUsers: []
};

/** The start of a `yyyy-mm-dd` day in the reader's time, or null for none. */
export function linkStart(day: string): Date | null {
    return day ? new Date(`${day}T00:00:00`) : null;
}

const clockMinutes = (clock: string): number | null => {
    const match = /^(\d{2}):(\d{2})$/.exec(clock);
    return match ? Number(match[1]) * 60 + Number(match[2]) : null;
};

const minuteClock = (minute: number | null): string =>
    minute === null
        ? ""
        : `${String(Math.floor(minute / 60)).padStart(2, "0")}:${String(minute % 60).padStart(2, "0")}`;

/** The reader's own time zone, which is whose clock a weekly window is read on. */
function readerZone(): string {
    return Intl.DateTimeFormat().resolvedOptions().timeZone || "UTC";
}

/** The weekly window of a value, or null when it opens every day at any hour. */
export function linkSchedule(value: LinkAdvancedValue): core.LinkSchedule | null {
    const startMinute = clockMinutes(value.hoursFrom);
    const endMinute = clockMinutes(value.hoursTo);
    const hours = startMinute !== null && endMinute !== null;
    if (value.days === core.EVERY_DAY && !hours) return null;
    return {
        days: value.days || core.EVERY_DAY,
        startMinute: hours ? startMinute : null,
        endMinute: hours ? endMinute : null,
        timeZone: value.timeZone || readerZone()
    };
}

/** The start, window and account rules of a value, as `linkLimitsSchema` takes them. */
export function linkPeopleLimits(value: LinkAdvancedValue) {
    return {
        startsAt: linkStart(value.startsAt)?.toISOString() ?? null,
        schedule: linkSchedule(value),
        requireLogin: value.requireLogin || value.allowedUsers.length > 0,
        allowedUsers: value.allowedUsers
    };
}

/** A link's stored start, window and account rules as the fields of a value. */
export function linkGuardFields(
    view: LinkGuardsView | null | undefined
): Pick<
    LinkAdvancedValue,
    "startsAt" | "days" | "hoursFrom" | "hoursTo" | "timeZone" | "requireLogin" | "allowedUsers"
> {
    return {
        startsAt: linkExpiryDay(view?.startsAt ?? null),
        days: view?.schedule?.days ?? core.EVERY_DAY,
        hoursFrom: minuteClock(view?.schedule?.startMinute ?? null),
        hoursTo: minuteClock(view?.schedule?.endMinute ?? null),
        timeZone: view?.schedule?.timeZone ?? "",
        requireLogin: view?.requireLogin ?? false,
        allowedUsers: view?.allowedUsers ?? []
    };
}

/** Whether the hours are half filled in, which cannot be saved. */
export function linkHoursIncomplete(value: LinkAdvancedValue): boolean {
    return (
        (value.hoursFrom === "") !== (value.hoursTo === "") ||
        (value.hoursFrom !== "" && value.hoursFrom === value.hoursTo)
    );
}

/** The password part of a value, as `linkLimitsSchema` takes it. */
export function linkPasswordLimits(
    value: LinkAdvancedValue
): { password: string } | { clearPassword: true } | Record<string, never> {
    if (value.password) return { password: value.password };
    return value.clearPassword ? { clearPassword: true } : {};
}

/** A value as `linkLimitsSchema` takes it. */
export function linkLimits(value: LinkAdvancedValue) {
    return {
        ...linkPasswordLimits(value),
        maxViews: value.maxUses ? Number(value.maxUses) : null,
        expiresAt: linkExpiry(value.expiresAt)?.toISOString() ?? null,
        ...linkAddressRules(value),
        ...linkPeopleLimits(value)
    };
}

/** How many limits a value sets, for the section's summary. */
export function linkAdvancedCount(value: LinkAdvancedValue): number {
    return [
        value.password,
        value.expiresAt,
        value.maxUses,
        value.allowedCidrs.length > 0,
        value.allowedCountries.length + value.allowedContinents.length > 0,
        value.startsAt,
        value.days !== core.EVERY_DAY || value.hoursFrom || value.hoursTo,
        value.requireLogin && value.allowedUsers.length === 0,
        value.allowedUsers.length > 0
    ].filter(Boolean).length;
}

/** Comma-separated identities typed into the people field, as a list. */
function identities(text: string): string[] {
    return Array.from(
        new Set(
            text
                .split(",")
                .map((one) => one.trim().toLowerCase().replace(/^@+/, ""))
                .filter(Boolean)
        )
    );
}

export function LinkAdvancedFields({
    value,
    onChange,
    omit = [],
    usesLabel,
    passwordSet = false,
    clearablePassword = false,
    idPrefix = "link"
}: {
    value: LinkAdvancedValue;
    onChange: (next: LinkAdvancedValue) => void;
    omit?: readonly LinkAdvancedPart[];
    /** What one use is called here: a download, an open, a view. */
    usesLabel?: string;
    /** The link already has a password; typing one replaces it. */
    passwordSet?: boolean;
    /** Offer to take the existing password off (`clearPassword` on the value). */
    clearablePassword?: boolean;
    idPrefix?: string;
}) {
    const t = useTranslations("components");
    const locale = useLocale();
    const format = useDisplayFormat();
    const dayNames = useMemo(() => core.weekdayNames(locale, "short"), [locale]);
    const weekOrder = useMemo(() => core.weekOrderFrom(format.weekStartsOn), [format.weekStartsOn]);
    const shows = (part: LinkAdvancedPart) => !omit.includes(part);
    const rules: AccessRulesValue = { groupIds: [], ...linkAddressRules(value) };
    const count = linkAdvancedCount(value);
    // The people field keeps what was typed, trailing comma and all; the value
    // only ever holds the parsed list.
    const [peopleText, setPeopleText] = useState(value.allowedUsers.join(", "));
    useEffect(() => {
        if (identities(peopleText).join(",") !== value.allowedUsers.join(",")) {
            setPeopleText(value.allowedUsers.join(", "));
        }
        // Only an outside change (a reset, a link loaded) rewrites the field.
        // eslint-disable-next-line react-hooks/exhaustive-deps
    }, [value.allowedUsers]);
    // What the section holds, named while it is shut, so it reads as more than
    // "no limits" to somebody who has not opened it.
    const offered = [
        shows("password") ? t("linkAdvanced.offer.password") : null,
        shows("starts") || shows("expiry") ? t("linkAdvanced.offer.dates") : null,
        shows("schedule") ? t("linkAdvanced.offer.hours") : null,
        shows("uses") ? t("linkAdvanced.offer.uses") : null,
        shows("signin") || shows("people") ? t("linkAdvanced.offer.people") : null,
        shows("places") ? t("linkAdvanced.offer.places") : null
    ].filter((one): one is string => one !== null);
    const hoursBad = linkHoursIncomplete(value);

    return (
        <details className="group rounded-md border border-border" open={count > 0}>
            <summary className="flex cursor-pointer items-center justify-between gap-2 px-3 py-2 text-sm">
                <span className="min-w-0 truncate">{t("linkAdvanced.title")}</span>
                <span
                    className="min-w-0 truncate text-xs text-muted-foreground"
                    title={count > 0 ? undefined : offered.join(", ")}
                >
                    {count > 0
                        ? t("linkAdvanced.set", { count })
                        : t("linkAdvanced.none", { offers: offered.join(", ") })}
                </span>
            </summary>
            <div className="flex flex-col gap-3 border-t border-border p-3">
                {shows("password") || shows("starts") || shows("expiry") || shows("uses") ? (
                    <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
                        {shows("password") ? (
                            <div className="flex min-w-0 flex-col gap-1">
                                <label
                                    className="flex min-w-0 flex-col gap-1"
                                    htmlFor={`${idPrefix}-password`}
                                >
                                    <span className="text-xs text-muted-foreground">
                                        <Lock className="mr-1 inline size-3" aria-hidden />
                                        {passwordSet
                                            ? t("linkAdvanced.replacePassword")
                                            : t("linkAdvanced.password")}
                                    </span>
                                    {/* enigma:allow-no-breach-check enigma:allow-identity-password -
                                        a link's own passphrase, not a credential: it authenticates
                                        nobody and guesses at it are limited per link per address. */}
                                    <Input
                                        id={`${idPrefix}-password`}
                                        type="password"
                                        value={value.password}
                                        disabled={value.clearPassword === true}
                                        placeholder={
                                            passwordSet
                                                ? t("linkAdvanced.passwordSet")
                                                : t("linkAdvanced.passwordNone")
                                        }
                                        autoComplete="new-password"
                                        onChange={(event) =>
                                            onChange({ ...value, password: event.target.value })
                                        }
                                    />
                                </label>
                                {passwordSet && clearablePassword ? (
                                    <label className="flex items-center gap-2 text-xs">
                                        <input
                                            type="checkbox"
                                            className="size-4"
                                            checked={value.clearPassword === true}
                                            onChange={(event) => {
                                                const { clearPassword: _, ...rest } = value;
                                                onChange(
                                                    event.target.checked
                                                        ? {
                                                              ...rest,
                                                              password: "",
                                                              clearPassword: true
                                                          }
                                                        : rest
                                                );
                                            }}
                                        />
                                        {t("linkAdvanced.removePassword")}
                                    </label>
                                ) : null}
                            </div>
                        ) : null}
                        {shows("starts") ? (
                            <label
                                className="flex min-w-0 flex-col gap-1"
                                htmlFor={`${idPrefix}-starts`}
                            >
                                <span className="text-xs text-muted-foreground">
                                    {t("linkAdvanced.starts")}
                                </span>
                                <Input
                                    id={`${idPrefix}-starts`}
                                    type="date"
                                    value={value.startsAt}
                                    max={value.expiresAt || undefined}
                                    onChange={(event) =>
                                        onChange({ ...value, startsAt: event.target.value })
                                    }
                                />
                            </label>
                        ) : null}
                        {shows("expiry") ? (
                            <label
                                className="flex min-w-0 flex-col gap-1"
                                htmlFor={`${idPrefix}-expires`}
                            >
                                <span className="text-xs text-muted-foreground">
                                    {t("linkAdvanced.expires")}
                                </span>
                                <Input
                                    id={`${idPrefix}-expires`}
                                    type="date"
                                    value={value.expiresAt}
                                    min={value.startsAt || undefined}
                                    onChange={(event) =>
                                        onChange({ ...value, expiresAt: event.target.value })
                                    }
                                />
                            </label>
                        ) : null}
                        {shows("uses") ? (
                            <label
                                className="flex min-w-0 flex-col gap-1"
                                htmlFor={`${idPrefix}-uses`}
                            >
                                <span className="text-xs text-muted-foreground">
                                    {usesLabel ?? t("linkAdvanced.uses")}
                                </span>
                                <Input
                                    id={`${idPrefix}-uses`}
                                    type="number"
                                    min={1}
                                    step={1}
                                    inputMode="numeric"
                                    value={value.maxUses}
                                    placeholder={t("linkAdvanced.noLimit")}
                                    onChange={(event) =>
                                        onChange({ ...value, maxUses: event.target.value })
                                    }
                                />
                            </label>
                        ) : null}
                    </div>
                ) : null}
                {shows("schedule") ? (
                    <fieldset className="flex min-w-0 flex-col gap-2">
                        <legend className="text-xs text-muted-foreground">
                            {t("linkAdvanced.days")}
                        </legend>
                        <div className="flex flex-wrap gap-1">
                            {weekOrder.map((day: number) => {
                                const on = core.runsOnDay(value.days, day);
                                return (
                                    <button
                                        key={day}
                                        type="button"
                                        aria-pressed={on}
                                        onClick={() => {
                                            const days = core.toggleDay(value.days, day);
                                            // Zero days is a link that never opens.
                                            if (days !== 0) onChange({ ...value, days });
                                        }}
                                        className={cn(
                                            "min-h-11 rounded-md border px-3 text-xs sm:min-h-0 sm:px-2 sm:py-1",
                                            on
                                                ? "border-primary bg-primary/10 text-foreground"
                                                : "border-border text-muted-foreground"
                                        )}
                                    >
                                        {dayNames[day]}
                                    </button>
                                );
                            })}
                        </div>
                        <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
                            <label
                                className="flex min-w-0 flex-col gap-1"
                                htmlFor={`${idPrefix}-from`}
                            >
                                <span className="text-xs text-muted-foreground">
                                    {t("linkAdvanced.from")}
                                </span>
                                <Input
                                    id={`${idPrefix}-from`}
                                    type="time"
                                    value={value.hoursFrom}
                                    aria-invalid={hoursBad || undefined}
                                    onChange={(event) =>
                                        onChange({ ...value, hoursFrom: event.target.value })
                                    }
                                />
                            </label>
                            <label
                                className="flex min-w-0 flex-col gap-1"
                                htmlFor={`${idPrefix}-to`}
                            >
                                <span className="text-xs text-muted-foreground">
                                    {t("linkAdvanced.to")}
                                </span>
                                <Input
                                    id={`${idPrefix}-to`}
                                    type="time"
                                    value={value.hoursTo}
                                    aria-invalid={hoursBad || undefined}
                                    onChange={(event) =>
                                        onChange({ ...value, hoursTo: event.target.value })
                                    }
                                />
                            </label>
                        </div>
                        <p
                            className={cn(
                                "text-xs",
                                hoursBad ? "text-danger" : "text-muted-foreground"
                            )}
                        >
                            {hoursBad
                                ? t("linkAdvanced.hoursIncomplete")
                                : t("linkAdvanced.hoursHint", {
                                      zone: value.timeZone || readerZone()
                                  })}
                        </p>
                    </fieldset>
                ) : null}
                {shows("signin") ? (
                    <label className="flex items-center justify-between gap-2 text-sm">
                        <span className="flex min-w-0 flex-col">
                            <span className="truncate">{t("linkAdvanced.requireLogin")}</span>
                            <span className="text-xs text-muted-foreground">
                                {t("linkAdvanced.requireLoginHint")}
                            </span>
                        </span>
                        <Switch
                            checked={value.requireLogin || value.allowedUsers.length > 0}
                            disabled={value.allowedUsers.length > 0}
                            onChange={(requireLogin) => onChange({ ...value, requireLogin })}
                            aria-label={t("linkAdvanced.requireLogin")}
                        />
                    </label>
                ) : null}
                {shows("people") ? (
                    <label className="flex min-w-0 flex-col gap-1" htmlFor={`${idPrefix}-people`}>
                        <span className="text-xs text-muted-foreground">
                            {t("linkAdvanced.people")}
                        </span>
                        <AccountInput
                            id={`${idPrefix}-people`}
                            multiple
                            value={peopleText}
                            onValueChange={(text) => {
                                setPeopleText(text);
                                onChange({ ...value, allowedUsers: identities(text) });
                            }}
                            placeholder={t("linkAdvanced.peoplePlaceholder")}
                            aria-label={t("linkAdvanced.people")}
                        />
                        <span className="text-xs text-muted-foreground">
                            {t("linkAdvanced.peopleHint")}
                        </span>
                    </label>
                ) : null}
                {shows("places") ? (
                    <AccessRulesEditor
                        value={rules}
                        groups={[]}
                        showGroups={false}
                        onChange={(next) =>
                            onChange({
                                ...value,
                                allowedCidrs: next.allowedCidrs,
                                allowedCountries: next.allowedCountries,
                                allowedContinents: next.allowedContinents
                            })
                        }
                    />
                ) : null}
                <p className="text-xs text-muted-foreground">{t("linkAdvanced.hint")}</p>
            </div>
        </details>
    );
}
