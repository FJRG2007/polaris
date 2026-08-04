"use client";

/**
 * Who the require-login control admits and who it refuses, on the scope being edited.
 *
 * Named nobody is the state the switch has always been in on its own, so an empty
 * admitted list says "anyone with an account" rather than showing an empty box that
 * reads like nobody gets in. Narrowing is additive from there: pick a role, a group or
 * a person, and the list becomes an allowlist. Refusing is separate and wins, so
 * "everyone in Engineering except this contractor" is one rule rather than a list
 * rewritten by hand every time the team changes.
 *
 * Roles and groups are offered above people on purpose. A rule written about a person
 * is right until somebody joins or leaves; a rule written about the group they are in
 * keeps being right, and that is the one an operator should fall into writing.
 *
 * Each entry can carry a window - access that starts later, lapses, or both. It is
 * evaluated at the edge on every request, so an expiry takes effect when it says it
 * does rather than whenever the visitor's session happens to end.
 */

import Link from "next/link";
import { useEffect, useState } from "react";
import { Input, Select, Skeleton } from "@polaris/ui";
import { useDisplayFormat } from "@/components/display-format";
import { listWafPrincipalsAction, type WafPrincipalOption } from "./actions";
import { wafPrincipalGrantSchema, type WafPrincipalGrant } from "@polaris/core";
import { ArrowUpRight, CalendarClock, Shield, TriangleAlert, User, UserMinus, Users, X } from "lucide-react";

/**
 * The directory, shared across mounts for a short while.
 *
 * Toggling the switch off and on remounts this, and so does moving between scopes -
 * neither of which changes who works here. One in-flight promise is reused rather than
 * refetched, and the answer is kept briefly so an operator narrowing several scopes in
 * a row pays for the read once.
 */
const CACHE_TTL_MS = 60_000;
let cached: { at: number; promise: Promise<{ principals?: WafPrincipalOption[]; error?: string }> } | null = null;

function loadPrincipals(): Promise<{ principals?: WafPrincipalOption[]; error?: string }> {
    const now = Date.now();
    if (cached && now - cached.at < CACHE_TTL_MS) return cached.promise;
    const promise = listWafPrincipalsAction().then((result) => {
        // A failed read must not be remembered, or a transient error would be the
        // answer for the next minute.
        if (result.error) cached = null;
        return result;
    });
    cached = { at: now, promise };
    return promise;
}

const ICONS: Record<string, React.ReactNode> = {
    role: <Shield className="size-3 shrink-0" aria-hidden="true" />,
    group: <Users className="size-3 shrink-0" aria-hidden="true" />,
    user: <User className="size-3 shrink-0" aria-hidden="true" />
};

/** Unix seconds from what a datetime-local input holds, in the operator's own zone. */
function toSeconds(value: string): number | undefined {
    if (!value) return undefined;
    const ms = new Date(value).getTime();
    return Number.isFinite(ms) ? Math.floor(ms / 1000) : undefined;
}

/** The reverse, since a datetime-local input takes local wall-clock and nothing else. */
function toInputValue(seconds: number | undefined): string {
    if (seconds === undefined) return "";
    const date = new Date(seconds * 1000);
    const pad = (value: number): string => String(value).padStart(2, "0");
    return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}T${pad(date.getHours())}:${pad(date.getMinutes())}`;
}

/** The patch the editor saves. Either list alone, so a change to one never rewrites
 *  the other with a stale copy. */
export interface LoginPrincipalsPatch {
    loginAllowPrincipals?: WafPrincipalGrant[];
    loginDenyPrincipals?: WafPrincipalGrant[];
}

export function LoginPrincipals({
    admitted,
    refused,
    disabled,
    onChange
}: {
    admitted: WafPrincipalGrant[];
    refused: WafPrincipalGrant[];
    disabled?: boolean;
    onChange: (patch: LoginPrincipalsPatch) => void;
}) {
    const [options, setOptions] = useState<WafPrincipalOption[] | null>(null);
    const [error, setError] = useState<string | null>(null);

    useEffect(() => {
        let active = true;
        void loadPrincipals().then((result) => {
            if (!active) return;
            setOptions(result.principals ?? []);
            setError(result.error ?? null);
        });
        return () => {
            active = false;
        };
    }, []);

    return (
        <div className="flex flex-col gap-4">
            <GrantList
                title="Who gets in"
                empty="Anyone with a Polaris account gets in. Name a role, a group or a person to narrow it to them."
                filled="Only these get in. A narrower scope can shorten this list, never lengthen it."
                addLabel="Add someone this login admits"
                grants={admitted}
                // Naming somebody in both lists is an operator contradicting themselves,
                // and the save would fail on it. Not offered rather than explained.
                taken={refused}
                options={options}
                disabled={disabled}
                onChange={(loginAllowPrincipals) => onChange({ loginAllowPrincipals })}
            />

            <GrantList
                title="Who never gets in"
                empty="Nobody is refused outright."
                filled="Refused even when something above admits them, and a broader scope's refusal still applies here."
                addLabel="Add someone this login refuses"
                grants={refused}
                taken={admitted}
                options={options}
                disabled={disabled}
                tone="danger"
                onChange={(loginDenyPrincipals) => onChange({ loginDenyPrincipals })}
            />

            {error ? <p className="text-xs text-danger">{error}</p> : null}

            <Link
                href="/admin/groups"
                className="flex w-fit items-center gap-1.5 text-xs text-primary underline-offset-2 hover:underline"
            >
                Manage roles and groups
                <ArrowUpRight className="size-3" aria-hidden="true" />
            </Link>
        </div>
    );
}

/** One list of named principals with the window each is granted in. */
function GrantList({
    title,
    empty,
    filled,
    addLabel,
    grants,
    taken,
    options,
    disabled,
    tone,
    onChange
}: {
    title: string;
    empty: string;
    filled: string;
    addLabel: string;
    grants: WafPrincipalGrant[];
    /** Named by the other list, so this one cannot offer them too. */
    taken: WafPrincipalGrant[];
    options: WafPrincipalOption[] | null;
    disabled?: boolean;
    tone?: "danger";
    onChange: (next: WafPrincipalGrant[]) => void;
}) {
    // Which entry has its window open. One at a time: the two inputs are wide, and an
    // operator schedules one person at a time anyway.
    const [scheduling, setScheduling] = useState<string | null>(null);
    const known = new Map((options ?? []).map((option) => [option.ref, option]));
    const spoken = new Set([...grants, ...taken].map((grant) => grant.ref));
    const remaining = (options ?? []).filter((option) => !spoken.has(option.ref));

    return (
        <div className="flex flex-col gap-2">
            <p className="text-xs font-medium text-foreground">{title}</p>
            <p className="text-xs text-muted-foreground">{grants.length === 0 ? empty : filled}</p>

            {grants.length > 0 ? (
                <ul className="flex flex-col gap-1">
                    {grants.map((grant) => (
                        <GrantRow
                            key={grant.ref}
                            grant={grant}
                            // Whoever this was has been deleted since the rule was
                            // written. Shown as it is stored rather than hidden: it is
                            // still being enforced, and it is the only thing that can be
                            // acted on.
                            option={known.get(grant.ref)}
                            resolved={options !== null}
                            disabled={disabled}
                            tone={tone}
                            open={scheduling === grant.ref}
                            onToggleSchedule={() => setScheduling(scheduling === grant.ref ? null : grant.ref)}
                            onChange={(next) =>
                                onChange(grants.map((entry) => (entry.ref === grant.ref ? next : entry)))
                            }
                            onRemove={() => {
                                setScheduling(null);
                                onChange(grants.filter((entry) => entry.ref !== grant.ref));
                            }}
                        />
                    ))}
                </ul>
            ) : null}

            {options === null ? (
                // Sized to the select that lands here, so nothing moves when it does.
                <div aria-busy="true">
                    <span className="sr-only">Loading who there is to choose from</span>
                    <Skeleton className="h-9 w-full max-w-xs rounded-md" />
                </div>
            ) : (
                <Select
                    className="max-w-xs"
                    value=""
                    aria-label={addLabel}
                    disabled={disabled || remaining.length === 0}
                    placeholder={remaining.length === 0 ? "Everyone is already named" : "Add a role, group or person..."}
                    onValueChange={(ref) => {
                        if (ref) onChange([...grants, { ref }]);
                    }}
                    options={remaining.map((option) => ({
                        value: option.ref,
                        icon: ICONS[option.type],
                        // Qualified in every case, so a role and a group that share a
                        // name are still two different entries to read.
                        label: `${option.label} (${option.sublabel ?? option.type})`
                    }))}
                />
            )}
        </div>
    );
}

/** One named principal, its window, and the controls to change either. */
function GrantRow({
    grant,
    option,
    resolved,
    disabled,
    tone,
    open,
    onToggleSchedule,
    onChange,
    onRemove
}: {
    grant: WafPrincipalGrant;
    option?: WafPrincipalOption;
    resolved: boolean;
    disabled?: boolean;
    tone?: "danger";
    open: boolean;
    onToggleSchedule: () => void;
    onChange: (next: WafPrincipalGrant) => void;
    onRemove: () => void;
}) {
    const format = useDisplayFormat();
    const missing = resolved && !option;
    const label = option?.label ?? grant.ref;
    const window = describeWindow(grant, format.dateTime);

    return (
        <li className="flex flex-col gap-1 rounded-md bg-background/60 px-2 py-1.5">
            <div className="flex items-center gap-2">
                <span
                    className={`inline-flex min-w-0 items-center gap-1.5 text-xs ${
                        missing ? "text-warning" : tone === "danger" ? "text-danger" : "text-foreground"
                    }`}
                    title={option?.sublabel ?? grant.ref}
                >
                    {missing ? (
                        <TriangleAlert className="size-3 shrink-0" aria-hidden="true" />
                    ) : tone === "danger" ? (
                        <UserMinus className="size-3 shrink-0" aria-hidden="true" />
                    ) : (
                        ICONS[grant.ref.slice(0, grant.ref.indexOf(":"))]
                    )}
                    <span className="truncate [overflow-wrap:anywhere]">
                        {label}
                        {missing ? " (no longer exists)" : ""}
                    </span>
                </span>

                {window ? (
                    <span className={`truncate text-xs ${window.spent ? "text-muted-foreground" : "text-foreground"}`}>
                        {window.text}
                    </span>
                ) : null}

                <span className="ml-auto flex shrink-0 items-center gap-1">
                    <button
                        type="button"
                        disabled={disabled}
                        aria-label={`Schedule ${label}`}
                        aria-expanded={open}
                        title="Set a start or an expiry"
                        onClick={onToggleSchedule}
                        className={`transition-colors hover:text-foreground disabled:opacity-50 ${
                            open || window ? "text-foreground" : "text-muted-foreground"
                        }`}
                    >
                        <CalendarClock className="size-3.5 shrink-0" aria-hidden="true" />
                    </button>
                    <button
                        type="button"
                        disabled={disabled}
                        aria-label={`Remove ${label}`}
                        title="Remove"
                        onClick={onRemove}
                        className="text-muted-foreground transition-colors hover:text-foreground disabled:opacity-50"
                    >
                        <X className="size-3.5 shrink-0" aria-hidden="true" />
                    </button>
                </span>
            </div>

            {open ? <GrantWindow grant={grant} disabled={disabled} onChange={onChange} /> : null}
        </li>
    );
}

/**
 * The two bounds of one grant.
 *
 * Held locally and saved on blur rather than on every keystroke: a datetime input emits
 * a value while it is still being typed, and each one of those would otherwise be a save
 * and a republished edge config.
 */
function GrantWindow({
    grant,
    disabled,
    onChange
}: {
    grant: WafPrincipalGrant;
    disabled?: boolean;
    onChange: (next: WafPrincipalGrant) => void;
}) {
    const [from, setFrom] = useState(toInputValue(grant.from));
    const [until, setUntil] = useState(toInputValue(grant.until));

    const draft: WafPrincipalGrant = { ref: grant.ref, from: toSeconds(from), until: toSeconds(until) };
    // The same schema the server validates against, so the message an operator reads
    // here is the one that would have come back.
    const parsed = wafPrincipalGrantSchema.safeParse(draft);
    const problem = parsed.success ? null : (parsed.error.issues[0]?.message ?? "Not a valid window");

    const commit = (): void => {
        if (!parsed.success) return;
        if (draft.from === grant.from && draft.until === grant.until) return;
        onChange(parsed.data);
    };

    return (
        <div className="flex flex-wrap items-end gap-2 pl-5">
            <label className="flex flex-col gap-1 text-xs text-muted-foreground">
                Starts
                <Input
                    type="datetime-local"
                    className="h-8 w-auto text-xs"
                    value={from}
                    disabled={disabled}
                    onChange={(event) => setFrom(event.target.value)}
                    onBlur={commit}
                />
            </label>
            <label className="flex flex-col gap-1 text-xs text-muted-foreground">
                Expires
                <Input
                    type="datetime-local"
                    className="h-8 w-auto text-xs"
                    value={until}
                    disabled={disabled}
                    onChange={(event) => setUntil(event.target.value)}
                    onBlur={commit}
                />
            </label>
            {from || until ? (
                <button
                    type="button"
                    disabled={disabled}
                    onClick={() => {
                        setFrom("");
                        setUntil("");
                        onChange({ ref: grant.ref });
                    }}
                    className="h-8 text-xs text-muted-foreground underline-offset-2 hover:text-foreground hover:underline disabled:opacity-50"
                >
                    Always
                </button>
            ) : null}
            {problem ? <p className="w-full text-xs text-danger">{problem}</p> : null}
        </div>
    );
}

/** The window in one phrase, plus whether it has already passed - an entry that no
 *  longer applies is still stored, and reading it as if it did would be wrong. */
function describeWindow(
    grant: WafPrincipalGrant,
    dateTime: (value: Date) => string
): { text: string; spent: boolean } | null {
    const now = Date.now() / 1000;
    if (grant.until !== undefined && now >= grant.until) {
        return { text: `expired ${dateTime(new Date(grant.until * 1000))}`, spent: true };
    }
    if (grant.from !== undefined && now < grant.from) {
        return { text: `from ${dateTime(new Date(grant.from * 1000))}`, spent: true };
    }
    if (grant.until !== undefined) return { text: `until ${dateTime(new Date(grant.until * 1000))}`, spent: false };
    return null;
}
