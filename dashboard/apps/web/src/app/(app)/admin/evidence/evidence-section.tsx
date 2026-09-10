"use client";

/**
 * One area of the evidence: its controls, where each is set, what is listed on
 * its own, and the last change the audit trail holds for it.
 *
 * Everything that names a record opens it - the screen a control is set on, the
 * administrator's account, the protected item, the person who last changed it -
 * because the next thing anybody reading evidence does is go and look.
 */

import Link from "next/link";
import { Badge, Card, CardBody, CardHeader, CardTitle } from "@polaris/ui";
import { factText, type EvidenceFact, type EvidenceSection } from "@/lib/compliance/evidence";

/** A value, with the flag that says it is worth a second look. */
function FactValue({
    fact,
    formatDate
}: {
    fact: EvidenceFact;
    formatDate: (iso: string) => string;
}) {
    return (
        <span className="inline-flex flex-wrap items-center gap-1.5">
            <span className={fact.attention ? "text-warning-ink" : undefined}>
                {factText(fact, formatDate)}
            </span>
            {fact.attention ? <Badge variant="warning">Review</Badge> : null}
        </span>
    );
}

export function EvidenceSectionCard({
    section,
    formatDate
}: {
    section: EvidenceSection;
    formatDate: (iso: string) => string;
}) {
    const change = section.lastChange;
    const rows = section.rows;
    const columns = rows?.items[0]?.facts.map((fact) => fact.label) ?? [];

    return (
        <Card>
            <CardHeader>
                <CardTitle>{section.title}</CardTitle>
                <p className="text-xs text-muted-foreground">
                    Set in{" "}
                    {section.where.map((where, index) => (
                        <span key={where.label}>
                            {index > 0 ? ", " : null}
                            <Link
                                href={where.href}
                                className="text-foreground underline-offset-2 hover:underline"
                            >
                                {where.label}
                            </Link>
                        </span>
                    ))}
                </p>
            </CardHeader>
            <CardBody className="flex flex-col gap-4">
                <dl className="flex flex-col text-sm">
                    {section.facts.map((fact) => (
                        <div
                            key={fact.id}
                            className="flex flex-col gap-0.5 border-t border-border py-2 first:border-t-0 first:pt-0 sm:flex-row sm:items-baseline sm:gap-4"
                        >
                            <dt className="text-muted-foreground sm:w-2/5 sm:shrink-0">
                                {fact.label}
                            </dt>
                            <dd className="min-w-0 break-words">
                                <FactValue fact={fact} formatDate={formatDate} />
                            </dd>
                        </div>
                    ))}
                </dl>

                {rows && rows.items.length > 0 ? (
                    <div className="flex flex-col gap-1.5">
                        <p className="text-xs font-medium">
                            {rows.title}
                            {rows.items.length < rows.total ? (
                                <span className="font-normal text-muted-foreground">
                                    {" "}
                                    - {rows.items.length} of {rows.total} shown
                                </span>
                            ) : null}
                        </p>
                        <div className="overflow-x-auto rounded-md border border-border">
                            <table className="w-full text-sm">
                                <thead>
                                    <tr className="border-b border-border">
                                        <th className="px-3 py-2 text-left">Name</th>
                                        {columns.map((column) => (
                                            <th key={column} className="px-3 py-2 text-left">
                                                {column}
                                            </th>
                                        ))}
                                    </tr>
                                </thead>
                                <tbody>
                                    {rows.items.map((row) => (
                                        <tr
                                            key={row.id}
                                            className="border-b border-border last:border-b-0"
                                        >
                                            <td className="px-3 py-2">
                                                <Link
                                                    href={row.href}
                                                    className="font-medium hover:underline"
                                                >
                                                    {row.label}
                                                </Link>
                                            </td>
                                            {row.facts.map((fact) => (
                                                <td
                                                    key={fact.id}
                                                    className="whitespace-nowrap px-3 py-2"
                                                >
                                                    <FactValue
                                                        fact={fact}
                                                        formatDate={formatDate}
                                                    />
                                                </td>
                                            ))}
                                        </tr>
                                    ))}
                                </tbody>
                            </table>
                        </div>
                    </div>
                ) : null}

                <div className="flex flex-col gap-1 border-t border-border pt-3 text-xs text-muted-foreground">
                    {change ? (
                        <p>
                            Last changed {formatDate(change.at)} by{" "}
                            {change.actorId && change.actorExists ? (
                                <Link
                                    href={`/admin/users/${change.actorId}`}
                                    className="text-foreground hover:underline"
                                >
                                    {change.actorName}
                                </Link>
                            ) : (
                                <span className="text-foreground">{change.actorName}</span>
                            )}{" "}
                            <span className="font-mono text-foreground-subtle">
                                {change.action}
                            </span>
                        </p>
                    ) : (
                        <p>No change to this is recorded in the audit trail.</p>
                    )}
                    {section.notes.map((note) => (
                        <p key={note}>{note}</p>
                    ))}
                </div>
            </CardBody>
        </Card>
    );
}
