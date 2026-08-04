"use client";

/**
 * One predefined rule, opened.
 *
 * The page exists to answer "what does this block?" with the rule rather than with a
 * paragraph about it. A pack answers with the conditions it expands to, rendered by
 * the same code that renders a hand-written rule - so an operator who has read one
 * rule can read all of them. A signature check cannot be written as conditions, and
 * pretending otherwise would be worse than saying so: it answers with the families it
 * matches, each with the reason its refusals carry, so a blocked request in the
 * traffic log can be traced back to the line that explains it.
 *
 * Nothing here is editable, and that is the point of a managed rule: the list is
 * improved in a release without touching anything an operator saved. What they can do
 * instead is switch it off for this scope, or write an allow rule above it - and the
 * page offers that second one directly, because "this is blocking something I need"
 * is the reason anybody opens it.
 */

import * as core from "@polaris/core";
import { ruleDescription } from "./rule-language";
import { Badge, Button, Switch } from "@polaris/ui";
import { CopyButton } from "@/components/copy-button";
import { grouped, PageHeader, Section } from "./page-parts";
import { useDisplayFormat } from "@/components/display-format";
import { CircleOff, Plus, ShieldCheck, TriangleAlert } from "lucide-react";

/**
 * The expression a signature check is written as.
 *
 * It is the same condition a rule of your own can hold, which is what makes copying
 * this out of here worth offering: `waf.sql_injection and http.host eq "shop"` is a
 * narrower version of the managed rule, and it is enforced by the same code.
 */
function signalExpression(rule: core.WafManagedRule): string | null {
    if (rule.control.kind !== "setting") return null;
    const signal =
        rule.control.setting === "sqlInjectionProtection"
            ? "sql_injection"
            : rule.control.setting === "xssProtection"
              ? "xss"
              : "browser_integrity";
    return core.renderWafExpression([{ signal, negate: false }]);
}

export function ManagedRulePage({
    rule,
    enabled,
    disabled,
    decidedElsewhere,
    feed,
    onBack,
    onToggle,
    onCreateException
}: {
    rule: core.WafManagedRule;
    enabled: boolean;
    disabled?: boolean;
    /** Set when this scope is not the one deciding - see `PredefinedRuleRow`. The page
     *  and the row it was opened from have to agree, so both take the same shape. */
    decidedElsewhere?: { readonly on: boolean; readonly label: string; readonly why: string };
    /** How the fetched list is doing, for a rule that is one. What it blocks is neither
     *  a condition nor a signature, so the size of the list and its age are the only
     *  honest answer to "what does this refuse?". */
    feed?: { count: number; fetchedAt: string | null; error: string | null };
    onBack: () => void;
    onToggle: (on: boolean) => void;
    /** Opens the custom rule editor on an allow rule named after this one. */
    onCreateException: () => void;
}) {
    const format = useDisplayFormat();
    const expression = signalExpression(rule);
    const on = decidedElsewhere ? decidedElsewhere.on : enabled;

    return (
        <div className="flex flex-col gap-4">
            <PageHeader title={rule.label} onBack={onBack} />

            <Section title="What it does">
                <p className="text-sm text-muted-foreground">{rule.description}</p>
                <p className="text-xs text-muted-foreground">
                    <span className="font-medium text-foreground">Reads:</span> {rule.inspects}
                </p>
                <p className="text-xs text-muted-foreground">
                    <span className="font-medium text-foreground">Across scopes:</span> {rule.combines}
                </p>
                {rule.caution ? (
                    <p className="flex items-start gap-1.5 text-xs text-warning">
                        <TriangleAlert className="mt-0.5 size-3 shrink-0" aria-hidden="true" />
                        {rule.caution}
                    </p>
                ) : null}
            </Section>

            <Section title="Status" hint="Whether this scope enforces the rule.">
                <div className="flex items-center gap-3">
                    <Switch
                        checked={on}
                        disabled={disabled || decidedElsewhere !== undefined}
                        onChange={onToggle}
                        aria-label={`${on ? "Disable" : "Enable"} ${rule.label}`}
                    />
                    <span className="flex items-center gap-1.5 text-sm">
                        {on ? (
                            <ShieldCheck className="size-4 shrink-0 text-success" aria-hidden="true" />
                        ) : (
                            <CircleOff className="size-4 shrink-0 text-muted-foreground" aria-hidden="true" />
                        )}
                        {decidedElsewhere ? decidedElsewhere.label : on ? "Active on this scope" : "Off on this scope"}
                    </span>
                </div>
                {decidedElsewhere ? (
                    <p className="text-xs text-muted-foreground">{decidedElsewhere.why}</p>
                ) : null}
            </Section>

            {feed ? (
                <Section title="The list" hint="Fetched hourly and held at the edge, so no request waits on a lookup.">
                    {feed.count > 0 ? (
                        <p className="text-sm">
                            <span className="font-medium tabular-nums">{grouped(feed.count)}</span>{" "}
                            <span className="text-muted-foreground">
                                addresses
                                {feed.fetchedAt ? `, updated ${format.dateTime(feed.fetchedAt)}` : ""}
                            </span>
                        </p>
                    ) : (
                        <p className="text-sm text-muted-foreground">
                            Not fetched yet. It arrives within a few minutes of the rule being armed.
                        </p>
                    )}
                    {feed.error ? (
                        <p className="flex items-start gap-1.5 text-xs text-warning">
                            <TriangleAlert className="mt-0.5 size-3 shrink-0" aria-hidden="true" />
                            The last refresh failed ({feed.error}). The previous list is still being enforced.
                        </p>
                    ) : null}
                </Section>
            ) : null}

            {rule.rules.length > 0 ? (
                <Section
                    title="Conditions"
                    hint="Maintained by Polaris, and evaluated by the same engine as your own rules - after them."
                >
                    <div className="flex flex-col gap-4">
                        {rule.rules.map((entry, index) => (
                            <div key={index} className="flex flex-col gap-2">
                                <div className="flex flex-wrap items-center gap-2">
                                    <span className="text-sm font-medium">{entry.name}</span>
                                    <Badge variant={entry.action === "block" ? "danger" : "success"}>
                                        {entry.action === "block" ? "Block" : "Allow"}
                                    </Badge>
                                </div>
                                <p className="text-xs text-muted-foreground [overflow-wrap:anywhere]">
                                    {ruleDescription(entry)}
                                </p>
                                <Expression value={core.renderWafExpression(entry.conditions)} />
                            </div>
                        ))}
                    </div>
                </Section>
            ) : null}

            {expression ? (
                <Section
                    title="Expression"
                    hint="Copy it into a rule of your own to narrow the check - to one hostname, one path, one client - instead of switching it off for the whole scope."
                >
                    <Expression value={expression} />
                </Section>
            ) : null}

            {rule.signatures.length > 0 ? (
                <Section
                    title="What it matches"
                    hint="The families it refuses. Each reason is the one written into the refusal, so a blocked request in the traffic log names the line it came from."
                >
                    <ul className="flex flex-col divide-y divide-border">
                        {rule.signatures.map((family) => (
                            <li key={family.reason} className="flex flex-col gap-1 py-2.5 first:pt-0 last:pb-0">
                                <code className="w-fit rounded bg-muted px-1.5 py-0.5 font-mono text-xs text-foreground">
                                    {family.reason}
                                </code>
                                <p className="text-xs text-muted-foreground">{family.detail}</p>
                                {family.example ? (
                                    <p className="text-xs text-muted-foreground [overflow-wrap:anywhere]">
                                        Refused, for example:{" "}
                                        <code className="font-mono text-foreground">?{family.example}</code>
                                    </p>
                                ) : null}
                            </li>
                        ))}
                    </ul>
                </Section>
            ) : null}

            <Section
                title="Exceptions"
                hint="Your own rules run before every managed one, so an allow above this admits the traffic without switching the rule off for everything else."
            >
                <Button type="button" variant="secondary" size="sm" className="w-fit" onClick={onCreateException}>
                    <Plus className="size-3.5 shrink-0" aria-hidden="true" />
                    Create an exception
                </Button>
            </Section>
        </div>
    );
}

/** One expression, in the shape it is read and copied in. */
function Expression({ value }: { value: string }) {
    return (
        <div className="flex items-start gap-2">
            <pre className="min-w-0 flex-1 overflow-x-auto rounded-md bg-muted px-3 py-2 font-mono text-xs text-foreground">
                {value}
            </pre>
            <CopyButton value={value} label="Copy the expression" className="mt-1.5" />
        </div>
    );
}
