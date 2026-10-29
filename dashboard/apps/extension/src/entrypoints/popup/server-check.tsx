/**
 * The answer to "is this a Polaris?", under the address field while it is typed.
 *
 * The same shape as the dashboard's username field (`username-field.tsx`): the
 * address is read locally first, so a half-typed one says nothing and a
 * malformed one is answered without a request; only a well-formed address is
 * asked about, 400 ms after the last keystroke, and a newer keystroke cancels
 * the question in flight so a slow answer never lands on a different address.
 * Answers are remembered for a short while (`lib/server-identity`), so going
 * back to an address already asked about answers at once.
 */

import { useWords } from "./words";
import { useEffect, useState } from "react";
import { looksLikeAddress, readOrigin } from "@/lib/address";
import { createServerCheck, type ServerVerdict } from "@/lib/server-identity";

const ASK_AFTER_MS = 400;

/** One memory for every field in the popup. */
const checker = createServerCheck();

export type AddressCheck =
    /** Empty, or not far enough along to be an address yet. Nothing is said. */
    | { readonly kind: "incomplete" }
    | { readonly kind: "invalid" }
    | { readonly kind: "checking"; readonly origin: string }
    | (ServerVerdict & { readonly origin: string });

function read(typed: string): AddressCheck | { kind: "ask"; origin: string } {
    if (!typed.trim()) return { kind: "incomplete" };
    const origin = readOrigin(typed);
    if (!origin) return { kind: "invalid" };
    if (!looksLikeAddress(typed)) return { kind: "incomplete" };
    const held = checker.peek(origin);
    return held ? { ...held, origin } : { kind: "ask", origin };
}

/** What is known about `typed` right now, asked again whenever it changes. */
export function useAddressCheck(typed: string): AddressCheck {
    const [state, setState] = useState<AddressCheck>({ kind: "incomplete" });

    useEffect(() => {
        const now = read(typed);
        if (now.kind !== "ask") {
            setState(now);
            return;
        }
        const { origin } = now;
        setState({ kind: "checking", origin });
        const controller = new AbortController();
        const timer = setTimeout(() => {
            checker
                .check(origin, controller.signal)
                .then((verdict) => {
                    if (!controller.signal.aborted) setState({ ...verdict, origin });
                })
                .catch(() => undefined);
        }, ASK_AFTER_MS);
        return () => {
            clearTimeout(timer);
            controller.abort();
        };
    }, [typed]);

    return state;
}

/** Whether the address may be added: a Polaris, or one only the worker can confirm. */
export function addable(check: AddressCheck): boolean {
    return check.kind === "polaris" || check.kind === "unconfirmed";
}

/** The line under the field. Nothing while there is nothing to say. */
export function AddressNote({ check }: { check: AddressCheck }): React.JSX.Element | null {
    const t = useWords();
    if (check.kind === "incomplete") return null;
    const host = check.kind === "invalid" ? "" : new URL(check.origin).host;
    const [tone, text] = ((): [string, string] => {
        switch (check.kind) {
            case "invalid":
                return ["bad", t("errors.notAnAddress")];
            case "checking":
                return ["wait", t("servers.check.checking", { host })];
            case "polaris":
                return check.name
                    ? ["good", t("servers.check.polarisNamed", { name: check.name })]
                    : ["good", t("servers.check.polaris", { host })];
            case "starting":
                return ["bad", t("servers.check.starting", { host })];
            case "not-polaris":
                return ["bad", t("servers.check.notPolaris", { host })];
            case "redirects":
                return ["bad", t("servers.check.redirects", { host })];
            case "unreachable":
                return ["bad", t("servers.check.unreachable", { host })];
            case "unconfirmed":
                return ["wait", t("servers.check.unconfirmed")];
        }
    })();
    return (
        <p className={`check ${tone}`} role="status" aria-live="polite">
            {text}
        </p>
    );
}
