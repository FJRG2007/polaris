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

import Fuse from "fuse.js";
import { RuleList } from "./rule-list";
import { Section } from "./page-parts";
import { ruleDescription } from "./rule-language";
import { Loader2, Mail, Search } from "lucide-react";
import { ManagedRulePage } from "./managed-rule-page";
import { useCallback, useEffect, useState } from "react";
import type { WafInheritedView } from "@/lib/waf-service";
import { Input, Select, Skeleton, Switch } from "@polaris/ui";
import { AddressRulesPage, LoginRulePage } from "./access-rules";
import { emptyRule, RuleEditor, type RulePosition } from "./rule-editor";
import { PredefinedRuleList, type PredefinedRuleRow } from "./predefined-list";
import {
    WAF_MANAGED_RULES,
    WAF_RULES_MAX,
    wafManagedRule,
    type WafCustomRule,
    type WafManagedRule,
    type WafScopeType
} from "@polaris/core";
import {
    getWafRuleAction,
    getWafRuleMatchesAction,
    setTorBlockedAction,
    setWafRuleAction,
    type WafFeedView,
    type WafRuleMatches,
    type WafScopeRule
} from "./actions";

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

/** Whether this scope's own rule arms a predefined rule. A feed is not stored on a
 *  scope at all, so it answers from the instance switch. */
function managedEnabled(rule: WafManagedRule, saved: WafScopeRule, tor: WafFeedView | null): boolean {
    if (rule.control.kind === "preset") return saved.presets.includes(rule.control.preset);
    if (rule.control.kind === "feed") return tor?.enabled ?? false;
    return saved[rule.control.setting];
}

/** The patch that switches one on or off, whichever half of the scope holds it. */
function managedPatch(rule: WafManagedRule, saved: WafScopeRule, on: boolean): Partial<WafScopeRule> {
    if (rule.control.kind === "setting") return { [rule.control.setting]: on };
    if (rule.control.kind === "feed") return {};
    const preset = rule.control.preset;
    return {
        presets: on ? [...saved.presets, preset] : saved.presets.filter((id) => id !== preset)
    };
}

/** Said once, because the row and the rule's own page both say it. */
const ARMED_ABOVE = {
    label: "From a broader scope",
    why: "A scope above this one arms it, and a narrower scope cannot switch a refusal off. Write an allow rule above it to carve out an exception."
};

const OFF_ABOVE = {
    label: "Off above",
    why: "A scope above this one switched it off for everything it covers, and a narrower scope cannot switch it back on."
};

const INSTANCE_FEED = {
    label: "Instance-wide",
    why: "One switch for the whole instance: the edge refuses the address before it knows which service was asked for. Open the rule to change it."
};

/**
 * Who decides this rule, when it is not this scope.
 *
 * Without it every managed rule on a project reads "Off" while the instance-wide
 * default is refusing scanners on its behalf - a switch saying the opposite of what is
 * happening. The two directions are not symmetric because the rules are not: a pack and
 * the integrity check union downward, so a broader scope can only turn them ON; the
 * injection checks intersect, so a broader scope can only turn them OFF.
 *
 * Nothing is returned when this scope also holds the setting itself - the switch stays
 * live so it can be cleared, and the row falls back to this state once it is.
 */
function decidedElsewhere(
    rule: WafManagedRule,
    saved: WafScopeRule,
    inherited: WafInheritedView | null,
    tor: WafFeedView | null,
    canOperate: boolean
): { on: boolean; label: string; why: string } | undefined {
    if (rule.control.kind === "feed") {
        // Never switched from the row: an operator changes it on the rule's own page,
        // where the size of the list and "this applies everywhere" are on screen with
        // the switch. Flipping the whole instance from a project's row is not something
        // to do in passing.
        return {
            on: tor?.enabled ?? false,
            ...INSTANCE_FEED,
            why: canOperate ? INSTANCE_FEED.why : "Set by whoever runs this instance."
        };
    }
    if (!inherited) return undefined;
    if (rule.control.kind === "preset") {
        if (saved.presets.includes(rule.control.preset)) return undefined;
        return inherited.presets.includes(rule.control.preset) ? { on: true, ...ARMED_ABOVE } : undefined;
    }
    if (rule.control.setting === "browserIntegrity") {
        if (saved.browserIntegrity) return undefined;
        return inherited.browserIntegrity ? { on: true, ...ARMED_ABOVE } : undefined;
    }
    return inherited[rule.control.setting] ? undefined : { on: false, ...OFF_ABOVE };
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
    callerIp,
    /** Whether the reader runs the instance. Only they can change something that is
     *  one switch for all of it, which the Tor list is. */
    canOperate = false,
    /** Traffic, bans and jails, which are instance-wide and belong under the rule list
     *  rather than under whichever rule happens to be open. Rendered by the caller
     *  because it is a server component; shown here only on the list. */
    instancePanels
}: {
    scopeType: WafScopeType;
    scopeId: string;
    description?: string;
    offerLogin?: boolean;
    callerIp?: string | null;
    canOperate?: boolean;
    instancePanels?: React.ReactNode;
}) {
    // What the server holds. Every immediate change is composed against this, so a
    // half-typed address list can never ride along with a switch.
    const [saved, setSaved] = useState<WafScopeRule | null>(null);
    // What the scopes above this one already enforce, and the instance-wide feeds.
    // Read with the rule because a row cannot be drawn honestly without them.
    const [inherited, setInherited] = useState<WafInheritedView | null>(null);
    const [tor, setTor] = useState<WafFeedView | null>(null);
    const [view, setView] = useState<View>({ kind: "list" });
    const [error, setError] = useState<string | null>(null);
    const [busy, setBusy] = useState(false);
    // The address lists as they are being typed, held here rather than on their own
    // page so walking back to the rules and returning does not bin a half-written
    // allowlist. Null until somebody edits one, which is what keeps it in step with
    // whatever the last save left behind.
    const [addresses, setAddresses] = useState<{ allow: string[]; deny: string[] } | null>(null);
    // What each rule matches over recent traffic. Its own round trip: it reads the
    // edge log, and the rules have to be on screen before that finishes.
    const [matches, setMatches] = useState<WafRuleMatches | undefined>(undefined);
    const [search, setSearch] = useState("");
    const [status, setStatus] = useState<"all" | "active" | "off">("all");

    useEffect(() => {
        let active = true;
        setSaved(null);
        setInherited(null);
        setTor(null);
        setError(null);
        setView({ kind: "list" });
        setAddresses(null);
        setMatches(undefined);
        void getWafRuleAction({ scopeType, scopeId }).then((result) => {
            if (!active) return;
            setSaved(result.rule ?? BLANK);
            setInherited(result.inherited ?? null);
            setTor(result.tor ?? null);
            if (result.error) setError(result.error);
        });
        void getWafRuleMatchesAction({ scopeType, scopeId }).then((result) => {
            // A log that cannot be read is not an error worth interrupting the screen
            // for - the column simply has nothing to draw.
            if (active) setMatches(result.matches ?? {});
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

    /**
     * Switch a feed on or off. Its own path rather than `persist`, because it is not
     * part of any scope's rule: the edge holds the list in memory and refuses an
     * address before it knows which service was asked for.
     */
    const persistTor = useCallback((on: boolean) => {
        setTor((current) => {
            const previous = current;
            setError(null);
            setBusy(true);
            void setTorBlockedAction(on)
                .then((result) => {
                    if (result.error) {
                        setTor(previous);
                        setError(result.error);
                    }
                })
                .finally(() => setBusy(false));
            return { count: 0, fetchedAt: null, error: null, ...current, enabled: on };
        });
    }, []);

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
        const feed = rule.control.kind === "feed";
        return (
            <ManagedRulePage
                rule={rule}
                enabled={managedEnabled(rule, saved, tor)}
                disabled={busy || (feed && !canOperate)}
                // A feed is the one rule this page can change instance-wide, so the
                // switch stays live here for an operator - the row does not offer it.
                decidedElsewhere={
                    feed && canOperate ? undefined : decidedElsewhere(rule, saved, inherited, tor, canOperate)
                }
                feed={feed ? (tor ?? { count: 0, fetchedAt: null, error: null }) : undefined}
                onBack={backToList}
                onToggle={(on) => (feed ? persistTor(on) : persist(managedPatch(rule, saved, on)))}
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

    const accessRows: PredefinedRuleRow[] = [
        {
            id: "addresses",
            name: "IP access rules",
            description: "Addresses this scope admits, and addresses it refuses before anything else is checked.",
            action: { label: "Access", variant: "neutral" },
            enabled: null,
            // Enforced before any rule is evaluated, so there is nothing to replay.
            activity: null,
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
                      description: "Visitors sign in to Polaris first, and the rule can name which accounts it admits.",
                      action: { label: "Login", variant: "neutral" as const },
                      enabled: saved.requireLogin,
                      activity: null
                  }
              ]
            : [])
    ];

    const managedRows: PredefinedRuleRow[] = WAF_MANAGED_RULES.map((rule) => ({
        id: rule.id,
        name: rule.label,
        description: rule.description,
        action: { label: "Block", variant: "danger" as const },
        enabled: managedEnabled(rule, saved, tor),
        decidedElsewhere: decidedElsewhere(rule, saved, inherited, tor, canOperate),
        caution: rule.caution,
        // A signature check and a fetched list have no conditions to replay, so there
        // is nothing honest to draw for them.
        activity: rule.rules.length === 0 ? null : matches?.[rule.id]
    }));

    /**
     * The search, over every row on the screen at once.
     *
     * Fuzzy rather than a substring test: the rules are named in the operator's second
     * language as often as their first, and "scaner"/"wordpres"/"tor exit" all have to
     * find the row somebody meant. Rebuilt each render rather than memoised - it is a
     * few dozen short strings, and a stale index would silently stop finding a rule
     * that was just renamed.
     */
    const needle = search.trim();
    const found =
        needle === ""
            ? null
            : new Set(
                  new Fuse(
                      [
                          ...saved.rules.map((rule, index) => ({
                              key: `custom:${index}`,
                              name: rule.name,
                              description: ruleDescription(rule)
                          })),
                          ...accessRows.map((row) => ({ key: `row:${row.id}`, name: row.name, description: row.description })),
                          ...managedRows.map((row) => ({ key: `row:${row.id}`, name: row.name, description: row.description }))
                      ],
                      { keys: ["name", "description"], threshold: 0.35, ignoreLocation: true, minMatchCharLength: 2 }
                  )
                      .search(needle)
                      .map((hit) => hit.item.key)
              );

    /** Whether a row survives the search and the status filter. `enabled` is what is
     *  actually being enforced, so "Off only" does not list a rule armed from above. */
    const shown = (key: string, enabled: boolean | null): boolean => {
        if (found && !found.has(key)) return false;
        if (status === "all" || enabled === null) return true;
        return status === "active" ? enabled : !enabled;
    };

    const hiddenRules = new Set(
        saved.rules
            .map((rule, index) => ({ rule, index }))
            .filter(({ rule, index }) => !shown(`custom:${index}`, rule.enabled))
            .map(({ index }) => index)
    );
    const filtering = needle !== "" || status !== "all";

    return (
        <div className="flex flex-col gap-4">
            {description ? <p className="text-sm text-muted-foreground">{description}</p> : null}

            <div className="flex flex-wrap items-center gap-2">
                <div className="relative min-w-0 flex-1">
                    <Search
                        className="pointer-events-none absolute left-2.5 top-1/2 size-4 shrink-0 -translate-y-1/2 text-muted-foreground"
                        aria-hidden="true"
                    />
                    <Input
                        value={search}
                        aria-label="Search rules by name"
                        placeholder="Search rules by name"
                        className="pl-8"
                        onChange={(event) => setSearch(event.target.value)}
                    />
                </div>
                <Select
                    value={status}
                    aria-label="Show"
                    className="w-40"
                    options={[
                        { value: "all", label: "Show all" },
                        { value: "active", label: "Active only" },
                        { value: "off", label: "Off only" }
                    ]}
                    onValueChange={(value) => setStatus(value as "all" | "active" | "off")}
                />
            </div>

            <RuleList
                rules={saved.rules}
                max={WAF_RULES_MAX}
                // Dragging renumbers the list, and the list on screen is not the whole
                // list while a search is on - so the drag is off rather than moving a
                // rule the reader cannot see.
                canEdit={!busy && !filtering}
                hidden={hiddenRules}
                matches={matches}
                onCreate={() => setView({ kind: "custom", index: null, rule: emptyRule(saved.rules.length) })}
                onEdit={(index) => {
                    const rule = saved.rules[index];
                    if (rule) setView({ kind: "custom", index, rule });
                }}
                onChange={(rules) => persist({ rules })}
            />

            <PredefinedRuleList
                title="Access rules"
                hint="Who reaches this scope at all. Both are checked before any rule above."
                canEdit={!busy}
                onOpen={(id) => setView(id === "addresses" ? { kind: "addresses" } : { kind: "login" })}
                onToggle={(_, on) => persist({ requireLogin: on })}
                rows={accessRows.filter((row) => shown(`row:${row.id}`, row.enabled))}
            />

            <PredefinedRuleList
                title="Managed rules"
                hint="Signatures and lists Polaris keeps up to date. Open one to read what it enforces."
                canEdit={!busy}
                onOpen={(id) => setView({ kind: "managed", id })}
                onToggle={(id, on) => {
                    const rule = wafManagedRule(id);
                    // A feed is not part of any scope's rule, and its row never offers
                    // the switch - persisting the scope for it would be a no-op write.
                    if (rule && rule.control.kind !== "feed") persist(managedPatch(rule, saved, on));
                }}
                rows={managedRows.filter((row) =>
                    shown(`row:${row.id}`, row.decidedElsewhere ? row.decidedElsewhere.on : row.enabled)
                )}
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
                                Replaces email addresses in served HTML with a token the page decodes in the browser,
                                so the address is not in the source. Visitors see no change. A harvester driving a real
                                browser still reads it.
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

            {/* Under the rules rather than under whichever rule is open: what the
                firewall has been doing is instance-wide, and repeating it below every
                rule page made it read as part of that rule. */}
            {instancePanels}
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
