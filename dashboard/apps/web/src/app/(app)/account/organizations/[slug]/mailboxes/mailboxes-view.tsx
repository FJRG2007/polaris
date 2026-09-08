"use client";

/**
 * The register of mailboxes an organization has handed out.
 *
 * What it deliberately does not have is a way in. Every row names an address and
 * the person who holds it, and neither is a link to a message - opening a
 * mailbox is being the person it belongs to, and a screen that offered the
 * administrator a way through would be the feature this was written to avoid.
 *
 * What it does have is the state, because a handed-out mailbox is the kind that
 * fails silently: a password rotated on the provider's side stops it syncing,
 * and the person holding it usually assumes it is meant to be like that. So the
 * row says whether it is connecting, in the same words the mail server used.
 */

import { runAction } from "@/lib/run-action";
import { Mail, Plus, Trash2 } from "lucide-react";
import { useEffect, useMemo, useState } from "react";
import { useConfirm } from "@/components/confirm-dialog";
import type { OrgMailboxView } from "@/lib/mailbox/org-mailboxes";
import { ConnectMailboxDialog } from "@/app/(app)/mail/connect-dialog";
import { handOutMailboxAction, takeBackMailboxAction } from "./actions";
import { Badge, Button, Card, CardBody, CardHeader, CardTitle, Select, useToast } from "@polaris/ui";

/** What each state means, said as the reader would say it rather than as the
 *  column stores it. */
const STANDING: Record<string, { label: string; tone: "success" | "danger" | "neutral" }> = {
    ok: { label: "Connecting", tone: "success" },
    auth: { label: "Password refused", tone: "danger" },
    unreachable: { label: "Cannot be reached", tone: "danger" },
    never: { label: "Not tried yet", tone: "neutral" }
};

export function MailboxesView({
    orgId,
    orgSlug,
    mailboxes,
    members
}: {
    orgId: string;
    orgSlug: string;
    mailboxes: OrgMailboxView[];
    members: readonly { id: string; name: string }[];
}) {
    const toast = useToast();
    const [confirm, confirmDialog] = useConfirm();
    const [rows, setRows] = useState(mailboxes);
    const [adding, setAdding] = useState(false);
    const [holderId, setHolderId] = useState(members[0]?.id ?? "");

    // The register as the server last drew it. Held in state so taking one back
    // redraws the list at once, and re-seeded whenever the server sends a new
    // one - without this a mailbox just handed out was missing from the screen
    // that handed it out, because the state was seeded once and never again.
    useEffect(() => setRows(mailboxes), [mailboxes]);

    /** Addresses already handed out, so the dialog can say so before somebody
     *  fills in a password for one that is already here. */
    const taken = useMemo(() => rows.map((row) => row.address), [rows]);
    const holderName = members.find((member) => member.id === holderId)?.name ?? "";

    async function takeBack(row: OrgMailboxView): Promise<void> {
        const sure = await confirm({
            title: `Take back ${row.address}?`,
            // What is actually being destroyed, and what is not. The mailbox on
            // the provider is the company's account with them and is untouched;
            // what goes is this copy of it and the credential it was reached with.
            description: `${row.holderName} loses it here, along with everything Polaris has cached from it. The mailbox itself and its mail are not touched - it can be handed out again.`,
            confirmLabel: "Take it back",
            danger: true
        });
        if (!sure) return;
        const answer = await runAction(
            () => takeBackMailboxAction(orgId, orgSlug, row.id),
            (message) => toast.show({ title: message })
        );
        if (!answer) return;
        if ("error" in answer) {
            toast.show({ title: answer.error });
            return;
        }
        setRows(answer.mailboxes);
        toast.show({ title: `${row.address} was taken back.` });
    }

    return (
        <Card>
            <CardHeader className="flex flex-wrap items-start justify-between gap-2">
                <div className="min-w-0">
                    <CardTitle>Mailboxes</CardTitle>
                    <p className="mt-1 text-[13px] text-muted-foreground">
                        Addresses this organization has given to its people. They appear in Mail
                        when the person switches to this organization. Nobody here can read them.
                    </p>
                </div>
                <Button
                    size="sm"
                    variant="primary"
                    disabled={members.length === 0}
                    onClick={() => setAdding(true)}
                >
                    <Plus className="size-4 shrink-0" aria-hidden />
                    Hand one out
                </Button>
            </CardHeader>
            <CardBody>
                {rows.length === 0 ? (
                    <p className="text-[13px] text-muted-foreground">
                        None yet. Hand out a company address and it is waiting for its holder the
                        next time they open Mail on this organization.
                    </p>
                ) : (
                    <ul className="flex flex-col gap-1">
                        {rows.map((row) => {
                            const standing = STANDING[row.state] ?? STANDING.never!;
                            return (
                                <li
                                    key={row.id}
                                    className="group flex items-center gap-3 rounded-lg border border-border px-3 py-2.5"
                                >
                                    <Mail className="size-4 shrink-0 text-muted-foreground" aria-hidden />
                                    <div className="min-w-0 flex-1">
                                        <p className="truncate text-sm font-medium" title={row.address}>{row.address}</p>
                                        <p className="truncate text-[12px] text-muted-foreground">
                                            {row.holderName}
                                            {row.stateDetail ? ` - ${row.stateDetail}` : ""}
                                        </p>
                                    </div>
                                    <Badge variant={standing.tone}>{standing.label}</Badge>
                                    <Button
                                        size="icon-sm"
                                        variant="ghost"
                                        title="Take it back"
                                        onClick={() => void takeBack(row)}
                                    >
                                        <Trash2 className="size-4 shrink-0" aria-hidden />
                                    </Button>
                                </li>
                            );
                        })}
                    </ul>
                )}
            </CardBody>

            {adding ? (
                <ConnectMailboxDialog
                    title="Hand out a mailbox"
                    done={`${holderName} has it. Its mail is on its way.`}
                    taken={taken}
                    // A mailbox handed out belongs to its holder, and so would
                    // the authorization that connected it - which is theirs to
                    // grant and not this screen's to offer.
                    links={[]}
                    allowOauth={false}
                    googleReady={false}
                    microsoftReady={false}
                    publicAddress={false}
                    canSetDomain={false}
                    lead={
                        <label className="block">
                            <span className="mb-1 block text-[12px] text-muted-foreground">
                                Who it is for <span aria-hidden>*</span>
                            </span>
                            <Select
                                value={holderId}
                                onValueChange={setHolderId}
                                options={members.map((member) => ({
                                    value: member.id,
                                    label: member.name
                                }))}
                            />
                        </label>
                    }
                    submit={(setup) => handOutMailboxAction(orgId, orgSlug, holderId, setup)}
                    onClose={() => setAdding(false)}
                />
            ) : null}
            {confirmDialog}
        </Card>
    );
}
