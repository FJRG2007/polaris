"use client";

/**
 * The rules Polaris brings with it, listed the way the hand-written ones are.
 *
 * They used to be a column of switches with a paragraph of prose each, which reads as
 * settings rather than as rules and hides the only question anybody arrives with:
 * what does this actually block? A row that opens into the rule's own page answers it,
 * and putting these in the same table shape as the custom rules says the true thing -
 * they are all rules, evaluated by the same engine, and the ones above them can carve
 * exceptions out of the ones below.
 *
 * The switch stays on the row on purpose. Arming a pack is a complete thought and the
 * common reason to come here; making somebody open a page to find it would be a step
 * added for the sake of consistency with an editor they did not want.
 */

import { MatchesCell } from "./rule-list";
import { Badge, Switch } from "@polaris/ui";
import { ChevronRight, TriangleAlert } from "lucide-react";

export interface PredefinedRuleRow {
    readonly id: string;
    readonly name: string;
    readonly description: string;
    /** The Action column, as its own label: every managed rule blocks, but an access
     *  rule admits and refuses at once and would be a lie either way. */
    readonly action: { readonly label: string; readonly variant: "danger" | "success" | "neutral" };
    /** The row's switch. Null for a rule that is on whenever it holds anything, which
     *  is what the address lists are - an empty allowlist is not a switch that is off. */
    readonly enabled: boolean | null;
    /** What the Status column says when the row carries no switch. */
    readonly state?: string;
    /**
     * Set when something other than this scope decides the rule: a pack armed above,
     * an injection check switched off above, a feed that is one switch for the whole
     * instance. The switch then shows what is actually being enforced and refuses to
     * move, rather than showing this scope's own unused value.
     */
    readonly decidedElsewhere?: { readonly on: boolean; readonly label: string; readonly why: string };
    /** What arming it costs, shown as a warning next to the row. */
    readonly caution?: string;
    /** What it matches over recent traffic. Absent for a row that is not a rule -
     *  the address lists are enforced before anything is replayed. */
    readonly activity?: { total: number; series: number[] } | null;
}

export function PredefinedRuleList({
    title,
    hint,
    rows,
    canEdit,
    onOpen,
    onToggle
}: {
    title: string;
    hint: string;
    rows: readonly PredefinedRuleRow[];
    canEdit: boolean;
    onOpen: (id: string) => void;
    onToggle: (id: string, on: boolean) => void;
}) {
    return (
        <section className="rounded-lg border border-border bg-card">
            <header className="flex flex-col gap-1 px-4 py-3">
                <h2 className="text-sm font-semibold">{title}</h2>
                <p className="text-xs text-muted-foreground">{hint}</p>
            </header>

            <div className="overflow-x-auto border-t border-border">
                <table className="w-full min-w-[44rem] text-sm">
                    <thead>
                        <tr className="text-left text-xs text-muted-foreground">
                            <th className="px-4 py-2.5 font-medium">Name</th>
                            <th className="px-4 py-2.5 font-medium">Description</th>
                            <th className="w-24 px-3 py-2.5 font-medium">Action</th>
                            <th className="w-32 px-3 py-2.5 font-medium">Matches</th>
                            <th className="w-32 px-3 py-2.5 font-medium">Status</th>
                            <th className="w-10 px-2 py-2.5" aria-label="Open" />
                        </tr>
                    </thead>
                    <tbody>
                        {rows.map((row) => {
                            const decided = row.decidedElsewhere;
                            const on = decided ? decided.on : row.enabled;
                            return (
                            <tr
                                key={row.id}
                                className={`border-t border-border transition-colors hover:bg-muted/40 ${
                                    on === false ? "opacity-60" : ""
                                }`}
                            >
                                <td className="min-w-[10rem] px-4 py-3.5 pr-6 align-top">
                                    <button
                                        type="button"
                                        onClick={() => onOpen(row.id)}
                                        className="rounded text-left font-medium underline-offset-2 hover:underline focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
                                    >
                                        {row.name}
                                    </button>
                                </td>
                                <td className="w-full max-w-0 px-4 py-3.5 align-top text-muted-foreground">
                                    <span className="line-clamp-2 [overflow-wrap:anywhere]" title={row.description}>
                                        {row.description}
                                    </span>
                                    {row.caution && on !== false ? (
                                        <span className="mt-1 flex items-start gap-1.5 text-xs text-warning">
                                            <TriangleAlert className="mt-0.5 size-3 shrink-0" aria-hidden="true" />
                                            {row.caution}
                                        </span>
                                    ) : null}
                                </td>
                                <td className="px-3 py-3.5 align-top">
                                    <Badge variant={row.action.variant}>{row.action.label}</Badge>
                                </td>
                                <td className="px-3 py-3.5 align-top">
                                    {row.activity === null ? (
                                        <span className="text-xs text-muted-foreground">-</span>
                                    ) : (
                                        <MatchesCell name={row.name} activity={row.activity} />
                                    )}
                                </td>
                                <td className="px-3 py-3.5 align-top">
                                    {row.enabled === null && !decided ? (
                                        <span className="text-xs text-muted-foreground">{row.state}</span>
                                    ) : (
                                        <div className="flex items-center gap-2">
                                            <Switch
                                                checked={on === true}
                                                disabled={!canEdit || decided !== undefined}
                                                onChange={(next) => onToggle(row.id, next)}
                                                aria-label={`${on ? "Disable" : "Enable"} ${row.name}`}
                                            />
                                            <span
                                                className="text-xs text-muted-foreground"
                                                title={decided ? decided.why : undefined}
                                            >
                                                {decided ? decided.label : on ? "Active" : "Off"}
                                            </span>
                                        </div>
                                    )}
                                </td>
                                <td className="px-2 py-3.5 align-top text-right">
                                    <button
                                        type="button"
                                        onClick={() => onOpen(row.id)}
                                        aria-label={`Open ${row.name}`}
                                        title="Open"
                                        className="inline-flex size-7 items-center justify-center rounded-md text-muted-foreground transition-colors hover:bg-muted hover:text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
                                    >
                                        <ChevronRight className="size-4 shrink-0" aria-hidden="true" />
                                    </button>
                                </td>
                            </tr>
                            );
                        })}
                    </tbody>
                </table>
            </div>
        </section>
    );
}
