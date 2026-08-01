"use client";

/**
 * The addresses this deployment answers on, and what can be done about each.
 *
 * Two pages show the same list for different reasons - Settings, where it is one of
 * the deployment's facts, and Domains, where it is the thing being edited - so the
 * rows, the health marks and the removal live here rather than in both.
 *
 * What a removal means depends on what the address is, and the server decides that:
 * a tunnel is torn down (its URL is minted per run and never comes back), a
 * configured domain is cleared from whichever setting holds it, and the install URL,
 * the LAN name and a zone hostname are not list entries to delete at all.
 */

import { useState } from "react";
import { Button } from "@polaris/ui";
import type { DisplayFormat } from "@polaris/core";
import { CopyButton } from "@/components/copy-button";
import type { CheckedAddress } from "@/lib/address-health";
import { useDisplayFormat } from "@/components/display-format";
import { removeAddressAction } from "@/app/(app)/admin/domains/actions";
import { ExternalLink, Loader2, Settings2, TriangleAlert, X } from "lucide-react";

/** What each kind of address is, said once next to it. */
const ADDRESS_KINDS: Record<CheckedAddress["kind"], string> = {
    app: "configured at install",
    local: "local network",
    domain: "domain",
    tunnel: "tunnel"
};

/** Why an address is marked down, and how long ago that was found out. */
function downDetail(health: CheckedAddress["health"], format: DisplayFormat): string {
    const checked = health.checkedAt ? new Date(health.checkedAt) : null;
    const when = checked && !Number.isNaN(checked.getTime()) ? `, checked ${format.dateTime(checked)}` : "";
    return `${health.detail ?? "Nothing answered"}${when}`;
}

export function AddressList({
    addresses,
    onChanged,
    manageHref
}: {
    addresses: readonly CheckedAddress[];
    /** The list as it stands after a removal, so the caller stays the owner of it. */
    onChanged: (next: CheckedAddress[]) => void;
    /** Where a configured domain is edited, when that is somewhere other than here. */
    manageHref?: string;
}) {
    const format = useDisplayFormat();
    const [removing, setRemoving] = useState<string | null>(null);
    const [error, setError] = useState<string | null>(null);

    async function remove(host: string): Promise<void> {
        setRemoving(host);
        setError(null);
        try {
            const result = await removeAddressAction(host);
            onChanged(result.addresses);
            if (result.error) setError(result.error);
        } catch {
            setError("Could not change this deployment's addresses.");
        } finally {
            setRemoving(null);
        }
    }

    if (addresses.length === 0) return <p className="text-sm">No address is configured for this deployment.</p>;

    return (
        <div className="flex flex-col gap-1.5">
            {addresses.map((address) => (
                <AddressRow
                    key={address.host}
                    address={address}
                    format={format}
                    manageHref={manageHref}
                    removing={removing === address.host}
                    onRemove={() => void remove(address.host)}
                />
            ))}
            {error ? <p className="text-xs text-danger">{error}</p> : null}
        </div>
    );
}

/**
 * One address. Removal asks first: it is one press away from a name Polaris stops
 * answering on, which may well be the one the page is being read over.
 */
function AddressRow({
    address,
    format,
    manageHref,
    removing,
    onRemove
}: {
    address: CheckedAddress;
    format: DisplayFormat;
    manageHref?: string;
    removing: boolean;
    onRemove: () => void;
}) {
    const [confirm, setConfirm] = useState(false);
    const down = address.health.state === "down";
    const removable = address.kind === "domain" || address.kind === "tunnel";

    return (
        <div className="flex flex-col gap-1">
            <div className="flex items-center gap-2 text-sm">
                <a
                    className={`truncate font-medium hover:underline ${down ? "text-muted-foreground" : "text-primary"}`}
                    href={address.url}
                    target="_blank"
                    rel="noreferrer"
                >
                    {address.url}
                </a>
                <ExternalLink className="size-3 shrink-0 text-muted-foreground" />
                <span className="shrink-0 text-xs text-muted-foreground">{ADDRESS_KINDS[address.kind]}</span>
                {down ? (
                    <span
                        className="flex shrink-0 items-center gap-1 text-xs text-warning"
                        title={downDetail(address.health, format)}
                    >
                        <TriangleAlert className="size-3" />
                        not answering
                    </span>
                ) : null}
                <div className="ml-auto flex shrink-0 items-center gap-1">
                    <CopyButton value={address.url} label={address.host} />
                    {manageHref && address.kind === "domain" ? (
                        <a
                            href={manageHref}
                            aria-label={`Manage ${address.host}`}
                            title="Manage in Domains"
                            className="rounded p-1.5 text-muted-foreground transition-colors hover:bg-muted hover:text-foreground"
                        >
                            <Settings2 className="size-3.5" />
                        </a>
                    ) : null}
                    {removable && !confirm ? (
                        <button
                            type="button"
                            onClick={() => setConfirm(true)}
                            aria-label={`Stop using ${address.host}`}
                            title={address.kind === "tunnel" ? "Close the tunnel" : "Stop using this domain"}
                            className="rounded p-1.5 text-muted-foreground transition-colors hover:bg-muted hover:text-danger"
                        >
                            <X className="size-3.5" />
                        </button>
                    ) : null}
                </div>
            </div>
            {address.kind === "tunnel" ? (
                <p className="text-xs text-muted-foreground">
                    Temporary: this URL is minted each time the tunnel starts and cannot be brought back once it stops.
                    Configure a domain for an address that lasts.
                </p>
            ) : null}
            {confirm ? (
                <div className="flex flex-wrap items-center gap-2 text-xs text-muted-foreground">
                    {address.kind === "tunnel"
                        ? "Close the tunnel? Links already handed out on this URL stop working."
                        : "Stop answering on this domain?"}
                    <Button variant="danger" size="sm" disabled={removing} onClick={onRemove}>
                        {removing ? <Loader2 className="size-3.5 animate-spin" /> : null} Confirm
                    </Button>
                    <Button variant="ghost" size="sm" onClick={() => setConfirm(false)}>
                        Cancel
                    </Button>
                </div>
            ) : null}
        </div>
    );
}
