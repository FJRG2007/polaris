"use client";

/**
 * Which clients an API key answers to: an allow list, and a deny list that wins
 * over it.
 *
 * The sibling of the network editor. Where that one says which addresses a key
 * may be used from, this says what may be using it - a key minted for one
 * deployment script has no business being replayed out of a browser, and a key
 * that only ever runs from CI can now say so.
 *
 * Worth being plain about on the screen: a user-agent is written by whoever
 * makes the request. This narrows a credential that has already been proven; it
 * is not what proves one.
 *
 * Controlled - the parent owns the value.
 */

import { RuleListInput } from "@/components/rule-list-input";
import { userAgentMatches, USER_AGENT_PATTERN_MAX, type UserAgentRules } from "@polaris/core";

export const EMPTY_CLIENT_RULES: UserAgentRules = {
    allowedUserAgents: [],
    deniedUserAgents: []
};

/** Whether a value restricts anything at all, for a summary line. */
export function clientRulesAreEmpty(value: UserAgentRules): boolean {
    return value.allowedUserAgents.length === 0 && value.deniedUserAgents.length === 0;
}

/** A pattern is anything non-empty and not absurdly long: what it matches is
 *  decided at request time, and there is no shape to check it against. */
function validatePattern(draft: string): { value: string } | { error: string } {
    const pattern = draft.trim();
    if (!pattern) return { error: "Enter a pattern." };
    if (pattern.length > USER_AGENT_PATTERN_MAX) {
        return { error: `Keep it under ${USER_AGENT_PATTERN_MAX} characters.` };
    }
    return { value: pattern };
}

export function ClientRulesEditor({
    value,
    onChange
}: {
    value: UserAgentRules;
    onChange: (next: UserAgentRules) => void;
}) {
    return (
        <div className="flex flex-col gap-3">
            <RuleListInput
                label="Only these clients"
                placeholder="curl"
                hint="Matched anywhere in the client's user-agent, ignoring case. Use * for any run of characters. Leave empty to allow any client."
                values={value.allowedUserAgents}
                validate={validatePattern}
                onChange={(allowedUserAgents) => onChange({ ...value, allowedUserAgents })}
            />
            <RuleListInput
                label="Never these clients"
                placeholder="Mozilla*"
                tone="deny"
                hint="Refused even when they match the list above."
                values={value.deniedUserAgents}
                validate={validatePattern}
                onChange={(deniedUserAgents) => onChange({ ...value, deniedUserAgents })}
            />
            {!clientRulesAreEmpty(value) ? <ClientRulesPreview value={value} /> : null}
        </div>
    );
}

/**
 * What the rules would do to the browser filling the form in.
 *
 * A pattern list is easy to get subtly wrong and impossible to test after the
 * fact without locking a key out, so the one client that is certainly at hand is
 * checked against it as it is typed. A key that would refuse this browser is
 * usually the intent; a key that would refuse everything is not.
 */
function ClientRulesPreview({ value }: { value: UserAgentRules }) {
    const client = typeof navigator === "undefined" ? "" : navigator.userAgent;
    const denied = value.deniedUserAgents.some((pattern) => userAgentMatches(client, pattern));
    const allowed =
        value.allowedUserAgents.length === 0 ||
        value.allowedUserAgents.some((pattern) => userAgentMatches(client, pattern));

    return (
        <p className="text-xs text-muted-foreground">
            {denied || !allowed
                ? "The browser you are using now would be refused. That is fine for a key meant for a script."
                : "The browser you are using now would be accepted."}
        </p>
    );
}
