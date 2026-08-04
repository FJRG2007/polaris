"use client";

/**
 * The firewall for one scope: Polaris itself, every deployed service, a server, a
 * project, an environment, or a single service.
 *
 * Every protection here is a rule, so the screen is lists of rules and each row opens
 * into a page of its own. Three lists, ordered by how often an operator comes here for
 * them: the rules they wrote, the two that name who rather than what, and the ones
 * Polaris maintains. A managed rule used to be a switch with a paragraph beside it,
 * which cannot answer the question anybody actually arrives with - what does this
 * block? - so it now opens onto its own conditions.
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
 * on screen.
 */

import { RuleList } from "./rule-list";
import { Section } from "./page-parts";
import { Loader2, Mail } from "lucide-react";
import { Skeleton, Switch } from "@polaris/ui";
import { ManagedRulePage } from "./managed-rule-page";
import { PredefinedRuleList } from "./predefined-list";
import { useCallback, useEffect, useState } from "react";
import { AddressRulesPage, LoginRulePage } from "./access-rules";
import { emptyRule, RuleEditor, type RulePosition } from "./rule-editor";
import { getWafRuleAction, setWafRuleAction, type WafScopeRule } from "./actions";
import {
    WAF_MANAGED_RULES,
    WAF_RULES_MAX,
    wafManagedRule,
    type WafCustomRule,
    type WafManagedRule,
    type WafScopeType
} from "@polaris/core";

/** The scope as nothing has ever been written to it. The injection checks and
 *  obfuscation are on here for the same reason they are on in the schema: that is the
 *  state of an unconfigured Polaris. */
const BLANK: WafScopeRule = {
    ipAllowlist: [],
    ipDenylist: [],
    requireLogin: false,
    loginAllowPrincipals: [],
    loginDenyPrincipals: [],
    browserIntegrity: false,
    sqlInjectionProtection: true,
    xssProtection: true,
    emailObfuscation: true,
    presets: [],
    rules: []
};

/** Which page is open. The list is the resting state; everything else was opened from
 *  a row on it, which is why each member carries only what that row identified. */
type View =
    | { readonly kind: "list" }
    | { readonly kind: "custom"; readonly index: number | null; readonly rule: WafCustomRule }
    | { readonly kind: "managed"; readonly id: string }
    | { readonly kind: "addresses" }
    | { readonly kind: "login" };

/** Whether the scope currently enforces a predefined rule. */
function managedEnabled(rule: WafManagedRule, saved: WafScopeRule): boolean {
    return rule.control.kind === "preset"
        ? saved.presets.includes(rule.control.preset)
        : saved[rule.control.setting];
}

/** The patch that switches one on or off, whichever half of the scope holds it. */
function managedPatch(rule: WafManagedRule, saved: WafScopeRule, on: boolean): Partial<WafScopeRule> {
    if (rule.control.kind === "setting") return { [rule.control.setting]: on };
    const preset = rule.control.preset;
    return {
        presets: on ? [...saved.presets, preset] : saved.presets.filter((id) => id !== preset)
    };
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
    // What the server holds. Every immediate change is composed against this, so a
    // half-typed address list can never ride along with a switch.
    const [saved, setSaved] = useState<WafScopeRule | null>(null);
    const [view, setView] = useState<View>({ kind: "list" });
    const [error, setError] = useState<string | null>(null);
    const [busy, setBusy] = useState(false);
    // The address lists as they are being typed, held here rather than on their own
    // page so walking back to the rules and returning does not bin a half-written
    // allowlist. Null until somebody edits one, which is what keeps it in step with
    // whatever the last save left behind.
    const [addresses, setAddresses] = useState<{ allow: string[]; deny: string[] } | null>(null);

    useEffect(() => {
        let active = true;
        setSaved(null);
        setError(null);
        setView({ kind: "list" });
        setAddresses(null);
        void getWafRuleAction({ scopeType, scopeId }).then((result) => {
            if (!active) return;
            setSaved(result.rule ?? BLANK);
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

    const backToList = (): void => setView({ kind: "list" });

    if (view.kind === "custom") {
        return (
            <RuleEditor
                rule={view.rule}
                index={view.index}
                others={saved.rules
                    .map((rule, index) => ({ index, name: rule.name }))
                    .filter((entry) => entry.index !== view.index)}
                onCancel={backToList}
                onSave={(rule, position) => {
                    persist({ rules: placed(saved.rules, rule, view.index, position) });
                    backToList();
                }}
            />
        );
    }

    if (view.kind === "managed") {
        const rule = wafManagedRule(view.id);
        // A pack this build no longer ships can still be named by a saved scope. The
        // list does not offer a row for it, so getting here means a stale link.
        if (!rule) return <MissingRule onBack={backToList} />;
        return (
            <ManagedRulePage
                rule={rule}
                enabled={managedEnabled(rule, saved)}
                disabled={busy}
                onBack={backToList}
                onToggle={(on) => persist(managedPatch(rule, saved, on))}
                onCreateException={() =>
                    setView({
                        kind: "custom",
                        index: null,
                        rule: {
                            ...emptyRule(saved.rules.length),
                            name: `Allow past ${rule.label.replace(/^Block /, "")}`.slice(0, 80),
                            action: "allow"
                        }
                    })
                }
            />
        );
    }

    if (view.kind === "addresses") {
        return (
            <AddressRulesPage
                allowlist={saved.ipAllowlist}
                denylist={saved.ipDenylist}
                allow={addresses?.allow ?? [...saved.ipAllowlist]}
                deny={addresses?.deny ?? [...saved.ipDenylist]}
                callerIp={callerIp}
                disabled={busy}
                onBack={backToList}
                onEdit={(allow, deny) => setAddresses({ allow, deny })}
                onSave={(ipAllowlist, ipDenylist) => {
                    persist({ ipAllowlist, ipDenylist });
                    setAddresses(null);
                    backToList();
                }}
            />
        );
    }

    if (view.kind === "login") {
        return (
            <LoginRulePage
                required={saved.requireLogin}
                admitted={saved.loginAllowPrincipals}
                refused={saved.loginDenyPrincipals}
                disabled={busy}
                onBack={backToList}
                onChange={(patch) => persist(patch)}
            />
        );
    }

    const addressCount = saved.ipAllowlist.length + saved.ipDenylist.length;
    // Entries typed and not saved yet. Said on the row, because the page they were
    // typed on is one click away and nothing else would show they are still waiting.
    const addressesUnsaved =
        addresses !== null &&
        JSON.stringify([addresses.allow, addresses.deny]) !== JSON.stringify([saved.ipAllowlist, saved.ipDenylist]);

    return (
        <div className="flex flex-col gap-4">
            {description ? <p className="text-sm text-muted-foreground">{description}</p> : null}

            <RuleList
                rules={saved.rules}
                max={WAF_RULES_MAX}
                canEdit={!busy}
                onCreate={() => setView({ kind: "custom", index: null, rule: emptyRule(saved.rules.length) })}
                onEdit={(index) => {
                    const rule = saved.rules[index];
                    if (rule) setView({ kind: "custom", index, rule });
                }}
                onChange={(rules) => persist({ rules })}
            />

            <PredefinedRuleList
                title="Access rules"
                hint="Who reaches this scope at all, by address and by account. Both are checked before any rule above."
                canEdit={!busy}
                onOpen={(id) => setView(id === "addresses" ? { kind: "addresses" } : { kind: "login" })}
                onToggle={(_, on) => persist({ requireLogin: on })}
                rows={[
                    {
                        id: "addresses",
                        name: "IP access rules",
                        description:
                            "Addresses this scope admits and addresses it refuses. A denied address is blocked everywhere, including on its way to a login.",
                        action: { label: "Access", variant: "neutral" },
                        enabled: null,
                        state: addressesUnsaved
                            ? "Unsaved changes"
                            : addressCount === 0
                              ? "No addresses"
                              : `${saved.ipAllowlist.length} allowed, ${saved.ipDenylist.length} blocked`
                    },
                    ...(offerLogin
                        ? [
                              {
                                  id: "login",
                                  name: "Require a Polaris login",
                                  description:
                                      "Visitors must sign in to Polaris to reach the service, and the rule can name which accounts, groups or roles it admits.",
                                  action: { label: "Login", variant: "neutral" as const },
                                  enabled: saved.requireLogin
                              }
                          ]
                        : [])
                ]}
            />

            <PredefinedRuleList
                title="Managed rules"
                hint="Signatures and lists Polaris keeps up to date. Open one to read the conditions it enforces. A rule enabled on a broader scope also applies here."
                canEdit={!busy}
                onOpen={(id) => setView({ kind: "managed", id })}
                onToggle={(id, on) => {
                    const rule = wafManagedRule(id);
                    if (rule) persist(managedPatch(rule, saved, on));
                }}
                rows={WAF_MANAGED_RULES.map((rule) => ({
                    id: rule.id,
                    name: rule.label,
                    description: rule.description,
                    action: { label: "Block", variant: "danger" as const },
                    enabled: managedEnabled(rule, saved),
                    caution: rule.caution
                }))}
            />

            <Section
                title="Scrape shield"
                hint="Changes the response rather than refusing the request, which is why it is not a rule."
            >
                <div className="flex items-start justify-between gap-4">
                    <div className="flex min-w-0 gap-2">
                        <Mail className="size-4 shrink-0 text-muted-foreground" aria-hidden="true" />
                        <div className="min-w-0">
                            <div className="text-sm">Email address obfuscation</div>
                            <p className="mt-0.5 text-xs text-muted-foreground">
                                Replaces email addresses in served HTML with an encoded token the page decodes in the
                                browser, so the address is not in the source. Visitors see no change. It stops
                                harvesters that read source without running JavaScript, which is most of them; one
                                driving a real browser still reads it.
                            </p>
                        </div>
                    </div>
                    <Switch
                        checked={saved.emailObfuscation}
                        disabled={busy}
                        onChange={(on) => persist({ emailObfuscation: on })}
                        aria-label="Email address obfuscation"
                    />
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

/** A rule that was opened by id and is not in this build - a pack retired in a
 *  release, reached from a link somebody kept. */
function MissingRule({ onBack }: { onBack: () => void }) {
    return (
        <div className="flex flex-col gap-3">
            <p className="text-sm text-muted-foreground">This rule is not part of this version of Polaris.</p>
            <button
                type="button"
                onClick={onBack}
                className="w-fit text-sm text-primary underline-offset-2 hover:underline"
            >
                Back to the rules
            </button>
        </div>
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
            <Skeleton className="h-40 w-full rounded-lg" />
            <Skeleton className="h-72 w-full rounded-lg" />
        </div>
    );
}
