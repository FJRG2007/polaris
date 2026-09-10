"use client";

/**
 * The list of mail servers and the dialog that sets a new one up.
 *
 * Setting one up asks three things: where it runs, the name it answers to (its
 * certificate and the target of MX), and the first domain it receives mail for.
 * Everything after that - the service, the engine's own setup, the accounts
 * Polaris manages it with - happens on the server's page, step by step.
 */

import Link from "next/link";
import { useRouter } from "next/navigation";
import { mailServerSetupSchema } from "@polaris/core";
import { RelativeTime } from "@/components/relative-time";
import { useEffect, useState, useTransition } from "react";
import { Loader2, Mails, Plus, Server } from "lucide-react";
import { Field, forgetPanelData, PanelError, StatusBadge, usePanelData } from "./ui-bits";
import {
    listPlacementsAction,
    listServersAction,
    startSetupAction,
    uninstallMailServerAppAction,
    type MailServerSummary
} from "./actions";
import {
    Button,
    Dialog,
    DialogContent,
    DialogDescription,
    DialogFooter,
    DialogHeader,
    DialogTitle,
    EmptyState,
    Input,
    Select,
    Skeleton
} from "@polaris/ui";

export function MailServersView({ canUninstall }: { canUninstall: boolean }) {
    const { data, error, loading, reload } = usePanelData("servers", listServersAction);
    const [open, setOpen] = useState(false);
    const [uninstalling, setUninstalling] = useState(false);
    const servers = data?.servers ?? [];

    return (
        <div className="flex flex-col gap-4">
            <div className="flex items-center justify-end gap-2">
                {canUninstall ? (
                    <Button size="sm" variant="ghost" onClick={() => setUninstalling(true)}>
                        Uninstall
                    </Button>
                ) : null}
                <Button size="sm" onClick={() => setOpen(true)}>
                    <Plus />
                    Set up a mail server
                </Button>
            </div>
            {error ? <PanelError message={error} onRetry={() => void reload()} /> : null}
            {loading && !data ? (
                <div className="flex flex-col gap-2">
                    <Skeleton className="h-14 w-full" />
                    <Skeleton className="h-14 w-full" />
                </div>
            ) : servers.length === 0 && !error ? (
                <EmptyState
                    icon={<Mails />}
                    title="No mail server yet"
                    description="Polaris installs one on this machine or a server you enrolled, then walks its DNS through with you."
                    action={
                        <Button size="sm" onClick={() => setOpen(true)}>
                            Set up a mail server
                        </Button>
                    }
                />
            ) : (
                <ul className="flex flex-col divide-y divide-border rounded-lg border border-border bg-card">
                    {servers.map((server) => (
                        <li key={server.id}>
                            <Link
                                href={`/apps/mail-server/${server.id}`}
                                className="flex items-center gap-3 px-4 py-3 transition-colors hover:bg-muted"
                            >
                                <Server className="size-4 text-foreground-subtle" />
                                <div className="flex min-w-0 flex-1 flex-col">
                                    <span className="truncate text-[0.8125rem] font-medium text-foreground" title={server.hostname}>{server.hostname}</span>
                                    <span className="truncate text-xs text-muted-foreground">
                                        {server.primaryDomain} on {server.placementName}
                                        {server.error ? ` - ${server.error}` : ""}
                                    </span>
                                </div>
                                <span className="hidden text-xs text-foreground-subtle sm:inline">
                                    <RelativeTime iso={server.createdAt} />
                                </span>
                                <StatusBadge status={server.status} />
                            </Link>
                        </li>
                    ))}
                </ul>
            )}
            <SetupDialog open={open} onOpenChange={setOpen} />
            <UninstallDialog
                open={uninstalling}
                onOpenChange={setUninstalling}
                servers={loading && !data ? null : servers}
            />
        </div>
    );
}

/**
 * Uninstalling the app, which waits until no mail server is left.
 *
 * The servers on this shelf are listed with a way to each, because removing one
 * is a decision about its mail and belongs on its own page. The server still
 * refuses while any server exists anywhere - including somebody else's, which
 * this list cannot show - and the dialog says what it said.
 */
function UninstallDialog({
    open,
    onOpenChange,
    servers
}: {
    open: boolean;
    onOpenChange: (open: boolean) => void;
    /** Null while the list is still loading. */
    servers: readonly MailServerSummary[] | null;
}) {
    const [pending, startTransition] = useTransition();
    const [error, setError] = useState<string | null>(null);
    const blocked = servers === null || servers.length > 0;

    function uninstall(): void {
        setError(null);
        startTransition(async () => {
            const result = await uninstallMailServerAppAction();
            if (result.error) {
                setError(result.error);
                return;
            }
            // A full load: the rail and the search drop the app as well.
            window.location.assign("/apps/mail-server");
        });
    }

    return (
        <Dialog
            open={open}
            onOpenChange={(next) => {
                if (!next) setError(null);
                onOpenChange(next);
            }}
        >
            <DialogContent className="w-[min(32rem,95vw)] max-w-[min(32rem,95vw)]">
                <DialogHeader>
                    <DialogTitle>Uninstall Mail server</DialogTitle>
                    <DialogDescription>
                        {servers && servers.length > 0
                            ? "Remove your mail servers first. Each one's page has Remove from Polaris at the bottom of its overview."
                            : "It leaves the menu and search. Nothing runs for it, so nothing is stopped, and you can install it again from the Marketplace."}
                    </DialogDescription>
                </DialogHeader>
                {servers && servers.length > 0 ? (
                    <ul className="flex flex-col divide-y divide-border rounded-md border border-border">
                        {servers.map((server) => (
                            <li key={server.id}>
                                <Link
                                    href={`/apps/mail-server/${server.id}`}
                                    className="flex items-center gap-2 px-3 py-2 text-[0.8125rem] transition-colors hover:bg-muted"
                                >
                                    <Server className="size-4 text-foreground-subtle" />
                                    <span className="min-w-0 flex-1 truncate" title={server.hostname}>
                                        {server.hostname}
                                    </span>
                                    <span className="text-xs text-muted-foreground">Open</span>
                                </Link>
                            </li>
                        ))}
                    </ul>
                ) : null}
                {error ? (
                    <p role="alert" className="text-xs text-danger">
                        {error}
                    </p>
                ) : null}
                <DialogFooter>
                    <Button type="button" variant="ghost" onClick={() => onOpenChange(false)}>
                        {blocked ? "Close" : "Cancel"}
                    </Button>
                    {blocked ? null : (
                        <Button type="button" variant="danger" onClick={uninstall} disabled={pending}>
                            {pending ? <Loader2 className="animate-spin" /> : null}
                            {pending ? "Uninstalling" : "Uninstall"}
                        </Button>
                    )}
                </DialogFooter>
            </DialogContent>
        </Dialog>
    );
}

function SetupDialog({ open, onOpenChange }: { open: boolean; onOpenChange: (open: boolean) => void }) {
    const router = useRouter();
    const [placements, setPlacements] = useState<{ id: string; name: string }[]>([]);
    const [serverId, setServerId] = useState("local");
    const [hostname, setHostname] = useState("");
    const [domain, setDomain] = useState("");
    const [pending, setPending] = useState(false);
    const [error, setError] = useState<string | null>(null);

    useEffect(() => {
        if (!open) return;
        listPlacementsAction()
            .then(setPlacements)
            .catch(() => setPlacements([{ id: "local", name: "This machine" }]));
    }, [open]);

    // Suggest the name from the domain the way almost everybody names it.
    const suggested = domain.trim() && !hostname.trim() ? `mail.${domain.trim().toLowerCase()}` : "";
    const input = { serverId, hostname: hostname.trim() || suggested, domain };
    const parsed = mailServerSetupSchema.safeParse(input);
    const fieldError = (path: string): string | null => {
        if (parsed.success) return null;
        const value = path === "hostname" ? input.hostname : domain;
        if (!value.trim()) return null;
        return parsed.error.issues.find((issue) => issue.path[0] === path)?.message ?? null;
    };

    async function submit(): Promise<void> {
        if (!parsed.success || pending) return;
        setPending(true);
        setError(null);
        const result = await startSetupAction(parsed.data);
        setPending(false);
        if (result.error) {
            setError(result.error);
            return;
        }
        if (!("id" in result)) return;
        forgetPanelData("servers");
        onOpenChange(false);
        router.push(`/apps/mail-server/${result.id}`);
    }

    return (
        <Dialog open={open} onOpenChange={onOpenChange}>
            <DialogContent className="w-[min(32rem,95vw)] max-w-[min(32rem,95vw)]">
                <DialogHeader>
                    <DialogTitle>Set up a mail server</DialogTitle>
                    <DialogDescription>
                        It runs as a service in Deploy, with ports 25, 465, 587, 993 and 4190 published on the machine you choose.
                    </DialogDescription>
                </DialogHeader>
                <form
                    className="flex flex-col gap-4"
                    onSubmit={(event) => {
                        event.preventDefault();
                        void submit();
                    }}
                >
                    <Field label="Runs on" required hint="A server that deploys through a swarm cannot run one.">
                        {(id) => (
                            <Select
                                id={id}
                                value={serverId}
                                onValueChange={setServerId}
                                options={placements.map((placement) => ({ value: placement.id, label: placement.name }))}
                            />
                        )}
                    </Field>
                    <Field label="First domain" required error={fieldError("domain")} hint="The domain mail is received for, like example.com.">
                        {(id) => (
                            <Input id={id} value={domain} onChange={(event) => setDomain(event.target.value)} placeholder="example.com" autoComplete="off" />
                        )}
                    </Field>
                    <Field
                        label="Server name"
                        required
                        error={fieldError("hostname")}
                        hint="What its certificate is for and what MX points at. It must resolve to the machine it runs on."
                    >
                        {(id) => (
                            <Input
                                id={id}
                                value={hostname}
                                onChange={(event) => setHostname(event.target.value)}
                                placeholder={suggested || "mail.example.com"}
                                autoComplete="off"
                            />
                        )}
                    </Field>
                    {error ? <p className="text-xs text-danger">{error}</p> : null}
                    <DialogFooter>
                        <Button type="button" variant="ghost" onClick={() => onOpenChange(false)}>
                            Cancel
                        </Button>
                        <Button type="submit" disabled={!parsed.success || pending} aria-disabled={!parsed.success || pending}>
                            {pending ? "Starting..." : "Set it up"}
                        </Button>
                    </DialogFooter>
                </form>
            </DialogContent>
        </Dialog>
    );
}
