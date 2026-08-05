"use client";

/**
 * The domains one owner has brought, and the two records each one needs.
 *
 * Shared by the account screen and an organization's, because the thing being
 * managed is the same and only the owner differs. That matters beyond saving a
 * file: the DNS instructions are the part people get wrong, and two copies of
 * them would eventually disagree about what to publish.
 *
 * A domain in progress shows exactly the records that are missing, with the
 * values copyable, because the next thing whoever added it does is paste them
 * into a registrar's form in another tab. "Not verified" on its own sends people
 * back here to guess.
 */

import { useState } from "react";
import { runAction } from "@/lib/run-action";
import { CopyButton } from "@/components/copy-button";
import { useConfirm } from "@/components/confirm-dialog";
import type { OwnerDomainView } from "@/lib/owner-domains";
import { useDisplayFormat } from "@/components/display-format";
import { CheckCircle2, Clock, Globe, Plus, RefreshCw, Trash2 } from "lucide-react";
import { Badge, Button, Card, CardBody, CardHeader, CardTitle, Input } from "@polaris/ui";
import {
    addOwnerDomainAction,
    checkOwnerDomainAction,
    removeOwnerDomainAction,
    type DomainOwnerRef
} from "@/app/(app)/account/domains/actions";

export function OwnerDomainsView({
    owner,
    domains: initial,
    canAdd,
    blockedReason,
    publicIp
}: {
    owner: DomainOwnerRef;
    domains: OwnerDomainView[];
    canAdd: boolean;
    /** Why the form is not offered, when it is not. */
    blockedReason: string;
    /** The address the wildcard has to point at. Null when this Polaris has not
     *  worked out its own public address, in which case the record is described
     *  rather than given - a wrong address pasted into a registrar is worse than
     *  a sentence saying to look it up. */
    publicIp: string | null;
}) {
    const [confirm, confirmElement] = useConfirm();
    const [domains, setDomains] = useState(initial);
    const [value, setValue] = useState("");
    const [busy, setBusy] = useState(false);
    const [error, setError] = useState("");

    // The list is kept here rather than re-read from the server on every check,
    // so pressing Check on one domain does not blank the others while a DNS
    // lookup that can take seconds is in flight.
    const replace = (next: OwnerDomainView) =>
        setDomains((current) => current.map((entry) => (entry.id === next.id ? next : entry)));

    return (
        <div className="flex flex-col gap-4">
            {error && (
                <p role="alert" className="bg-danger/10 text-danger rounded-md px-3 py-2 text-sm">
                    {error}
                </p>
            )}

            {domains.length === 0 ? (
                <Card>
                    <CardBody className="flex flex-col items-center gap-2 py-10 text-center">
                        <Globe className="text-muted-foreground size-6 shrink-0" />
                        <p className="text-sm font-medium">No domain of your own yet</p>
                        <p className="text-muted-foreground max-w-md text-sm">
                            Add one you already own and Polaris will give services here hostnames under it. Until
                            then they take this Polaris&rsquo;s own domains.
                        </p>
                    </CardBody>
                </Card>
            ) : (
                domains.map((entry) => (
                    <DomainCard
                        key={entry.id}
                        owner={owner}
                        domain={entry}
                        publicIp={publicIp}
                        confirm={confirm}
                        onChecked={replace}
                        onRemoved={(id) => setDomains((current) => current.filter((row) => row.id !== id))}
                        onError={setError}
                    />
                ))
            )}

            {canAdd ? (
                <Card>
                    <CardHeader>
                        <CardTitle>Add a domain</CardTitle>
                    </CardHeader>
                    <CardBody>
                        <form
                            className="flex flex-wrap items-end gap-2"
                            onSubmit={async (event) => {
                                event.preventDefault();
                                if (!value.trim()) return;
                                setBusy(true);
                                setError("");
                                const result = await runAction(
                                    () => addOwnerDomainAction(owner, value.trim()),
                                    setError
                                );
                                setBusy(false);
                                if (!result || result.error) {
                                    if (result?.error) setError(result.error);
                                    return;
                                }
                                if (result.domain) setDomains((current) => [...current, result.domain!]);
                                setValue("");
                            }}
                        >
                            <label className="text-muted-foreground flex min-w-56 flex-1 flex-col gap-1 text-xs">
                                Domain
                                <Input
                                    value={value}
                                    placeholder="example.com"
                                    className="h-9"
                                    onChange={(event) => setValue(event.target.value)}
                                />
                            </label>
                            <Button type="submit" size="sm" disabled={busy || !value.trim()}>
                                <Plus className="size-4 shrink-0" /> Add
                            </Button>
                            <p className="text-muted-foreground w-full text-xs">
                                A domain or a subdomain you have delegated - `example.com` or `apps.example.com`.
                                Polaris will show you the two records to publish.
                            </p>
                        </form>
                    </CardBody>
                </Card>
            ) : (
                <p className="text-muted-foreground text-sm">{blockedReason}</p>
            )}
            {confirmElement}
        </div>
    );
}

function DomainCard({
    owner,
    domain,
    publicIp,
    confirm,
    onChecked,
    onRemoved,
    onError
}: {
    owner: DomainOwnerRef;
    domain: OwnerDomainView;
    publicIp: string | null;
    confirm: ReturnType<typeof useConfirm>[0];
    onChecked: (domain: OwnerDomainView) => void;
    onRemoved: (id: string) => void;
    onError: (message: string) => void;
}) {
    const format = useDisplayFormat();
    const [busy, setBusy] = useState(false);

    const ready = domain.verified && domain.wildcardOk;

    return (
        <Card>
            <CardHeader className="flex-row flex-wrap items-center justify-between gap-2">
                <CardTitle className="flex items-center gap-2">
                    <Globe className="size-4 shrink-0" />
                    {domain.domain}
                    {ready ? (
                        <Badge variant="primary">
                            <CheckCircle2 className="size-3 shrink-0" /> Ready
                        </Badge>
                    ) : (
                        <Badge variant="neutral">
                            <Clock className="size-3 shrink-0" /> Waiting on DNS
                        </Badge>
                    )}
                </CardTitle>
                <div className="flex shrink-0 items-center gap-1">
                    <Button
                        size="sm"
                        variant="ghost"
                        disabled={busy}
                        aria-label={`Check ${domain.domain}`}
                        title="Check DNS now"
                        onClick={async () => {
                            setBusy(true);
                            onError("");
                            const result = await runAction(() => checkOwnerDomainAction(owner, domain.id), onError);
                            setBusy(false);
                            if (result?.domain) onChecked(result.domain);
                            else if (result?.error) onError(result.error);
                        }}
                    >
                        <RefreshCw className={busy ? "size-4 shrink-0 animate-spin" : "size-4 shrink-0"} />
                        Check
                    </Button>
                    <Button
                        size="sm"
                        variant="ghost"
                        disabled={busy}
                        aria-label={`Remove ${domain.domain}`}
                        title="Remove"
                        onClick={async () => {
                            const ok = await confirm({
                                title: `Remove ${domain.domain}?`,
                                description:
                                    "New services stop being offered hostnames under it. Anything already deployed on one keeps its address until you change it.",
                                confirmLabel: "Remove",
                                danger: true
                            });
                            if (!ok) return;
                            setBusy(true);
                            const result = await runAction(() => removeOwnerDomainAction(owner, domain.id), onError);
                            setBusy(false);
                            if (result && !result.error) onRemoved(domain.id);
                            else if (result?.error) onError(result.error);
                        }}
                    >
                        <Trash2 className="size-4 shrink-0" />
                    </Button>
                </div>
            </CardHeader>
            <CardBody className="flex flex-col gap-3">
                {domain.detail && <p className="text-muted-foreground text-sm">{domain.detail}</p>}

                {!ready && (
                    <div className="flex flex-col gap-2">
                        <Record
                            done={domain.verified}
                            type="TXT"
                            name={domain.txtName}
                            value={domain.txtValue}
                            note="Proves the domain is yours."
                        />
                        <Record
                            done={domain.wildcardOk}
                            type="A"
                            name={domain.wildcard}
                            value={publicIp ?? "this server's public address"}
                            note="Makes every hostname Polaris mints under it arrive here."
                        />
                    </div>
                )}

                <p className="text-muted-foreground text-xs">
                    {domain.checkedAt ? `Last checked ${format.dateTime(domain.checkedAt)}.` : "Not checked yet."}
                </p>
            </CardBody>
        </Card>
    );
}

/** One DNS record to publish. The value is copyable because the next thing that
 *  happens to it is being pasted into a registrar's form. */
function Record({
    done,
    type,
    name,
    value,
    note
}: {
    done: boolean;
    type: string;
    name: string;
    value: string;
    note: string;
}) {
    return (
        <div className="border-border bg-surface/40 flex flex-wrap items-center gap-2 rounded-md border px-3 py-2">
            {done ? (
                <CheckCircle2 className="text-primary size-4 shrink-0" />
            ) : (
                <Clock className="text-muted-foreground size-4 shrink-0" />
            )}
            <Badge variant="neutral">{type}</Badge>
            <code className="min-w-0 flex-1 truncate text-xs" title={name}>
                {name}
            </code>
            <CopyButton value={name} label={`Copy ${name}`} />
            <code className="text-muted-foreground min-w-0 max-w-full truncate text-xs" title={value}>
                {value}
            </code>
            {/* The address is resolved by the server and is not a fixed string,
                so only the value that actually is one can be copied. */}
            {value.includes(" ") ? null : <CopyButton value={value} label={`Copy ${value}`} />}
            <p className="text-muted-foreground w-full text-xs">{note}</p>
        </div>
    );
}
