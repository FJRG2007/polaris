"use client";

/**
 * Small pieces every section of the Network filter shares: rules and resolvers edited
 * one per line, and how a service or a list group is named on screen.
 */

import { Textarea } from "@polaris/ui";
import * as dns from "@/lib/dns-blocker/settings";

/** One rule or resolver per line, blank lines ignored. */
export function lines(text: string): string[] {
    return text
        .split("\n")
        .map((line) => line.trim())
        .filter(Boolean);
}

/** The lines `normalize` refuses, for saying which ones are wrong. */
export function rejected(text: string, normalize: (line: string) => string | null): string[] {
    return lines(text).filter((line) => normalize(line) === null);
}

/** A service's name by id, or the id when it is no longer offered. */
export function serviceName(id: string): string {
    return dns.DNS_SERVICES.find((service) => service.id === id)?.name ?? id;
}

/** Every zone this browser knows, with `current` kept even when it does not
 *  list it (an older runtime without `supportedValuesOf`). */
export function timeZones(current: string): string[] {
    const supported = (Intl as { supportedValuesOf?: (key: string) => string[] }).supportedValuesOf;
    let zones: string[] = [];
    try {
        zones = supported ? supported("timeZone") : [];
    } catch {
        zones = [];
    }
    return zones.includes(current) ? zones : [current, ...zones];
}

/** The zone this browser is in, which a first schedule is written in. */
export function browserTimeZone(): string {
    try {
        return Intl.DateTimeFormat().resolvedOptions().timeZone || "UTC";
    } catch {
        return "UTC";
    }
}

export function RuleField({
    label,
    value,
    onChange,
    bad,
    badText,
    placeholder = "ads.example.com\n*.tracker.example\n/^ad[0-9]*\\./",
    missing = null
}: {
    label: string;
    value: string;
    onChange: (value: string) => void;
    bad: readonly string[];
    badText: string;
    placeholder?: string;
    missing?: string | null;
}) {
    return (
        <label className="flex min-w-0 flex-col gap-1 text-sm">
            <span>{label}</span>
            <Textarea
                rows={6}
                value={value}
                placeholder={placeholder}
                spellCheck={false}
                aria-invalid={bad.length > 0 || Boolean(missing)}
                onChange={(event) => onChange(event.target.value)}
                className="font-mono text-xs"
            />
            {bad.length > 0 ? (
                <span className="break-all text-xs text-danger">
                    {badText} {bad.slice(0, 3).join(", ")}
                </span>
            ) : missing ? (
                <span className="text-xs text-danger">{missing}</span>
            ) : null}
        </label>
    );
}
