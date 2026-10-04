"use client";

/**
 * The one approval card every "let this in?" screen is drawn with: who is
 * asking beside the Polaris mark, what they want to be called, the account it
 * would act for, the facts the decision rests on, what it will be able to do,
 * and Deny / Allow.
 *
 * It started as the MCP consent screen and is shared so the command line, the
 * browser extension and a vault client are asked for the same way: one place a
 * person learns to read, rather than four layouts for the same question. Every
 * word is the caller's - this draws, it says nothing of its own - so each flow
 * keeps its wording and its catalog.
 */

import type { ReactNode } from "react";
import { Check, MoreHorizontal } from "lucide-react";
import { Button, Card, CardBody, CardHeader, CardTitle, Input, PolarisMark, cn } from "@polaris/ui";

/** One decision button. */
export interface ConsentAction {
    readonly label: string;
    readonly onClick: () => void;
    readonly disabled?: boolean;
    /** Looks enabled but announces itself as not ready, for a choice the
     *  click explains (nothing ticked yet) rather than one that cannot happen. */
    readonly ariaDisabled?: boolean;
}

/**
 * The card. `requester` is the asking side's mark - a real logo when one is
 * known (a browser, a system), a plain glyph otherwise, never an imitation -
 * and is drawn joined to the Polaris mark; without one the Polaris mark stands
 * alone.
 */
export function ConsentCard({
    requester,
    title,
    subtitle,
    account,
    children,
    error,
    deny,
    allow,
    footer,
    className
}: {
    requester?: ReactNode;
    title: ReactNode;
    subtitle?: ReactNode;
    /** Already worded by the caller ("Signed in as Ada"). */
    account?: string;
    children?: ReactNode;
    error?: string | null;
    deny?: ConsentAction;
    allow?: ConsentAction;
    footer?: ReactNode;
    className?: string;
}) {
    return (
        <Card className={cn("w-full max-w-md", className)}>
            <CardHeader className="items-center text-center">
                {requester ? (
                    <div className="mb-1 flex items-center gap-2" aria-hidden>
                        <span className="grid size-11 shrink-0 place-items-center rounded-xl border border-border bg-muted/50 [&>svg]:size-6">
                            {requester}
                        </span>
                        <MoreHorizontal className="size-4 shrink-0 text-muted-foreground" />
                        <span className="grid size-11 shrink-0 place-items-center rounded-xl border border-border bg-muted/50">
                            <PolarisMark nameClassName="hidden" />
                        </span>
                    </div>
                ) : (
                    <PolarisMark className="mb-1" />
                )}
                <CardTitle className="min-w-0 max-w-full break-words [overflow-wrap:anywhere]">
                    {title}
                </CardTitle>
                {subtitle ? <p className="text-sm text-muted-foreground">{subtitle}</p> : null}
                {account ? (
                    <p
                        className="min-w-0 max-w-full truncate text-xs text-muted-foreground"
                        title={account}
                    >
                        {account}
                    </p>
                ) : null}
            </CardHeader>
            {/* A result ("Signed in.") is the header alone. */}
            {children || error || deny || allow || footer ? (
                <CardBody className="flex flex-col gap-4 text-sm">
                    {children}
                    {error ? (
                        <p role="alert" className="text-sm text-danger">
                            {error}
                        </p>
                    ) : null}
                    {deny || allow ? (
                        <div className="flex flex-wrap justify-end gap-2">
                            {deny ? (
                                <Button
                                    variant="outline"
                                    disabled={deny.disabled}
                                    onClick={deny.onClick}
                                >
                                    {deny.label}
                                </Button>
                            ) : null}
                            {allow ? (
                                <Button
                                    disabled={allow.disabled}
                                    aria-disabled={allow.ariaDisabled}
                                    onClick={allow.onClick}
                                >
                                    {allow.label}
                                </Button>
                            ) : null}
                        </div>
                    ) : null}
                    {footer ? (
                        <div className="flex items-start gap-1 text-xs text-muted-foreground">
                            {footer}
                        </div>
                    ) : null}
                </CardBody>
            ) : null}
        </Card>
    );
}

/** The facts box: label and value rows on a muted ground, with an optional
 *  note under them. A long value truncates with the whole of it on hover. */
export function ConsentFacts({
    facts,
    note
}: {
    facts: readonly { icon?: ReactNode; label: string; value: string }[];
    note?: ReactNode;
}) {
    return (
        <dl className="flex flex-col gap-2 rounded-md bg-muted/50 p-3">
            {facts.map((fact) => (
                <div key={fact.label} className="flex min-w-0 items-center gap-2">
                    {fact.icon ? (
                        <span className="grid shrink-0 place-items-center text-muted-foreground [&>svg]:size-4">
                            {fact.icon}
                        </span>
                    ) : null}
                    <dt className="shrink-0 text-muted-foreground">{fact.label}</dt>
                    <dd
                        className="ml-auto min-w-0 truncate text-right font-medium"
                        title={fact.value}
                    >
                        {fact.value}
                    </dd>
                </div>
            ))}
            {note ? <p className="text-xs text-muted-foreground">{note}</p> : null}
        </dl>
    );
}

/** What it will be able to do, read-only: a tick per thing. The MCP screen,
 *  whose scopes can be unticked, draws its own list of checkboxes instead. */
export function ConsentAbilities({ title, items }: { title: string; items: readonly string[] }) {
    return (
        <div className="flex flex-col gap-2">
            <p className="font-medium">{title}</p>
            <ul className="flex flex-col gap-1.5">
                {items.map((item) => (
                    <li key={item} className="flex min-w-0 items-start gap-2">
                        <Check className="mt-0.5 size-4 shrink-0 text-success" aria-hidden />
                        <span className="min-w-0">{item}</span>
                    </li>
                ))}
            </ul>
        </div>
    );
}

/** The short-code box a device flow starts on, before there is a request to
 *  show: the code the other device is displaying, and the button that finds it. */
export function ConsentCodeEntry({
    value,
    onChange,
    onSubmit,
    label,
    submit,
    busy
}: {
    value: string;
    onChange: (value: string) => void;
    onSubmit: () => void;
    label: string;
    submit: string;
    busy: boolean;
}) {
    return (
        <>
            <Input
                autoFocus
                value={value}
                maxLength={16}
                aria-label={label}
                className="text-center font-mono tracking-widest"
                // i18n-ignore: the shape of the code, not words
                placeholder="XXXX-XXXX"
                onChange={(event) => onChange(event.target.value)}
                onKeyDown={(event) => event.key === "Enter" && value.trim() !== "" && onSubmit()}
            />
            <Button disabled={busy || value.trim() === ""} onClick={onSubmit}>
                {submit}
            </Button>
        </>
    );
}
