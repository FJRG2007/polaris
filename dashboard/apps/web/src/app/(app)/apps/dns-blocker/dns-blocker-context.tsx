"use client";

/**
 * What every section of the Network filter shares: where the blocker stands, the one
 * settings row as edited, and the save that applies it.
 *
 * It sits in the layout, so moving between sections keeps an unsaved edit and
 * asks port 53 once rather than once per screen. The settings arrive with the
 * page; the status is asked after the first paint, so only what shows it waits.
 */

import {
    createContext,
    useCallback,
    useContext,
    useEffect,
    useMemo,
    useState,
    useTransition,
    type ReactNode
} from "react";
import * as dns from "@/lib/dns-blocker/settings";
import { browserTimeZone, lines, rejected } from "./fields";
import { useTranslations } from "@/components/i18n/i18n-provider";
import type { DnsBlockerState, DnsBlockerStatus } from "@/lib/dns-blocker/service";
import {
    dnsBlockerStatusAction,
    saveDnsSettingsAction,
    turnOffDnsBlockerAction,
    turnOnDnsBlockerAction
} from "./actions";

/** How many times a starting server is looked at on its own, 4 s apart. */
const STARTING_CHECKS = 15;

/** States in which a DNS server of ours exists. */
export const ENGINE_STATES: readonly DnsBlockerState[] = [
    "blocking",
    "starting",
    "portHeld",
    "conflict"
];

/** The settings as the form edits them: rules and resolvers as text, one per
 *  line, and the numbers as typed. */
export interface DnsForm {
    sources: string[];
    customLists: dns.DnsSettings["customLists"];
    allowText: string;
    denyText: string;
    upstream: string;
    upstreamText: string;
    records: dns.DnsSettings["records"];
    refreshHours: string;
    aliases: dns.DnsSettings["aliases"];
    clientGroups: dns.DnsSettings["clientGroups"];
    services: string[];
    logDays: string;
    namesFrom: string;
    devices: dns.DnsSettings["devices"];
    forwards: dns.DnsSettings["forwards"];
    safeSearch: boolean;
    youtube: dns.DnsSettings["youtube"];
    schedules: dns.DnsSettings["schedules"];
    timeZone: string;
    engine: dns.DnsEngine;
    cacheMinText: string;
    cacheMaxText: string;
}

export function formFrom(settings: dns.DnsSettings): DnsForm {
    return {
        sources: settings.sources,
        customLists: settings.customLists,
        allowText: settings.allow.join("\n"),
        denyText: settings.deny.join("\n"),
        upstream: settings.upstream,
        upstreamText: settings.customUpstreams.join("\n"),
        records: settings.records,
        refreshHours: String(settings.refreshHours),
        aliases: settings.aliases,
        clientGroups: settings.clientGroups,
        services: settings.services,
        logDays: String(settings.logDays),
        namesFrom: settings.namesFrom,
        devices: settings.devices,
        forwards: settings.forwards,
        safeSearch: settings.safeSearch,
        youtube: settings.youtube,
        schedules: settings.schedules,
        timeZone: settings.timeZone || "UTC",
        engine: settings.engine,
        cacheMinText: String(settings.engine.cacheMinMinutes),
        cacheMaxText: String(settings.engine.cacheMaxMinutes)
    };
}

type Notice = { tone: "error" | "ok"; text: string } | null;

export interface DnsBlockerContextValue {
    status: DnsBlockerStatus | null;
    statusError: string | null;
    checking: boolean;
    switching: boolean;
    saving: boolean;
    /** The server has been coming up for longer than it should. */
    stalled: boolean;
    engineExists: boolean;
    saved: dns.DnsSettings;
    form: DnsForm;
    setField: <K extends keyof DnsForm>(
        key: K,
        value: DnsForm[K] | ((current: DnsForm[K]) => DnsForm[K])
    ) => void;
    /** Replaces the whole form, as an import does; nothing is saved yet. */
    loadForm: (settings: dns.DnsSettings) => void;
    draft: dns.DnsSettings;
    dirty: boolean;
    valid: boolean;
    checks: {
        badAllow: string[];
        badDeny: string[];
        badUpstreams: string[];
        hoursValid: boolean;
        daysValid: boolean;
        namesFromValid: boolean;
        customEmpty: boolean;
        tooMany: boolean;
        aliasClash: string[];
        engineIssue: "cacheRange" | "cacheMinutes" | null;
    };
    notice: Notice;
    save: () => void;
    switchTo: (on: boolean) => void;
    recheck: () => void;
    /** A rule set from the query log, adopted without touching an edited list. */
    adoptRules: (next: dns.DnsSettings) => void;
}

const Context = createContext<DnsBlockerContextValue | null>(null);

export function useDnsBlocker(): DnsBlockerContextValue {
    const value = useContext(Context);
    if (!value) throw new Error("useDnsBlocker outside DnsBlockerProvider");
    return value;
}

/** One field of the form, read and set like a piece of state. */
export function useField<K extends keyof DnsForm>(
    key: K
): [DnsForm[K], (value: DnsForm[K] | ((current: DnsForm[K]) => DnsForm[K])) => void] {
    const { form, setField } = useDnsBlocker();
    return [form[key], (value) => setField(key, value)];
}

export function DnsBlockerProvider({
    initial,
    children
}: {
    initial: dns.DnsSettings;
    children: ReactNode;
}) {
    const t = useTranslations("dnsBlocker");
    const [status, setStatus] = useState<DnsBlockerStatus | null>(null);
    const [statusError, setStatusError] = useState<string | null>(null);
    const [checking, startChecking] = useTransition();
    const [switching, startSwitching] = useTransition();
    const [saving, startSaving] = useTransition();
    const [saved, setSaved] = useState(initial);
    const [notice, setNotice] = useState<Notice>(null);
    const [form, setForm] = useState<DnsForm>(() => formFrom(initial));

    const setField = useCallback(
        <K extends keyof DnsForm>(
            key: K,
            value: DnsForm[K] | ((current: DnsForm[K]) => DnsForm[K])
        ) =>
            setForm((current) => ({
                ...current,
                [key]:
                    typeof value === "function"
                        ? (value as (current: DnsForm[K]) => DnsForm[K])(current[key])
                        : value
            })),
        []
    );

    // Read after the first paint: the server does not know the reader's zone.
    useEffect(() => {
        if (!initial.timeZone) setField("timeZone", browserTimeZone());
    }, [initial.timeZone, setField]);

    const loadForm = useCallback((settings: dns.DnsSettings) => {
        setForm(formFrom(settings));
        setNotice(null);
    }, []);

    const adoptRules = useCallback(
        (next: dns.DnsSettings) => {
            setForm((current) => ({
                ...current,
                allowText:
                    current.allowText === saved.allow.join("\n")
                        ? next.allow.join("\n")
                        : current.allowText,
                denyText:
                    current.denyText === saved.deny.join("\n")
                        ? next.deny.join("\n")
                        : current.denyText
            }));
            setSaved((current) => ({ ...current, allow: next.allow, deny: next.deny }));
        },
        [saved]
    );

    const [startingChecks, setStartingChecks] = useState(0);

    const check = useCallback(() => {
        startChecking(async () => {
            const result = await dnsBlockerStatusAction();
            if (result.error !== undefined) {
                setStatusError(result.error);
                return;
            }
            setStatusError(null);
            setStatus(result.status);
        });
    }, []);

    useEffect(() => check(), [check]);

    /** A check somebody asked for, which also starts the automatic ones over. */
    const recheck = useCallback(() => {
        setStartingChecks(0);
        check();
    }, [check]);

    // While the server is coming up, look again on its own a few times, then
    // stop and say it has not come up rather than asking for ever.
    const stalled = status?.state === "starting" && startingChecks >= STARTING_CHECKS;
    useEffect(() => {
        if (status?.state !== "starting" || startingChecks >= STARTING_CHECKS) return;
        const timer = setTimeout(() => {
            setStartingChecks((count) => count + 1);
            check();
        }, 4000);
        return () => clearTimeout(timer);
    }, [status, startingChecks, check]);

    const badAllow = rejected(form.allowText, dns.normalizeDnsRule);
    const badDeny = rejected(form.denyText, dns.normalizeDnsRule);
    const badUpstreams =
        form.upstream === "custom" ? rejected(form.upstreamText, dns.normalizeUpstream) : [];
    const hours = Number(form.refreshHours);
    const hoursValid = Number.isInteger(hours) && hours >= 1 && hours <= 168;
    const customEmpty = form.upstream === "custom" && lines(form.upstreamText).length === 0;
    const days = Number(form.logDays);
    const daysValid = Number.isInteger(days) && days >= 1 && days <= dns.DNS_LIMITS.logDays;
    const namesFromValid = dns.dnsSettingsSchema.shape.namesFrom.safeParse(form.namesFrom).success;
    const recordNames = new Set(form.records.map((record) => record.name));
    const aliasClash = form.aliases
        .filter((alias) => recordNames.has(alias.name))
        .map((alias) => alias.name);

    const draft: dns.DnsSettings = useMemo(
        () => ({
            sources: form.sources,
            customLists: form.customLists,
            allow: lines(form.allowText).map((line) => dns.normalizeDnsRule(line) ?? line),
            deny: lines(form.denyText).map((line) => dns.normalizeDnsRule(line) ?? line),
            upstream: form.upstream,
            customUpstreams: form.upstream === "custom" ? lines(form.upstreamText) : [],
            records: form.records,
            refreshHours: Number(form.refreshHours),
            aliases: form.aliases,
            clientGroups: form.clientGroups,
            logDays: Number(form.logDays),
            devices: form.devices,
            forwards: form.forwards,
            safeSearch: form.safeSearch,
            youtube: form.youtube,
            // In the order `readDnsSettings` returns, which is what `dirty`
            // compares against.
            schedules: form.schedules,
            // The zone is only worth storing with something written in it.
            timeZone: form.schedules.length > 0 ? form.timeZone : saved.timeZone,
            services: form.services,
            // Written by the save path; carried so an unchanged form compares equal.
            serviceDomains: saved.serviceDomains,
            namesFrom: form.namesFrom.trim(),
            engine: {
                ...form.engine,
                cacheMinMinutes: Number(form.cacheMinText),
                cacheMaxMinutes: Number(form.cacheMaxText)
            }
        }),
        [form, saved.serviceDomains, saved.timeZone]
    );
    const dirty =
        JSON.stringify(draft) !==
        JSON.stringify({
            ...saved,
            customUpstreams: saved.upstream === "custom" ? saved.customUpstreams : []
        });
    const engineCheck = dns.dnsEngineSchema.safeParse(draft.engine);
    const engineIssue = engineCheck.success
        ? null
        : engineCheck.error.issues[0]?.message === "cacheRange"
          ? "cacheRange"
          : "cacheMinutes";
    const tooMany =
        draft.allow.length > dns.DNS_LIMITS.rules || draft.deny.length > dns.DNS_LIMITS.rules;
    const valid =
        badAllow.length === 0 &&
        badDeny.length === 0 &&
        badUpstreams.length === 0 &&
        hoursValid &&
        daysValid &&
        namesFromValid &&
        aliasClash.length === 0 &&
        !customEmpty &&
        engineIssue === null &&
        !tooMany;

    const engineExists = status ? ENGINE_STATES.includes(status.state) : false;

    const save = useCallback(() => {
        setNotice(null);
        startSaving(async () => {
            const result = await saveDnsSettingsAction(draft);
            if (result.error) {
                setNotice({ tone: "error", text: result.error });
                if (engineExists) recheck();
                return;
            }
            setSaved(draft);
            setNotice({ tone: "ok", text: t("settings.saved") });
            if (engineExists) recheck();
        });
    }, [draft, engineExists, recheck, t]);

    const switchTo = useCallback(
        (on: boolean) => {
            setNotice(null);
            startSwitching(async () => {
                const result = on
                    ? await turnOnDnsBlockerAction()
                    : await turnOffDnsBlockerAction();
                if (result.error) setNotice({ tone: "error", text: result.error });
                recheck();
            });
        },
        [recheck]
    );

    const value: DnsBlockerContextValue = {
        status,
        statusError,
        checking,
        switching,
        saving,
        stalled,
        engineExists,
        saved,
        form,
        setField,
        loadForm,
        draft,
        dirty,
        valid,
        checks: {
            badAllow,
            badDeny,
            badUpstreams,
            hoursValid,
            daysValid,
            namesFromValid,
            customEmpty,
            tooMany,
            aliasClash,
            engineIssue
        },
        notice,
        save,
        switchTo,
        recheck,
        adoptRules
    };
    return <Context.Provider value={value}>{children}</Context.Provider>;
}
