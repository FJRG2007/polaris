"use client";

/**
 * One way in for every AI connection on a screen: a provider key, a subscription
 * sign-in, a cloud account and an agent's account were four cards with four Add
 * buttons, and somebody connecting Claude had to know which of them it was before
 * they could start. Here they pick what they are connecting first and how second.
 *
 * Each existing flow keeps its own dialog. What this adds is the registry they
 * open through: a flow mounted inside the hub registers what it can open, and
 * hides the button it used to draw for itself.
 */

import { createContext, useCallback, useContext, useEffect, useMemo, useRef, useState, type ReactNode } from "react";

/** What a connection is made with, which is which existing dialog opens: a
 *  provider key, a subscription sign-in, a cloud account, a credential an agent
 *  signs in with, or an agent's own login kept on the machine. */
export type ConnectionMethod = "key" | "login" | "cloud" | "account" | "home";

/** One thing that can be connected, one way. */
export interface ConnectionOption {
    method: ConnectionMethod;
    /** The slug the flow opens with. */
    slug: string;
    /** Its own name: "SuperGrok", "Amazon Bedrock", "Claude subscription token". */
    name: string;
    /** Who makes it, to group the ways into one: "xAI", "Anthropic". */
    vendor: string;
    /** What else somebody might type looking for it. */
    aliases?: readonly string[];
}

/** Opens one flow, optionally on a slug: a provider row for a key, a login, a cloud. */
export type ConnectionOpener = (slug?: string, row?: unknown) => void;

interface Hub {
    register(method: ConnectionMethod, opener: ConnectionOpener, options: readonly ConnectionOption[]): () => void;
    open(method: ConnectionMethod, slug?: string, row?: unknown): void;
    options: readonly ConnectionOption[];
    methods: ReadonlySet<ConnectionMethod>;
}

const HubContext = createContext<Hub | null>(null);

/** Whether a flow is mounted inside a hub, which then draws its Add button. */
export function useConnectionHub(): Hub | null {
    return useContext(HubContext);
}

export function ConnectionHub({ children }: { children: ReactNode }) {
    const openers = useRef(new Map<ConnectionMethod, ConnectionOpener>());
    const [registered, setRegistered] = useState<Map<ConnectionMethod, readonly ConnectionOption[]>>(new Map());

    const register = useCallback(
        (method: ConnectionMethod, opener: ConnectionOpener, options: readonly ConnectionOption[]) => {
            openers.current.set(method, opener);
            setRegistered((current) => new Map(current).set(method, options));
            return () => {
                if (openers.current.get(method) === opener) openers.current.delete(method);
                setRegistered((current) => {
                    const next = new Map(current);
                    next.delete(method);
                    return next;
                });
            };
        },
        []
    );

    const open = useCallback((method: ConnectionMethod, slug?: string, row?: unknown) => {
        openers.current.get(method)?.(slug, row);
    }, []);

    const hub = useMemo<Hub>(
        () => ({
            register,
            open,
            options: [...registered.values()].flat(),
            methods: new Set(registered.keys())
        }),
        [register, open, registered]
    );

    return <HubContext.Provider value={hub}>{children}</HubContext.Provider>;
}

/**
 * Register a flow with the hub it is mounted in, if any. Returns whether it is,
 * which is whether the flow should hide its own button. The opener is read
 * through a ref so a re-render does not re-register it.
 */
export function useHubFlow(
    method: ConnectionMethod,
    opener: ConnectionOpener,
    options: readonly ConnectionOption[]
): boolean {
    const hub = useConnectionHub();
    const latest = useRef(opener);
    latest.current = opener;
    const register = hub?.register;
    // Options are static per mount; their content, not identity, is what counts.
    const signature = JSON.stringify(options);
    useEffect(() => {
        if (!register) return;
        return register(method, (slug, row) => latest.current(slug, row), JSON.parse(signature) as ConnectionOption[]);
    }, [register, method, signature]);
    return hub !== null;
}

/** The key a vendor's ways are grouped under: its name, folded. Pure. */
export function vendorKey(vendor: string): string {
    return vendor
        .toLowerCase()
        .normalize("NFKD")
        .replace(/[^a-z0-9]/g, "");
}
