"use client";

/**
 * The one field Polaris asks for a phone number with: the country on the left,
 * picked from a list typed down by name or calling code, and the number on the
 * right, grouped the way that country writes it as it is typed.
 *
 * It reports the number in E.164 (`+34600111222`), or an empty string when
 * nothing is typed, so every form stores the same shape the server checks. A
 * number pasted or typed with its own `+` moves the picker to its country. The
 * country starts on the number's own country when there already is one, and
 * otherwise on where the reader is (see `defaultPhoneCountry`): the country the
 * server placed the request in, handed down by `PhoneRegionProvider`, else the
 * region of their languages, else their time zone.
 *
 * Country names come from the runtime (`Intl.DisplayNames`) in the reader's
 * language, so every language Polaris speaks names them without a catalog. The
 * list is the shared searchable menu: portalled above dialogs, kept on screen,
 * walked with the arrow keys. Its flags are fetched only for the rows scrolled
 * into view (see `CountryFlag`).
 */

import { cn } from "../lib/cn";
import { Input } from "./input";
import { CountryFlag } from "./country-flag";
import { useLocale, useTranslations } from "../i18n";
import { filterSearchableOptions, SearchableSelect, type SearchableSelectOption } from "./searchable-select";
import {
    createContext,
    useContext,
    useEffect,
    useMemo,
    useRef,
    useState,
    type FocusEvent,
    type KeyboardEvent,
    type ReactNode
} from "react";
import {
    defaultPhoneCountry,
    formatPhoneAsTyped,
    isPhoneCountry,
    phoneCountries,
    phoneCallingCode,
    phoneCountryFromLocales,
    phoneMainCountry,
    splitPhone,
    toE164,
    type PhoneCountry
} from "@polaris/core";

/** Text with its accents dropped, so a plain keyboard still finds "Perú". */
function folded(text: string): string {
    return text.normalize("NFD").replace(/[̀-ͯ]/g, "");
}

/** A region's name in a language, or its code when the runtime has none. */
function regionName(names: Intl.DisplayNames | null, code: string): string {
    try {
        return names?.of(code) ?? code;
    } catch {
        return code;
    }
}

function displayNames(locale: string): Intl.DisplayNames | null {
    try {
        return new Intl.DisplayNames([locale], { type: "region" });
    } catch {
        return null;
    }
}

const optionsByLocale = new Map<string, SearchableSelectOption[]>();

/** Every country as a row, sorted by its name in the reader's language. */
export function phoneCountryOptions(locale: string): SearchableSelectOption[] {
    const known = optionsByLocale.get(locale);
    if (known) return known;
    const local = displayNames(locale);
    const english = displayNames("en");
    const rows = phoneCountries().map((code) => {
        const name = regionName(local, code);
        const calling = phoneCallingCode(code);
        const names = [name, regionName(english, code)];
        const keywords = [...names, ...names.map(folded), code, `+${calling}`, calling].join(" ");
        return {
            value: code,
            label: name,
            hint: `+${calling}`,
            keywords,
            icon: <CountryFlag code={code} />
        };
    }).sort((a, b) => a.label.localeCompare(b.label, locale));
    optionsByLocale.set(locale, rows);
    return rows;
}

/**
 * The options left after typing, the likeliest first: a country whose code or
 * calling code is exactly what was typed ("es", "+34", "34") - the code's main
 * country ahead of the others that share it - then one whose
 * name or calling code starts with it, then any that merely contain it.
 */
export function findPhoneCountries(
    options: readonly SearchableSelectOption[],
    query: string
): SearchableSelectOption[] {
    const found = filterSearchableOptions(options, query);
    const typed = folded(query.trim().toLowerCase());
    if (!typed) return found;
    const digits = /^\+?\d+$/.test(typed) ? typed.replace("+", "") : null;
    const rank = (option: SearchableSelectOption): number => {
        if (digits !== null) {
            const calling = typeof option.hint === "string" ? option.hint.replace("+", "") : "";
            // The country a shared code belongs to first leads ("+1" is the US).
            if (calling === digits) return option.value === phoneMainCountry(digits) ? 0 : 1;
            return calling.startsWith(digits) ? 2 : 3;
        }
        if (option.value.toLowerCase() === typed) return 0;
        const names = folded(String(option.keywords ?? "").toLowerCase());
        return typeof option.label === "string" && folded(option.label.toLowerCase()).startsWith(typed)
            ? 1
            : names.split(" ").some((word) => word.startsWith(typed))
              ? 2
              : 3;
    };
    // Array sort is stable, so each rank keeps the list's alphabetical order.
    return found
        .map((option) => ({ option, rank: rank(option) }))
        .sort((a, b) => a.rank - b.rank)
        .map((entry) => entry.option);
}

const PhoneRegionContext = createContext<string | null>(null);

/**
 * The country the server placed this request in (an ISO code, or null when it
 * could not tell), for every phone field below it to start on.
 */
export function PhoneRegionProvider({ country, children }: { country: string | null; children: ReactNode }) {
    return <PhoneRegionContext.Provider value={country}>{children}</PhoneRegionContext.Provider>;
}

/** What the field reports for `digits` typed as a number of `country`. */
function reported(digits: string, country: PhoneCountry): string {
    if (!digits) return "";
    // A whole number drops its trunk prefix (the 0 a UK number is dialled with
    // at home); a partial one is reported as typed, for the form to call
    // incomplete.
    return toE164(digits, country) ?? `+${phoneCallingCode(country)}${digits}`;
}

export interface PhoneInputProps {
    /** The number in E.164, or an empty string. */
    value: string;
    onChange: (value: string) => void;
    /** The country to start on when there is no number yet. */
    defaultCountry?: PhoneCountry;
    /** Show why a typed number is refused, under the field. */
    showError?: boolean;
    id?: string;
    name?: string;
    disabled?: boolean;
    required?: boolean;
    autoFocus?: boolean;
    placeholder?: string;
    className?: string;
    onBlur?: (event: FocusEvent<HTMLInputElement>) => void;
    onKeyDown?: (event: KeyboardEvent<HTMLInputElement>) => void;
    "aria-label"?: string;
}

export function PhoneInput({
    value,
    onChange,
    defaultCountry,
    showError,
    id,
    name,
    disabled,
    required,
    autoFocus,
    placeholder,
    className,
    onBlur,
    onKeyDown,
    "aria-label": ariaLabel
}: PhoneInputProps) {
    const t = useTranslations("components");
    const locale = useLocale();
    const serverCountry = useContext(PhoneRegionContext);
    // What the first paint can know on both sides; the browser's own signals
    // follow once there is a browser to ask (below).
    const startCountry = defaultCountry ?? defaultPhoneCountry({ server: serverCountry, locales: [locale] });
    const [country, setCountry] = useState<PhoneCountry>(
        () => splitPhone(value).country ?? startCountry
    );
    const [national, setNational] = useState(() => splitPhone(value).national);
    // What this field last reported, so a value handed back unchanged is not
    // read again over what is being typed.
    const lastReported = useRef(value);
    const options = useMemo(() => phoneCountryOptions(locale), [locale]);

    // A number set from outside (a reset, a record loaded) replaces what is shown.
    useEffect(() => {
        if (value === lastReported.current) return;
        lastReported.current = value;
        const split = splitPhone(value);
        if (split.country) setCountry(split.country);
        setNational(split.national);
    }, [value]);

    // Neither the server nor the interface language placed the reader: the
    // browser's languages, then its time zone, may.
    useEffect(() => {
        if (value || defaultCountry || isPhoneCountry(serverCountry?.toUpperCase()) || phoneCountryFromLocales([locale])) return;
        const found = defaultPhoneCountry({
            locales: navigator.languages ?? [navigator.language],
            timeZone: Intl.DateTimeFormat().resolvedOptions().timeZone
        });
        setCountry(found);
        // Only the first paint: a country picked afterwards is the reader's choice.
        // eslint-disable-next-line react-hooks/exhaustive-deps
    }, []);

    const report = (next: string) => {
        lastReported.current = next;
        onChange(next);
    };

    const type = (raw: string) => {
        if (raw.trimStart().startsWith("+")) {
            // A whole international number, typed or pasted: its own country wins.
            const digits = raw.replace(/\D/g, "");
            const split = splitPhone(`+${digits}`);
            if (split.country && isPhoneCountry(split.country)) {
                setCountry(split.country);
                setNational(split.national);
            } else setNational(raw.trim());
            report(digits ? `+${digits}` : "");
            return;
        }
        let digits = raw.replace(/\D/g, "");
        // Deleting a space or bracket the grouping put there deletes the digit
        // before it, or the grouping would put it straight back.
        if (raw.length < national.length && digits === national.replace(/\D/g, "")) {
            digits = digits.slice(0, -1);
        }
        setNational(digits ? formatPhoneAsTyped(digits, country) : "");
        report(reported(digits, country));
    };

    const pick = (code: string) => {
        if (!isPhoneCountry(code)) return;
        setCountry(code);
        const digits = national.startsWith("+") ? "" : national.replace(/\D/g, "");
        setNational(digits ? formatPhoneAsTyped(digits, code) : "");
        report(reported(digits, code));
    };

    const refused = Boolean(showError && value && toE164(value) === null);
    const errorId = id ? `${id}-error` : undefined;
    const countryName = regionName(displayNames(locale), country);

    return (
        <div className={cn("flex min-w-0 flex-col gap-1", className)}>
            <div className="flex min-w-0">
                <SearchableSelect
                    value={country}
                    onValueChange={pick}
                    options={options}
                    filter={findPhoneCountries}
                    searchPlaceholder={t("phoneInput.search")}
                    emptyText={t("phoneInput.empty")}
                    disabled={disabled}
                    aria-label={t("phoneInput.country")}
                    className="w-auto shrink-0 rounded-e-none"
                    contentClassName="w-[18rem] max-w-[calc(100vw-2rem)]"
                    renderValue={(option) => (
                        <span className="flex items-center gap-1.5 tabular-nums">
                            {option.icon}
                            {option.hint}
                        </span>
                    )}
                />
                <Input
                    id={id}
                    name={name}
                    type="tel"
                    inputMode="tel"
                    autoComplete="tel"
                    value={national}
                    disabled={disabled}
                    required={required}
                    autoFocus={autoFocus}
                    placeholder={placeholder}
                    aria-label={ariaLabel ?? t("phoneInput.number")}
                    aria-invalid={refused || undefined}
                    aria-describedby={refused ? errorId : undefined}
                    className="-ms-px min-w-0 flex-1 rounded-s-none tabular-nums"
                    onChange={(event) => type(event.target.value)}
                    onBlur={onBlur}
                    onKeyDown={onKeyDown}
                />
            </div>
            {refused ? (
                <span id={errorId} className="text-xs text-danger">
                    {t("phoneInput.invalid", { country: countryName })}
                </span>
            ) : null}
        </div>
    );
}
