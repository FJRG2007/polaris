"use client";

/**
 * Firewall editor for one scope: Polaris itself, every deployed service, a project,
 * an environment, or a single service.
 *
 * Two layers, in the order the edge applies them. The IP lists answer "which
 * addresses" and are enforced natively by Traefik where they can be. The custom rules
 * answer everything else - a path, a method, a hostname, a user agent - in order,
 * first match wins, so a narrow `allow` above a broad `block` is an exception rather
 * than a contradiction. Both are materialized into the edge config, which is what
 * keeps them enforcing while the control plane is down.
 *
 * Saving is explicit rather than applied per keystroke, because a half-entered
 * firewall rule must never reach the edge: an allowlist missing your own address
 * would lock everyone out the moment it applied.
 */

import { useEffect, useState, useTransition } from "react";
import { Button, Input, Select, Switch } from "@polaris/ui";
import { getWafRuleAction, setWafRuleAction } from "./actions";
import { Ban, GripVertical, Loader2, Plus, ShieldCheck, Trash2, X } from "lucide-react";
import {
    isCidr,
    isIpAddress,
    WAF_RULES_MAX,
    type WafCondition,
    type WafCustomRule,
    type WafRuleField,
    type WafRuleOperator,
    type WafScopeType
} from "@polaris/core";

/** True if a trimmed entry is a valid single IP or CIDR range. */
function validEntry(value: string): boolean {
    const trimmed = value.trim();
    return isCidr(trimmed) || isIpAddress(trimmed);
}

/** An editable list of chips with real-time validation. Shared by the IP lists and by
 *  a condition's values, which differ only in what counts as valid. */
function ChipList({
    entries,
    onChange,
    placeholder,
    accent = "neutral",
    validate,
    invalidMessage
}: {
    entries: string[];
    onChange: (next: string[]) => void;
    placeholder: string;
    accent?: "neutral" | "deny";
    /** What counts as an entry. Defaults to anything non-empty. */
    validate?: (value: string) => boolean;
    invalidMessage?: string;
}) {
    const [draft, setDraft] = useState("");
    const trimmed = draft.trim();
    const ok = trimmed !== "" && (validate ? validate(trimmed) : true);
    const duplicate = entries.includes(trimmed);
    const invalid = trimmed !== "" && !ok;

    function add() {
        if (!ok || duplicate) return;
        onChange([...entries, trimmed]);
        setDraft("");
    }

    return (
        <div className="flex flex-col gap-2">
            <div className="flex gap-2">
                <Input
                    value={draft}
                    placeholder={placeholder}
                    onChange={(event) => setDraft(event.target.value)}
                    onKeyDown={(event) => {
                        if (event.key === "Enter") {
                            event.preventDefault();
                            add();
                        }
                    }}
                    aria-invalid={invalid}
                />
                <Button type="button" variant="secondary" onClick={add} disabled={!ok || duplicate}>
                    <Plus className="size-4" />
                    Add
                </Button>
            </div>
            {invalid && invalidMessage ? <p className="text-xs text-danger">{invalidMessage}</p> : null}
            {duplicate && trimmed !== "" ? <p className="text-xs text-muted-foreground">Already in the list.</p> : null}
            {entries.length > 0 ? (
                <div className="flex flex-wrap gap-1.5">
                    {entries.map((entry) => (
                        <span
                            key={entry}
                            className={`inline-flex items-center gap-1 rounded-md px-2 py-1 text-xs ${
                                accent === "deny" ? "bg-danger/10 text-danger" : "bg-muted text-foreground"
                            }`}
                        >
                            {entry}
                            <button
                                type="button"
                                aria-label={`Remove ${entry}`}
                                onClick={() => onChange(entries.filter((value) => value !== entry))}
                                className="text-muted-foreground transition-colors hover:text-foreground"
                            >
                                <X className="size-3" />
                            </button>
                        </span>
                    ))}
                </div>
            ) : null}
        </div>
    );
}

/** What each field is called where an operator reads it, rather than where it is
 *  stored. */
const FIELD_LABELS: Record<WafRuleField, string> = {
    ip: "Client address",
    host: "Hostname",
    path: "URL path",
    method: "Request method",
    user_agent: "User agent",
    query: "Query string"
};

const OPERATOR_LABELS: Record<WafRuleOperator, string> = {
    equals: "is",
    not_equals: "is not",
    contains: "contains",
    not_contains: "does not contain",
    starts_with: "starts with",
    ends_with: "ends with"
};

/** An address is matched by containment, not by string, so the operators that read a
 *  value as text have nothing to do there. */
const IP_OPERATORS: WafRuleOperator[] = ["equals", "not_equals"];

const FIELD_OPTIONS = (Object.keys(FIELD_LABELS) as WafRuleField[]).map((field) => ({
    value: field,
    label: FIELD_LABELS[field]
}));

function operatorOptions(field: WafRuleField) {
    const operators =
        field === "ip" ? IP_OPERATORS : (Object.keys(OPERATOR_LABELS) as WafRuleOperator[]);
    return operators.map((operator) => ({ value: operator, label: OPERATOR_LABELS[operator] }));
}

/** An example of the value that field takes, so the field says what it wants. */
const VALUE_PLACEHOLDER: Record<WafRuleField, string> = {
    ip: "203.0.113.4 or 203.0.113.0/24",
    host: "admin.example.com",
    path: "/wp-admin",
    method: "POST",
    user_agent: "curl",
    query: "debug=1"
};

const ACTION_OPTIONS = [
    { value: "block", label: "Block" },
    { value: "allow", label: "Allow" }
];

/** A rule with nothing in it yet, offered when one is added. */
function emptyRule(index: number): WafCustomRule {
    return {
        name: `Rule ${index + 1}`,
        enabled: true,
        action: "block",
        conditions: [{ field: "path", operator: "starts_with", values: [] }]
    };
}

function ConditionRow({
    condition,
    onChange,
    onRemove,
    removable
}: {
    condition: WafCondition;
    onChange: (next: WafCondition) => void;
    onRemove: () => void;
    removable: boolean;
}) {
    return (
        <div className="flex flex-col gap-2 rounded-md border border-border/60 p-2">
            <div className="flex flex-wrap items-center gap-2">
                <Select
                    aria-label="Field"
                    className="h-8 w-40"
                    value={condition.field}
                    options={FIELD_OPTIONS}
                    onValueChange={(value) => {
                        const field = value as WafRuleField;
                        // The address field takes different operators, so one that no
                        // longer applies is replaced rather than left reading wrong.
                        const operator =
                            field === "ip" && !IP_OPERATORS.includes(condition.operator)
                                ? "equals"
                                : condition.operator;
                        onChange({ ...condition, field, operator });
                    }}
                />
                <Select
                    aria-label="Operator"
                    className="h-8 w-44"
                    value={condition.operator}
                    options={operatorOptions(condition.field)}
                    onValueChange={(value) => onChange({ ...condition, operator: value as WafRuleOperator })}
                />
                {removable ? (
                    <button
                        type="button"
                        onClick={onRemove}
                        aria-label="Remove this condition"
                        title="Remove this condition"
                        className="ml-auto rounded p-1.5 text-muted-foreground transition-colors hover:bg-muted hover:text-danger"
                    >
                        <X className="size-3.5" />
                    </button>
                ) : null}
            </div>
            <ChipList
                entries={condition.values}
                onChange={(values) => onChange({ ...condition, values })}
                placeholder={VALUE_PLACEHOLDER[condition.field]}
                validate={condition.field === "ip" ? validEntry : undefined}
                invalidMessage={condition.field === "ip" ? "Enter an IP address or a CIDR range." : undefined}
            />
            <p className="text-xs text-muted-foreground">Any one of these values satisfies the condition.</p>
        </div>
    );
}

function RuleCard({
    rule,
    index,
    total,
    onChange,
    onRemove,
    onMove
}: {
    rule: WafCustomRule;
    index: number;
    total: number;
    onChange: (next: WafCustomRule) => void;
    onRemove: () => void;
    onMove: (to: number) => void;
}) {
    return (
        <div className="flex flex-col gap-3 rounded-lg border border-border p-3">
            <div className="flex flex-wrap items-center gap-2">
                <GripVertical className="size-4 shrink-0 text-muted-foreground" />
                <Input
                    aria-label="Rule name"
                    className="h-8 min-w-40 flex-1"
                    value={rule.name}
                    onChange={(event) => onChange({ ...rule, name: event.target.value })}
                />
                <Select
                    aria-label="Action"
                    className="h-8 w-28"
                    value={rule.action}
                    options={ACTION_OPTIONS}
                    onValueChange={(value) => onChange({ ...rule, action: value as WafCustomRule["action"] })}
                />
                <Switch
                    checked={rule.enabled}
                    onChange={(enabled) => onChange({ ...rule, enabled })}
                    aria-label={`Enable ${rule.name}`}
                />
                <button
                    type="button"
                    onClick={() => onMove(index - 1)}
                    disabled={index === 0}
                    aria-label="Move up"
                    title="Move up"
                    className="rounded px-1.5 py-1 text-xs text-muted-foreground transition-colors hover:bg-muted hover:text-foreground disabled:opacity-30"
                >
                    Up
                </button>
                <button
                    type="button"
                    onClick={() => onMove(index + 1)}
                    disabled={index === total - 1}
                    aria-label="Move down"
                    title="Move down"
                    className="rounded px-1.5 py-1 text-xs text-muted-foreground transition-colors hover:bg-muted hover:text-foreground disabled:opacity-30"
                >
                    Down
                </button>
                <button
                    type="button"
                    onClick={onRemove}
                    aria-label={`Delete ${rule.name}`}
                    title="Delete this rule"
                    className="rounded p-1.5 text-muted-foreground transition-colors hover:bg-muted hover:text-danger"
                >
                    <Trash2 className="size-3.5" />
                </button>
            </div>

            <div className="flex flex-col gap-2">
                {rule.conditions.map((condition, conditionIndex) => (
                    <div key={conditionIndex} className="flex flex-col gap-2">
                        {conditionIndex > 0 ? (
                            <span className="text-xs font-medium text-muted-foreground">and</span>
                        ) : null}
                        <ConditionRow
                            condition={condition}
                            removable={rule.conditions.length > 1}
                            onChange={(next) =>
                                onChange({
                                    ...rule,
                                    conditions: rule.conditions.map((entry, i) => (i === conditionIndex ? next : entry))
                                })
                            }
                            onRemove={() =>
                                onChange({
                                    ...rule,
                                    conditions: rule.conditions.filter((_, i) => i !== conditionIndex)
                                })
                            }
                        />
                    </div>
                ))}
                <Button
                    type="button"
                    variant="ghost"
                    size="sm"
                    className="w-fit"
                    onClick={() =>
                        onChange({
                            ...rule,
                            conditions: [...rule.conditions, { field: "path", operator: "contains", values: [] }]
                        })
                    }
                >
                    <Plus className="size-3.5" /> Add condition
                </Button>
            </div>
        </div>
    );
}

/** A rule with no values anywhere would match every request, so it is not saveable. */
function incompleteRule(rules: readonly WafCustomRule[]): WafCustomRule | undefined {
    return rules.find(
        (rule) => rule.name.trim() === "" || rule.conditions.some((condition) => condition.values.length === 0)
    );
}

export function WafEditor({
    scopeType,
    scopeId,
    description,
    /** Offer the require-login control. Polaris has a login of its own, so on that
     *  scope the option is not a second factor, it is a redirect loop. */
    offerLogin = true,
    /** An address to suggest adding to the allowlist - the one the page is being read
     *  over, so an operator narrowing access does not narrow themselves out of it. */
    callerIp
}: {
    scopeType: WafScopeType;
    scopeId: string;
    description?: string;
    offerLogin?: boolean;
    callerIp?: string | null;
}) {
    const [loaded, setLoaded] = useState(false);
    const [allow, setAllow] = useState<string[]>([]);
    const [deny, setDeny] = useState<string[]>([]);
    const [requireLogin, setRequireLogin] = useState(false);
    const [rules, setRules] = useState<WafCustomRule[]>([]);
    const [saved, setSaved] = useState<string | null>(null);
    const [error, setError] = useState<string | null>(null);
    const [note, setNote] = useState<string | null>(null);
    const [pending, start] = useTransition();

    useEffect(() => {
        let active = true;
        setLoaded(false);
        setError(null);
        setNote(null);
        void getWafRuleAction({ scopeType, scopeId }).then((result) => {
            if (!active) return;
            const rule = result.rule ?? { ipAllowlist: [], ipDenylist: [], requireLogin: false, rules: [] };
            setAllow(rule.ipAllowlist);
            setDeny(rule.ipDenylist);
            setRequireLogin(rule.requireLogin);
            setRules(rule.rules);
            setSaved(snapshot(rule.ipAllowlist, rule.ipDenylist, rule.requireLogin, rule.rules));
            if (result.error) setError(result.error);
            setLoaded(true);
        });
        return () => {
            active = false;
        };
    }, [scopeType, scopeId]);

    const overlap = allow.find((entry) => deny.includes(entry));
    const incomplete = incompleteRule(rules);
    const dirty = saved !== null && saved !== snapshot(allow, deny, requireLogin, rules);
    // An allowlist that does not include the address this page is being read over is
    // the one way to lose access to the thing being configured.
    const wouldLockOut =
        allow.length > 0 && Boolean(callerIp) && !allow.some((entry) => entry === callerIp);

    function save() {
        setError(null);
        setNote(null);
        start(async () => {
            const result = await setWafRuleAction({
                scopeType,
                scopeId,
                ipAllowlist: allow,
                ipDenylist: deny,
                requireLogin,
                rules
            });
            if (result.error) {
                setError(result.error);
                return;
            }
            setSaved(snapshot(allow, deny, requireLogin, rules));
            setNote("Firewall rules saved.");
        });
    }

    if (!loaded) {
        return (
            <div className="flex items-center gap-2 py-6 text-sm text-muted-foreground">
                <Loader2 className="size-4 animate-spin" />
                Loading firewall rules...
            </div>
        );
    }

    return (
        <div className="flex flex-col gap-5 py-2">
            {description ? <p className="text-sm text-muted-foreground">{description}</p> : null}

            <section className="flex flex-col gap-2">
                <div className="flex items-center gap-2 text-sm font-medium">
                    <ShieldCheck className="size-4 text-muted-foreground" />
                    IP allowlist
                </div>
                <p className="text-xs text-muted-foreground">
                    If set, only these addresses get through. Enforced natively at the edge.
                </p>
                <ChipList
                    entries={allow}
                    onChange={setAllow}
                    placeholder="e.g. 203.0.113.0/24 or 10.0.0.5"
                    validate={validEntry}
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
            </section>

            <section className="flex flex-col gap-2">
                <div className="flex items-center gap-2 text-sm font-medium">
                    <Ban className="size-4 text-muted-foreground" />
                    IP denylist
                </div>
                <p className="text-xs text-muted-foreground">
                    These addresses are always blocked, even if they match the allowlist.
                </p>
                <ChipList
                    entries={deny}
                    onChange={setDeny}
                    accent="deny"
                    placeholder="e.g. 198.51.100.7 or 192.0.2.0/24"
                    validate={validEntry}
                    invalidMessage="Enter a valid IP address or CIDR range."
                />
            </section>

            <section className="flex flex-col gap-3">
                <div className="flex flex-wrap items-center justify-between gap-2">
                    <div className="text-sm font-medium">Custom rules</div>
                    <Button
                        type="button"
                        variant="secondary"
                        size="sm"
                        disabled={rules.length >= WAF_RULES_MAX}
                        onClick={() => setRules([...rules, emptyRule(rules.length)])}
                    >
                        <Plus className="size-4" /> Add rule
                    </Button>
                </div>
                <p className="text-xs text-muted-foreground">
                    Tried in order; the first rule that matches decides. Put an allow above a block to carve out an
                    exception.
                </p>
                {rules.length === 0 ? (
                    <p className="rounded-md border border-dashed border-border px-3 py-4 text-center text-xs text-muted-foreground">
                        No rules. The lists above still apply.
                    </p>
                ) : (
                    rules.map((rule, index) => (
                        <RuleCard
                            key={index}
                            rule={rule}
                            index={index}
                            total={rules.length}
                            onChange={(next) => setRules(rules.map((entry, i) => (i === index ? next : entry)))}
                            onRemove={() => setRules(rules.filter((_, i) => i !== index))}
                            onMove={(to) => setRules(moved(rules, index, to))}
                        />
                    ))
                )}
            </section>

            {offerLogin ? (
                <section className="flex items-start justify-between gap-4">
                    <div>
                        <div className="text-sm font-medium">Require a Polaris login</div>
                        <p className="text-xs text-muted-foreground">
                            Visitors must sign in to Polaris to reach the service. Existing sessions keep working if
                            the control plane is down; new sign-ins need it reachable.
                        </p>
                    </div>
                    <Switch checked={requireLogin} onChange={setRequireLogin} aria-label="Require a Polaris login" />
                </section>
            ) : null}

            {overlap ? (
                <p className="text-xs text-danger">&quot;{overlap}&quot; is in both the allow and deny lists.</p>
            ) : null}
            {incomplete ? (
                <p className="text-xs text-danger">
                    &quot;{incomplete.name || "Unnamed rule"}&quot; needs a name and a value on every condition.
                </p>
            ) : null}
            {wouldLockOut ? (
                <p className="rounded-md border border-warning/30 bg-warning/5 px-3 py-2 text-xs text-warning">
                    This allowlist does not include the address you are reading this over ({callerIp}). Saving it will
                    shut you out of everything in this scope.
                </p>
            ) : null}
            {error ? <p className="text-sm text-danger">{error}</p> : null}
            {note && !dirty ? <p className="text-sm text-success">{note}</p> : null}

            <div className="flex flex-wrap items-center gap-3">
                <Button
                    type="button"
                    onClick={save}
                    disabled={!dirty || pending || Boolean(overlap) || Boolean(incomplete)}
                >
                    {pending ? <Loader2 className="size-4 animate-spin" /> : null}
                    Save firewall rules
                </Button>
                <p className="text-xs text-muted-foreground">
                    {scopeType === "polaris"
                        ? "Applies to the public domains Polaris answers on. The local network name is served separately and stays reachable."
                        : "Remote-server apps apply on their next deploy; the local edge applies instantly."}
                </p>
            </div>
        </div>
    );
}

/** The whole editable state as one comparable string. A rule set is nested and
 *  reorderable, so field-by-field comparison would either miss a change or call an
 *  unchanged form dirty. */
function snapshot(
    allow: readonly string[],
    deny: readonly string[],
    requireLogin: boolean,
    rules: readonly WafCustomRule[]
): string {
    return JSON.stringify({ allow, deny, requireLogin, rules });
}

/** The list with one entry moved, or unchanged when the target is off the ends. */
function moved<T>(list: readonly T[], from: number, to: number): T[] {
    if (to < 0 || to >= list.length) return [...list];
    const next = [...list];
    const [entry] = next.splice(from, 1);
    if (entry !== undefined) next.splice(to, 0, entry);
    return next;
}
