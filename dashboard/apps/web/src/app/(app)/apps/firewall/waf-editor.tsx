"use client";

/**
 * The firewall for one scope: Polaris itself, every deployed service, a server, a
 * project, an environment, or a single service.
 *
 * Four sections, flat and side by side rather than boxes inside a box - the rules,
 * the address lists, the managed packs, and the controls that are neither. They are
 * ordered by how often an operator comes here for them, which puts the rules first.
 *
 * Two different saving models, and the split is deliberate rather than an
 * inconsistency:
 *
 *  - A switch applies immediately and optimistically. Turning a pack on is a complete
 *    thought; making somebody then find a Save button for it is a step the interface
 *    can take for them, and the change is one click to undo.
 *  - The address lists have an explicit Save. An allowlist is the one control here
 *    that can lock its own author out, and it is only ever right once it is finished -
 *    applying "10.0.0.0/8" the instant it is typed, before the second entry, would
 *    shut out everyone the second entry was for.
 *
 * Both write through the same server action, which takes the whole scope. So an
 * immediate change is composed against the LAST SAVED state and never against what is
 * on screen: otherwise toggling a pack would quietly ship the half-typed allowlist
 * sitting in the section below it.
 */

import { RuleList } from "./rule-list";
import { ChipList, validAddress } from "./chip-list";
import { Button, Skeleton, Switch } from "@polaris/ui";
import { useCallback, useEffect, useState } from "react";
import { emptyRule, RuleEditor, type RulePosition } from "./rule-editor";
import { getWafRuleAction, setWafRuleAction, type WafScopeRule } from "./actions";
import { Ban, Loader2, Mail, ScanFace, ShieldCheck, TriangleAlert } from "lucide-react";
import { WAF_PRESETS, WAF_RULES_MAX, type WafCustomRule, type WafPreset, type WafScopeType } from "@polaris/core";

/** The scope as nothing has ever been written to it. Injection protection and
 *  obfuscation are on here for the same reason they are on in the schema: that is the
 *  state of an unconfigured Polaris. */
const BLANK: WafScopeRule = {
    ipAllowlist: [],
    ipDenylist: [],
    requireLogin: false,
    browserIntegrity: false,
    injectionProtection: true,
    emailObfuscation: true,
    presets: [],
    rules: []
};

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
    // What the server holds. Every immediate change is composed against this, so a
    // half-typed address list can never ride along with a switch.
    const [saved, setSaved] = useState<WafScopeRule | null>(null);
    const [allow, setAllow] = useState<string[]>([]);
    const [deny, setDeny] = useState<string[]>([]);
    const [editing, setEditing] = useState<{ index: number | null; rule: WafCustomRule } | null>(null);
    const [error, setError] = useState<string | null>(null);
    const [busy, setBusy] = useState(false);

    useEffect(() => {
        let active = true;
        setSaved(null);
        setError(null);
        setEditing(null);
        void getWafRuleAction({ scopeType, scopeId }).then((result) => {
            if (!active) return;
            const rule = result.rule ?? BLANK;
            setSaved(rule);
            setAllow(rule.ipAllowlist);
            setDeny(rule.ipDenylist);
            if (result.error) setError(result.error);
        });
        return () => {
            active = false;
        };
    }, [scopeType, scopeId]);

    /**
     * Apply a change to what is on screen, then confirm it with the server, then put
     * the old value back if the server refused. The switch moves under the finger and
     * only a real failure moves it back.
     */
    const persist = useCallback(
        (patch: Partial<WafScopeRule>) => {
            setSaved((current) => {
                if (!current) return current;
                const previous = current;
                const next = { ...current, ...patch };
                setError(null);
                setBusy(true);
                void setWafRuleAction({ scopeType, scopeId, ...next })
                    .then((result) => {
                        if (result.error) {
                            setSaved(previous);
                            setAllow(previous.ipAllowlist);
                            setDeny(previous.ipDenylist);
                            setError(result.error);
                        }
                    })
                    .finally(() => setBusy(false));
                return next;
            });
        },
        [scopeType, scopeId]
    );

    if (!saved) return <LoadingShape />;

    if (editing) {
        return (
            <RuleEditor
                rule={editing.rule}
                index={editing.index}
                others={saved.rules
                    .map((rule, index) => ({ index, name: rule.name }))
                    .filter((entry) => entry.index !== editing.index)}
                onCancel={() => setEditing(null)}
                onSave={(rule, position) => {
                    persist({ rules: placed(saved.rules, rule, editing.index, position) });
                    setEditing(null);
                }}
            />
        );
    }

    const overlap = allow.find((entry) => deny.includes(entry));
    const listsDirty =
        JSON.stringify([allow, deny]) !== JSON.stringify([saved.ipAllowlist, saved.ipDenylist]);
    // An allowlist that does not include the address this page is being read over is
    // the one way to lose access to the thing being configured.
    const wouldLockOut = allow.length > 0 && Boolean(callerIp) && !allow.includes(callerIp!);

    return (
        <div className="flex flex-col gap-4">
            {description ? <p className="text-sm text-muted-foreground">{description}</p> : null}

            <RuleList
                rules={saved.rules}
                max={WAF_RULES_MAX}
                canEdit={!busy}
                onCreate={() => setEditing({ index: null, rule: emptyRule(saved.rules.length) })}
                onEdit={(index) => {
                    const rule = saved.rules[index];
                    if (rule) setEditing({ index, rule });
                }}
                onChange={(rules) => persist({ rules })}
            />

            <Section
                title="IP access rules"
                hint="Checked before any rule below. The allowlist is enforced by the edge itself; the denylist always wins over it."
            >
                <div className="grid gap-5 md:grid-cols-2">
                    <div className="flex flex-col gap-2">
                        <div className="flex items-center gap-2 text-sm font-medium">
                            <ShieldCheck className="size-4 shrink-0 text-muted-foreground" aria-hidden="true" />
                            Allowed
                        </div>
                        <p className="text-xs text-muted-foreground">
                            If any address is listed, only those get through.
                        </p>
                        <ChipList
                            entries={allow}
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
                            onChange={setDeny}
                            accent="deny"
                            placeholder="198.51.100.7"
                            validate={validAddress}
                            invalidMessage="Enter a valid IP address or CIDR range."
                        />
                    </div>
                </div>

                {overlap ? (
                    <p className="text-xs text-danger">&quot;{overlap}&quot; is in both lists.</p>
                ) : null}
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
                        disabled={!listsDirty || busy || Boolean(overlap)}
                        title={listsDirty ? undefined : "No changes to save"}
                        onClick={() => persist({ ipAllowlist: allow, ipDenylist: deny })}
                    >
                        Save address lists
                    </Button>
                    {listsDirty ? (
                        <button
                            type="button"
                            onClick={() => {
                                setAllow(saved.ipAllowlist);
                                setDeny(saved.ipDenylist);
                            }}
                            className="text-xs text-muted-foreground underline-offset-2 hover:text-foreground hover:underline"
                        >
                            Discard
                        </button>
                    ) : null}
                </div>
            </Section>

            <Section
                title="Managed rules"
                hint="Signatures and lists Polaris keeps up to date. A pack enabled on a broader scope also applies here; write an allow rule above it to carve out an exception."
            >
                <div className="-mx-4 -mb-4 flex flex-col divide-y divide-border border-t border-border">
                    <ToggleRow
                        title="Block SQL injection and cross-site scripting"
                        description="Checks the URL of every request against injection signatures and refuses the ones carrying a payload: quoted conditions, UNION SELECT, script tags, event handlers. Encoded payloads are decoded first. It reads the request line, so a payload in a POST body is not visible to it."
                        checked={saved.injectionProtection}
                        disabled={busy}
                        onChange={(on) => persist({ injectionProtection: on })}
                    />
                    {WAF_PRESETS.map((preset) => (
                        <PresetRow
                            key={preset.id}
                            preset={preset}
                            disabled={busy}
                            checked={saved.presets.includes(preset.id)}
                            onChange={(on) =>
                                persist({
                                    presets: on
                                        ? [...saved.presets, preset.id]
                                        : saved.presets.filter((id) => id !== preset.id)
                                })
                            }
                        />
                    ))}
                </div>
            </Section>

            <Section title="Scrape shield">
                <div className="-mx-4 -mb-4 flex flex-col divide-y divide-border border-t border-border">
                    <ToggleRow
                        icon={<Mail className="size-4 shrink-0 text-muted-foreground" aria-hidden="true" />}
                        title="Email address obfuscation"
                        description="Replaces email addresses in served HTML with an encoded token the page decodes in the browser, so the address is not in the source. Visitors see no change. It stops harvesters that read source without running JavaScript, which is most of them; one driving a real browser still reads it."
                        checked={saved.emailObfuscation}
                        disabled={busy}
                        onChange={(on) => persist({ emailObfuscation: on })}
                    />
                    <ToggleRow
                        icon={<ScanFace className="size-4 shrink-0 text-muted-foreground" aria-hidden="true" />}
                        title="Browser integrity check"
                        description="Refuses a request whose headers do not hold together as a browser's: no user agent at all, or one claiming to be a browser without the headers every browser sends. A client that is honestly not a browser still gets through, so an API on this scope keeps working."
                        checked={saved.browserIntegrity}
                        disabled={busy}
                        onChange={(on) => persist({ browserIntegrity: on })}
                    />
                    {offerLogin ? (
                        <ToggleRow
                            icon={<ShieldCheck className="size-4 shrink-0 text-muted-foreground" aria-hidden="true" />}
                            title="Require a Polaris login"
                            description="Visitors must sign in to Polaris to reach the service. Existing sessions keep working if the control plane is down; new sign-ins need it reachable."
                            checked={saved.requireLogin}
                            disabled={busy}
                            onChange={(on) => persist({ requireLogin: on })}
                        />
                    ) : null}
                </div>
            </Section>

            {error ? <p className="text-sm text-danger">{error}</p> : null}
            <p className="text-xs text-muted-foreground">
                {scopeType === "polaris"
                    ? "Applies to the public domains Polaris answers on. The local network name is served separately and stays reachable."
                    : "The local edge applies changes instantly; a service on a remote server picks them up on its next deploy."}
            </p>
        </div>
    );
}

/**
 * The rule list with `rule` written into it at `position`.
 *
 * Edits and creations go through the same function on purpose: an edit that also moves
 * the rule is a remove and an insert, and doing it as "update in place, then move"
 * shifts every index the position was expressed in terms of.
 */
function placed(
    rules: readonly WafCustomRule[],
    rule: WafCustomRule,
    /** Null when the rule is being created. */
    from: number | null,
    position: RulePosition
): WafCustomRule[] {
    if (from !== null && position.kind === "after" && position.index === from - 1) {
        // Staying exactly where it is, which is what the editor opens on. Written as
        // an update rather than a move so an edit that changed only the name does not
        // renumber the list.
        return rules.map((entry, index) => (index === from ? rule : entry));
    }
    const without = from === null ? [...rules] : rules.filter((_, index) => index !== from);
    if (position.kind === "first") return [rule, ...without];
    if (position.kind === "last") return [...without, rule];
    // "After rule N", where N indexes the ORIGINAL list, so it has to be resolved
    // against the list the rule was just taken out of.
    const anchor = rules[position.index];
    const at = anchor ? without.indexOf(anchor) : -1;
    return at < 0 ? [...without, rule] : [...without.slice(0, at + 1), rule, ...without.slice(at + 1)];
}

/** One flat section. A sibling surface, never nested inside another one. */
function Section({ title, hint, children }: { title: string; hint?: string; children: React.ReactNode }) {
    return (
        <section className="flex flex-col gap-3 rounded-lg border border-border bg-card px-4 py-4">
            <div className="flex flex-col gap-1">
                <h2 className="text-sm font-semibold">{title}</h2>
                {hint ? <p className="text-xs text-muted-foreground">{hint}</p> : null}
            </div>
            {children}
        </section>
    );
}

/** A titled switch with room to say what it costs. Shared by the packs and by the
 *  scrape-shield controls, which differ only in where their text comes from. */
function ToggleRow({
    icon,
    title,
    description,
    caution,
    checked,
    disabled,
    onChange
}: {
    icon?: React.ReactNode;
    title: string;
    description: string;
    caution?: string;
    checked: boolean;
    disabled?: boolean;
    onChange: (on: boolean) => void;
}) {
    return (
        <div className="flex items-start justify-between gap-4 px-4 py-3">
            <div className="flex min-w-0 gap-2">
                {icon}
                <div className="min-w-0">
                    <div className="text-sm">{title}</div>
                    <p className="mt-0.5 text-xs text-muted-foreground">{description}</p>
                    {caution ? (
                        <p className="mt-1 flex items-start gap-1.5 text-xs text-warning">
                            <TriangleAlert className="mt-0.5 size-3 shrink-0" aria-hidden="true" />
                            {caution}
                        </p>
                    ) : null}
                </div>
            </div>
            <Switch checked={checked} disabled={disabled} onChange={onChange} aria-label={title} />
        </div>
    );
}

function PresetRow({
    preset,
    checked,
    disabled,
    onChange
}: {
    preset: WafPreset;
    checked: boolean;
    disabled?: boolean;
    onChange: (on: boolean) => void;
}) {
    return (
        <ToggleRow
            title={preset.label}
            description={preset.description}
            caution={preset.caution}
            checked={checked}
            disabled={disabled}
            onChange={onChange}
        />
    );
}

/** The shape of the screen, drawn before its contents arrive. Sized to what lands so
 *  nothing jumps when it does. */
function LoadingShape() {
    return (
        <div className="flex flex-col gap-4" aria-busy="true">
            <span className="sr-only">
                <Loader2 className="size-4 animate-spin" aria-hidden="true" />
                Loading the firewall rules
            </span>
            <Skeleton className="h-56 w-full rounded-lg" />
            <Skeleton className="h-48 w-full rounded-lg" />
            <Skeleton className="h-72 w-full rounded-lg" />
        </div>
    );
}
