"use client";

/**
 * Picking the agent a session runs.
 *
 * A plain listbox was what this was, and it was wrong on both counts. It listed
 * eleven tools as bare names, which is the one list where the name is the LEAST
 * recognisable thing about each entry - people know these by their marks - and it
 * said nothing at all about whether the one being picked could actually sign in.
 * A person picked Claude Code, pressed Start, and got a session that came up at a
 * login prompt inside a container nobody would ever look at.
 *
 * So it is the provider picker's shape, for the provider picker's reason, plus
 * the one thing a provider never needs: each row says whether this account can
 * sign that tool in, and the row that cannot says what would.
 */

import { Badge, Button, Input } from "@polaris/ui";
import { AgentLogo } from "@/components/logos";
import Link from "next/link";
import { Check, Search } from "lucide-react";
import { useEffect, useMemo, useRef, useState } from "react";
import type { AgentChoice } from "@/lib/agents/agent-readiness";

/** What a row can be told about signing in, and how loudly.
 *
 *  `unknown` says nothing on purpose. It is a tool Polaris holds no sourced
 *  credential for, so both "ready" and "not linked" would be claims nobody
 *  checked - and a badge is exactly the shape people read as checked. */
const READY_BADGE = {
    ready: null,
    missing: { label: "Not linked", variant: "warning" as const },
    unknown: null
};

/** An entry for a tool that is not in the catalogue. Carried here rather than by
 *  the caller so every screen that picks an agent offers it on the same terms. */
export const CUSTOM_CHOICE: AgentChoice = {
    id: "custom",
    label: "Something else",
    vendor: "",
    install: null,
    docs: "",
    // Polaris knows nothing about a command somebody typed, including what signs
    // it in. Never blocks, and never claims to be ready.
    readiness: "unknown",
    missing: []
};

export function AgentSelect({
    options,
    value,
    onChange,
    disabled
}: {
    options: AgentChoice[];
    value: string;
    onChange: (id: string) => void;
    disabled?: boolean;
}) {
    const [open, setOpen] = useState(false);
    const [query, setQuery] = useState("");
    const box = useRef<HTMLDivElement>(null);

    // On an outside press rather than on blur: blur fires as the pointer goes
    // down on a row, which would close the list before the click landed.
    useEffect(() => {
        if (!open) return;
        const onPointerDown = (event: PointerEvent) => {
            if (!box.current?.contains(event.target as Node)) setOpen(false);
        };
        document.addEventListener("pointerdown", onPointerDown);
        return () => document.removeEventListener("pointerdown", onPointerDown);
    }, [open]);

    const results = useMemo(() => {
        const needle = query.trim().toLowerCase();
        if (!needle) return options;
        // The vendor counts: people look for Codex by typing "openai" at least as
        // often as by typing its name, and for Droid by typing "factory".
        return options.filter((option) =>
            [option.label, option.vendor, option.id].some((term) => term.toLowerCase().includes(needle))
        );
    }, [options, query]);

    const chosen = options.find((option) => option.id === value) ?? null;

    return (
        <div className="relative" ref={box}>
            <button
                type="button"
                disabled={disabled}
                aria-haspopup="listbox"
                aria-expanded={open}
                onClick={() => setOpen((was) => !was)}
                className="border-border bg-surface flex h-9 w-full items-center gap-2 rounded-md border px-3 py-2 text-sm disabled:cursor-not-allowed disabled:opacity-50"
            >
                {chosen ? <AgentLogo id={chosen.id} label={chosen.label} className="size-4 shrink-0" /> : null}
                <span className="min-w-0 flex-1 truncate text-left" title={chosen?.label ?? undefined}>
                    {chosen?.label ?? "Pick an agent"}
                </span>
                {chosen && READY_BADGE[chosen.readiness] ? (
                    <Badge variant={READY_BADGE[chosen.readiness]!.variant} className="shrink-0">
                        {READY_BADGE[chosen.readiness]!.label}
                    </Badge>
                ) : null}
            </button>

            {open ? (
                <div className="bg-elevated absolute z-50 mt-1 w-full rounded-md border border-border-strong shadow-popover">
                    <div className="flex items-center gap-2 border-b border-border px-3 py-2">
                        <Search className="text-muted-foreground size-4 shrink-0" />
                        <Input
                            autoFocus
                            value={query}
                            onChange={(event) => setQuery(event.target.value)}
                            placeholder="Search agents"
                            bare
                            className="h-7"
                        />
                    </div>
                    <div className="max-h-64 overflow-y-auto p-1" role="listbox">
                        {results.map((option) => {
                            const badge = READY_BADGE[option.readiness];
                            return (
                                <Button
                                    key={option.id}
                                    type="button"
                                    variant="ghost"
                                    role="option"
                                    aria-selected={option.id === value}
                                    onClick={() => {
                                        onChange(option.id);
                                        setQuery("");
                                        setOpen(false);
                                    }}
                                    className="h-auto w-full justify-start gap-2 px-2 py-1.5 text-left font-normal"
                                >
                                    <Check
                                        className={`size-4 shrink-0 ${option.id === value ? "opacity-100" : "opacity-0"}`}
                                    />
                                    <AgentLogo id={option.id} label={option.label} className="size-4 shrink-0" />
                                    <span className="min-w-0 flex-1 truncate" title={option.label}>
                                        {option.label}
                                    </span>
                                    {option.vendor ? (
                                        <span className="text-muted-foreground shrink-0 text-xs">{option.vendor}</span>
                                    ) : null}
                                    {badge ? (
                                        <Badge variant={badge.variant} className="shrink-0">
                                            {badge.label}
                                        </Badge>
                                    ) : null}
                                </Button>
                            );
                        })}
                        {results.length === 0 ? (
                            <p className="text-muted-foreground px-3 py-6 text-center text-sm">Nothing matches.</p>
                        ) : null}
                    </div>
                </div>
            ) : null}
        </div>
    );
}

/**
 * What to do about an agent nothing here can sign in.
 *
 * The whole point of this component is that it is not an error. Nothing has gone
 * wrong and nobody has done anything: this account simply has not linked the
 * credential this tool signs in with, which is an entirely ordinary state for a
 * tool somebody has never used here before. So it reads as the next step rather
 * than as a failure, it names the credential in the vendor's own words, and it
 * goes to the screen that takes one.
 *
 * A session on a server is the case worth calling out separately. That machine
 * may already have the tool signed in as the person who owns it, in which case
 * there is genuinely nothing to link and Polaris is simply unable to see it -
 * which the copy has to say, because insisting otherwise would be Polaris being
 * confidently wrong about somebody else's computer.
 */
export function SignInNotice({ agent }: { agent: AgentChoice }) {
    return (
        <div className="space-y-2 rounded-md border border-warning/40 bg-warning/10 p-3">
            <p className="text-sm">Nothing here signs {agent.label} in.</p>
            <p className="text-xs text-muted-foreground">
                On this box it would start and sit at its own login prompt, where nobody would ever answer it. Sign it
                in under AI keys - Polaris runs the sign-in for you and supplies the machine - or run it on a server
                you have already signed it in on.
            </p>
            <p className="text-xs text-muted-foreground">
                It takes {agent.missing.map((credential) => credential.label.toLowerCase()).join(" or ")}.
            </p>
            <Link href="/account/ai-keys" className="inline-block text-xs underline">
                Sign in under AI keys
            </Link>
        </div>
    );
}
