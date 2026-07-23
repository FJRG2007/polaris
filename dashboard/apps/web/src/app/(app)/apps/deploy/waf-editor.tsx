"use client";

/**
 * WAF rule editor for one Deploy scope (global, project, environment, or service).
 * Edits an IP allowlist, an IP denylist, and a require-login toggle, then persists
 * them; the rules are enforced at the edge so they survive a control-plane outage.
 * Entries validate in real time against the same CIDR/IP check used server-side.
 * Saving is explicit (not auto-applied on each keystroke) because a half-entered
 * firewall rule should never reach the edge - e.g. an allowlist missing your own IP
 * would lock everyone out the moment it applied.
 */

import { useEffect, useState, useTransition } from "react";
import { isCidr, isIpAddress, type WafScopeType } from "@polaris/core";
import { Button, Dialog, DialogContent, DialogHeader, DialogTitle, Input, Switch } from "@polaris/ui";
import { Ban, Loader2, Plus, ShieldCheck, X } from "lucide-react";
import { getWafRuleAction, setWafRuleAction } from "./actions";

/** True if a trimmed entry is a valid single IP or CIDR range. */
function validEntry(value: string): boolean {
    const trimmed = value.trim();
    return isCidr(trimmed) || isIpAddress(trimmed);
}

/** An editable list of IP/CIDR entries with real-time validation and chips. */
function CidrList({
    entries,
    onChange,
    accent,
    placeholder
}: {
    entries: string[];
    onChange: (next: string[]) => void;
    accent: "allow" | "deny";
    placeholder: string;
}) {
    const [draft, setDraft] = useState("");
    const trimmed = draft.trim();
    const duplicate = entries.includes(trimmed);
    const invalid = trimmed !== "" && !validEntry(trimmed);
    const canAdd = trimmed !== "" && validEntry(trimmed) && !duplicate;

    function add() {
        if (!canAdd) return;
        onChange([...entries, trimmed]);
        setDraft("");
    }

    return (
        <div className="flex flex-col gap-2">
            <div className="flex gap-2">
                <Input
                    value={draft}
                    placeholder={placeholder}
                    onChange={(event) => setDraft(event.target.value)}
                    onKeyDown={(event) => {
                        if (event.key === "Enter") {
                            event.preventDefault();
                            add();
                        }
                    }}
                    aria-invalid={invalid}
                />
                <Button type="button" variant="secondary" onClick={add} disabled={!canAdd}>
                    <Plus className="size-4" />
                    Add
                </Button>
            </div>
            {invalid ? <p className="text-xs text-danger">Enter a valid IP address or CIDR range.</p> : null}
            {duplicate ? <p className="text-xs text-muted-foreground">Already in the list.</p> : null}
            {entries.length > 0 ? (
                <div className="flex flex-wrap gap-1.5">
                    {entries.map((entry) => (
                        <span
                            key={entry}
                            className={`inline-flex items-center gap-1 rounded-md px-2 py-1 text-xs ${
                                accent === "deny" ? "bg-danger/10 text-danger" : "bg-muted text-foreground"
                            }`}
                        >
                            {entry}
                            <button
                                type="button"
                                aria-label={`Remove ${entry}`}
                                onClick={() => onChange(entries.filter((value) => value !== entry))}
                                className="text-muted-foreground transition-colors hover:text-foreground"
                            >
                                <X className="size-3" />
                            </button>
                        </span>
                    ))}
                </div>
            ) : null}
        </div>
    );
}

export function WafEditor({
    scopeType,
    scopeId,
    description
}: {
    scopeType: WafScopeType;
    scopeId: string;
    description?: string;
}) {
    const [loaded, setLoaded] = useState(false);
    const [allow, setAllow] = useState<string[]>([]);
    const [deny, setDeny] = useState<string[]>([]);
    const [requireLogin, setRequireLogin] = useState(false);
    const [saved, setSaved] = useState<{ allow: string[]; deny: string[]; requireLogin: boolean } | null>(null);
    const [error, setError] = useState<string | null>(null);
    const [note, setNote] = useState<string | null>(null);
    const [pending, start] = useTransition();

    useEffect(() => {
        let active = true;
        setLoaded(false);
        setError(null);
        setNote(null);
        void getWafRuleAction({ scopeType, scopeId }).then((result) => {
            if (!active) return;
            const rule = result.rule ?? { ipAllowlist: [], ipDenylist: [], requireLogin: false };
            setAllow(rule.ipAllowlist);
            setDeny(rule.ipDenylist);
            setRequireLogin(rule.requireLogin);
            setSaved({ allow: rule.ipAllowlist, deny: rule.ipDenylist, requireLogin: rule.requireLogin });
            if (result.error) setError(result.error);
            setLoaded(true);
        });
        return () => {
            active = false;
        };
    }, [scopeType, scopeId]);

    const overlap = allow.find((entry) => deny.includes(entry));
    const dirty =
        saved !== null &&
        (JSON.stringify(saved.allow) !== JSON.stringify(allow) ||
            JSON.stringify(saved.deny) !== JSON.stringify(deny) ||
            saved.requireLogin !== requireLogin);

    function save() {
        setError(null);
        setNote(null);
        start(async () => {
            const result = await setWafRuleAction({ scopeType, scopeId, ipAllowlist: allow, ipDenylist: deny, requireLogin });
            if (result.error) {
                setError(result.error);
                return;
            }
            setSaved({ allow: [...allow], deny: [...deny], requireLogin });
            setNote("Firewall rules saved.");
        });
    }

    if (!loaded) {
        return (
            <div className="flex items-center gap-2 py-6 text-sm text-muted-foreground">
                <Loader2 className="size-4 animate-spin" />
                Loading firewall rules...
            </div>
        );
    }

    return (
        <div className="flex flex-col gap-5 py-2">
            {description ? <p className="text-sm text-muted-foreground">{description}</p> : null}

            <section className="flex flex-col gap-2">
                <div className="flex items-center gap-2 text-sm font-medium">
                    <ShieldCheck className="size-4 text-muted-foreground" />
                    IP allowlist
                </div>
                <p className="text-xs text-muted-foreground">
                    If set, only these addresses can reach the service. Enforced natively at the edge.
                </p>
                <CidrList entries={allow} onChange={setAllow} accent="allow" placeholder="e.g. 203.0.113.0/24 or 10.0.0.5" />
            </section>

            <section className="flex flex-col gap-2">
                <div className="flex items-center gap-2 text-sm font-medium">
                    <Ban className="size-4 text-muted-foreground" />
                    IP denylist
                </div>
                <p className="text-xs text-muted-foreground">
                    These addresses are always blocked, even if they match the allowlist.
                </p>
                <CidrList entries={deny} onChange={setDeny} accent="deny" placeholder="e.g. 198.51.100.7 or 192.0.2.0/24" />
            </section>

            <section className="flex items-start justify-between gap-4">
                <div>
                    <div className="text-sm font-medium">Require a Polaris login</div>
                    <p className="text-xs text-muted-foreground">
                        Visitors must sign in to Polaris to reach the service. Existing sessions keep working if
                        the control plane is down; new sign-ins need it reachable.
                    </p>
                </div>
                <Switch checked={requireLogin} onChange={setRequireLogin} aria-label="Require a Polaris login" />
            </section>

            {overlap ? (
                <p className="text-xs text-danger">&quot;{overlap}&quot; is in both the allow and deny lists.</p>
            ) : null}
            {error ? <p className="text-sm text-danger">{error}</p> : null}
            {note && !dirty ? <p className="text-sm text-success">{note}</p> : null}

            <div className="flex items-center gap-3">
                <Button type="button" onClick={save} disabled={!dirty || pending || Boolean(overlap)}>
                    {pending ? <Loader2 className="size-4 animate-spin" /> : null}
                    Save firewall rules
                </Button>
                <p className="text-xs text-muted-foreground">
                    Remote-server apps apply on their next deploy; the local edge applies instantly.
                </p>
            </div>
        </div>
    );
}

/** One selectable scope in the WAF dialog. */
export interface WafDialogScope {
    readonly type: WafScopeType;
    readonly id: string;
    readonly label: string;
    readonly description?: string;
}

/** A dialog wrapping the editor, with a selector when more than one scope applies
 *  (e.g. project vs environment). Broader scopes stack with a service's own rule:
 *  allowlists narrow, denylists and require-login add up. */
export function WafDialog({
    open,
    onOpenChange,
    title,
    scopes
}: {
    open: boolean;
    onOpenChange: (open: boolean) => void;
    title: string;
    scopes: readonly WafDialogScope[];
}) {
    const [active, setActive] = useState(0);
    const scope = scopes[Math.min(active, scopes.length - 1)];
    if (!scope) return null;
    return (
        <Dialog open={open} onOpenChange={onOpenChange}>
            <DialogContent className="max-w-lg">
                <DialogHeader>
                    <DialogTitle className="flex items-center gap-2">
                        <ShieldCheck className="size-4" />
                        {title}
                    </DialogTitle>
                </DialogHeader>
                {scopes.length > 1 ? (
                    <div
                        className="grid gap-1 rounded-md bg-muted p-1 text-sm"
                        style={{ gridTemplateColumns: `repeat(${scopes.length}, minmax(0, 1fr))` }}
                    >
                        {scopes.map((option, index) => (
                            <button
                                key={`${option.type}:${option.id}`}
                                type="button"
                                onClick={() => setActive(index)}
                                className={`rounded px-3 py-1.5 font-medium transition-colors ${
                                    index === active
                                        ? "bg-background text-foreground shadow-sm"
                                        : "text-muted-foreground hover:text-foreground"
                                }`}
                            >
                                {option.label}
                            </button>
                        ))}
                    </div>
                ) : null}
                <WafEditor key={`${scope.type}:${scope.id}`} scopeType={scope.type} scopeId={scope.id} description={scope.description} />
            </DialogContent>
        </Dialog>
    );
}
