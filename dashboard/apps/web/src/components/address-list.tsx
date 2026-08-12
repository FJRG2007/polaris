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
import { ConfirmDeleteDialog } from "@polaris/ui";
import type { DisplayFormat } from "@polaris/core";
import { CopyButton } from "@/components/copy-button";
import type { CheckedAddress } from "@/lib/address-health";
import { useDisplayFormat } from "@/components/display-format";
import { removeAddressAction } from "@/app/(app)/admin/domains/actions";
import { ExternalLink, Settings2, TriangleAlert, X } from "lucide-react";

/** What each kind of address is, said once next to it. */
const ADDRESS_KINDS: Record<CheckedAddress["kind"], string> = {
    app: "configured at install",
    local: "local network",
    domain: "domain",
    tunnel: "tunnel"
};

/** What removing an address actually costs, said before it happens. */
const REMOVAL_DETAIL = {
    tunnel: "Links already handed out on this URL stop working. The next tunnel is minted under a different name.",
    domain: "Polaris stops answering on it. The domain itself is untouched, and configuring it again brings it back."
} as const;

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
    // Kept against the host it happened to, so the failure is read inside the
    // dialog that asked - the one place the reader is looking when it comes back.
    const [error, setError] = useState<{ host: string; message: string; } | null>(null);

    /** Whether the address is gone, so the row can close its confirmation. */
    async function remove(host: string): Promise<boolean> {
        setRemoving(host);
        setError(null);
        try {
            const result = await removeAddressAction(host);
            onChanged(result.addresses);
            if (result.error) setError({ host, message: result.error });
            return !result.error;
        } catch {
            setError({ host, message: "Could not change this deployment's addresses." });
            return false;
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
                    error={error?.host === address.host ? error.message : null}
                    onRemove={() => remove(address.host)}
                />
            ))}
        </div>
    );
}

/**
 * One address. Removal asks in a dialog first: it is one press away from a name
 * Polaris stops answering on, which may well be the one the page is being read
 * over, and the question has to be answered rather than scrolled past. Typing the
 * name is not asked for - nothing here holds anyone's work: a domain is configured
 * again, a tunnel reopens, and only the old tunnel URL is gone for good.
 */
function AddressRow({
    address,
    format,
    manageHref,
    removing,
    error,
    onRemove
}: {
    address: CheckedAddress;
    format: DisplayFormat;
    manageHref?: string;
    removing: boolean;
    error: string | null;
    onRemove: () => Promise<boolean>;
}) {
    const [confirming, setConfirming] = useState(false);
    const tunnel = address.kind === "tunnel";
    const down = address.health.state === "down";
    const removable = address.kind === "domain" || tunnel;
    /** The same words on the control and on the dialog it opens. */
    const action = tunnel ? "Close the tunnel" : "Stop using this domain";

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
                    {removable ? (
                        <button
                            type="button"
                            onClick={() => setConfirming(true)}
                            aria-label={`Stop using ${address.host}`}
                            title={action}
                            className="rounded p-1.5 text-muted-foreground transition-colors hover:bg-muted hover:text-danger"
                        >
                            <X className="size-3.5" />
                        </button>
                    ) : null}
                </div>
            </div>
            {tunnel ? (
                <p className="text-xs text-muted-foreground">
                    Temporary: this URL is minted each time the tunnel starts and cannot be brought back once it stops.
                    Configure a domain for an address that lasts.
                </p>
            ) : null}

            {removable ? (
                <ConfirmDeleteDialog
                    open={confirming}
                    onOpenChange={(open) => !removing && setConfirming(open)}
                    name={address.host}
                    kind={tunnel ? "tunnel" : "domain"}
                    requireTyping={false}
                    title={action}
                    question={
                        <>
                            {tunnel ? "Close the tunnel on " : "Stop answering on "}
                            <span className="font-medium text-foreground">{address.host}</span>?
                        </>
                    }
                    description={REMOVAL_DETAIL[tunnel ? "tunnel" : "domain"]}
                    confirmLabel={tunnel ? "Close tunnel" : "Stop using it"}
                    error={error}
                    pending={removing}
                    onConfirm={() => void onRemove().then((removed) => removed && setConfirming(false))}
                />
            ) : null}
        </div>
    );
}
