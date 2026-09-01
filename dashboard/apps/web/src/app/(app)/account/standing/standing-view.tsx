"use client";

/**
 * The standing card and the ladder under it.
 *
 * The ladder is the whole point of the screen. A word on its own - "limited" -
 * says nothing about how far that is from fine and how far from gone; five marks
 * with the one you are on lit says both at a glance, which is why every service
 * that tells people this draws it the same way.
 *
 * Marks after the one in force are drawn in the same muted grey rather than in
 * their own colour: they have not happened, and a red dot on the screen of
 * somebody who is fine is a warning about nothing.
 */

import { Check } from "lucide-react";
import { Avatar } from "@/components/avatar";
import { Card, CardBody, cn } from "@polaris/ui";
import { useDisplayFormat } from "@/components/display-format";
import {
    ACCOUNT_STANDINGS,
    ACCOUNT_STANDING_LABELS,
    ACCOUNT_STANDING_NOTES,
    ACCOUNT_STANDING_WORDS,
    standingIndex,
    type AccountStanding
} from "@polaris/core";

/** Something in force, as the page is handed it - moments as strings, since it
 *  crosses from a server component. */
interface Restriction {
    readonly kind: "timeout" | "ban";
    readonly where: string;
    readonly until: string | null;
}

/** The colour a step is drawn in when it is the one in force. Three tokens for
 *  five steps: only ever one is lit, so the pairs cannot be confused with each
 *  other, and inventing two more semantic colours for this one screen would put
 *  colours in the design system that mean nothing anywhere else. */
const STEP_COLOURS: Record<AccountStanding, string> = {
    good: "bg-success",
    limited: "bg-warning",
    veryLimited: "bg-warning",
    atRisk: "bg-danger",
    suspended: "bg-danger"
};

const WORD_COLOURS: Record<AccountStanding, string> = {
    good: "text-success",
    limited: "text-warning",
    veryLimited: "text-warning",
    atRisk: "text-danger",
    suspended: "text-danger"
};

export function StandingView({
    person,
    standing,
    upheld,
    since,
    restrictions
}: {
    person: { readonly id: string; readonly name: string };
    standing: AccountStanding;
    upheld: number;
    since: string;
    restrictions: readonly Restriction[];
}) {
    const format = useDisplayFormat();
    const current = standingIndex(standing);

    return (
        <div className="flex flex-col gap-4">
            <Card>
                <CardBody className="flex flex-col gap-6">
                    <div className="flex items-start gap-4">
                        <Avatar person={person} size={64} status={false} className="mt-0.5 shrink-0" />
                        <div className="flex min-w-0 flex-col gap-1">
                            <h2 className="text-[0.9375rem] font-medium">
                                Your account is{" "}
                                <span className={cn("font-semibold", WORD_COLOURS[standing])}>
                                    {ACCOUNT_STANDING_WORDS[standing]}
                                </span>
                            </h2>
                            <p className="text-sm text-muted-foreground">
                                {ACCOUNT_STANDING_NOTES[standing]}
                            </p>
                            {upheld > 0 && (
                                <p className="text-xs text-muted-foreground">
                                    Counted since {format.date(since)}. Older decisions no longer count.
                                </p>
                            )}
                        </div>
                    </div>

                    {/* The rail: a mark per step with the line between them, and
                        the names underneath. A grid rather than a flex row so
                        every name sits under its own mark whatever its length. */}
                    <ol
                        className="grid items-start gap-y-2"
                        style={{ gridTemplateColumns: `repeat(${ACCOUNT_STANDINGS.length}, minmax(0, 1fr))` }}
                    >
                        {ACCOUNT_STANDINGS.map((step, index) => {
                            const lit = index === current;
                            return (
                                <li
                                    key={step}
                                    className="flex flex-col items-center gap-2 text-center"
                                    aria-current={lit ? "step" : undefined}
                                >
                                    {/* A fixed height, and it is what keeps the
                                        rail straight: the mark in force is
                                        twice the size of the rest, so a row that
                                        took its height from its contents drew
                                        the lit column taller than its
                                        neighbours - the line through it sat
                                        lower and the name under it lower still.
                                        Every column is the height of the biggest
                                        mark, and the small ones centre in it. */}
                                    <span className="flex h-6 w-full items-center">
                                        {/* Half a line either side, so the rail is
                                            continuous across the row and stops at
                                            both ends. */}
                                        <span
                                            className={cn(
                                                "h-0.5 flex-1 rounded-full",
                                                index === 0 ? "bg-transparent" : "bg-border-strong"
                                            )}
                                        />
                                        <span
                                            className={cn(
                                                "grid shrink-0 place-items-center rounded-full",
                                                lit
                                                    ? cn("size-6 text-white", STEP_COLOURS[step])
                                                    : "size-3 bg-border-strong"
                                            )}
                                        >
                                            {lit && standing === "good" && (
                                                <Check className="size-4" strokeWidth={3} />
                                            )}
                                        </span>
                                        <span
                                            className={cn(
                                                "h-0.5 flex-1 rounded-full",
                                                index === ACCOUNT_STANDINGS.length - 1
                                                    ? "bg-transparent"
                                                    : "bg-border-strong"
                                            )}
                                        />
                                    </span>
                                    <span
                                        className={cn(
                                            "text-[0.6875rem] leading-tight sm:text-xs",
                                            lit ? "font-medium text-foreground" : "text-muted-foreground"
                                        )}
                                    >
                                        {ACCOUNT_STANDING_LABELS[step]}
                                    </span>
                                </li>
                            );
                        })}
                    </ol>
                </CardBody>
            </Card>

            <Card>
                <CardBody className="flex flex-col gap-3">
                    <div>
                        <h2 className="text-sm font-medium">In force now</h2>
                        <p className="text-xs text-muted-foreground">
                            A timeout ends by itself. A ban is lifted by whoever runs that space.
                        </p>
                    </div>
                    {restrictions.length === 0 ? (
                        <p className="text-sm text-muted-foreground">
                            Nothing. You can post everywhere you are a member.
                        </p>
                    ) : (
                        <ul className="flex flex-col gap-2">
                            {restrictions.map((restriction, index) => (
                                <li
                                    key={`${restriction.kind}-${restriction.where}-${index}`}
                                    className="flex items-center justify-between gap-3 rounded-md border border-border bg-muted/30 px-3 py-2 text-sm"
                                >
                                    <span className="min-w-0 truncate">
                                        {restriction.kind === "ban" ? "Banned from" : "Timed out in"}{" "}
                                        <span className="font-medium">{restriction.where}</span>
                                    </span>
                                    <span className="shrink-0 text-xs text-muted-foreground">
                                        {restriction.until
                                            ? `until ${format.dateTime(restriction.until)}`
                                            : "until it is lifted"}
                                    </span>
                                </li>
                            ))}
                        </ul>
                    )}
                </CardBody>
            </Card>
        </div>
    );
}
