"use client";

import { useState, type FormEvent } from "react";
import { useRouter } from "next/navigation";
import { Check, Copy, Trash2 } from "lucide-react";
import { createInviteSchema, INVITE_ROLES } from "@polaris/core";
import { Badge, Button, Card, CardBody, CardHeader, CardTitle, Input, Select } from "@polaris/ui";
import { useZodForm } from "@/lib/use-zod-form";
import { createInviteAction, revokeInviteAction } from "./actions";

interface UserRow {
    id: string;
    name: string;
    email: string;
    isAdmin: boolean;
}
interface InviteRow {
    id: string;
    email: string;
    expiresAt: string;
}

export function UsersAdmin({ users, invites }: { users: UserRow[]; invites: InviteRow[] }) {
    const router = useRouter();
    const form = useZodForm(createInviteSchema);
    const [values, setValues] = useState({ email: "", role: "member" });
    const [link, setLink] = useState<string | null>(null);
    const [copied, setCopied] = useState(false);
    const [error, setError] = useState<string | null>(null);
    const [pending, setPending] = useState(false);

    function update(field: "email" | "role", value: string) {
        const next = { ...values, [field]: value };
        setValues(next);
        form.revalidate(next);
    }

    async function onInvite(event: FormEvent) {
        event.preventDefault();
        const parsed = form.submit(values);
        if (!parsed) return;
        setPending(true);
        setError(null);
        setLink(null);
        const result = await createInviteAction(parsed);
        setPending(false);
        if (result.error || !result.token) {
            setError(result.error ?? "Could not create the invite");
            return;
        }
        setLink(`${window.location.origin}/accept-invite?token=${result.token}`);
        setValues({ email: "", role: "member" });
        router.refresh();
    }

    async function copyLink() {
        if (!link) return;
        await navigator.clipboard.writeText(link);
        setCopied(true);
        setTimeout(() => setCopied(false), 1500);
    }

    function onRevoke(id: string) {
        revokeInviteAction(id).then(() => router.refresh());
    }

    return (
        <div className="grid grid-cols-1 gap-4 lg:grid-cols-2">
            <Card>
                <CardHeader>
                    <CardTitle>Invite someone</CardTitle>
                </CardHeader>
                <CardBody>
                    <form onSubmit={onInvite} noValidate className="flex flex-col gap-3">
                        <div className="flex flex-col gap-1">
                            <label className="text-sm">Email</label>
                            <Input
                                type="email"
                                placeholder="teammate@example.com"
                                value={values.email}
                                onChange={(event) => update("email", event.target.value)}
                                onBlur={() => form.markTouched("email")}
                                aria-invalid={Boolean(form.error("email"))}
                            />
                            {form.error("email") ? (
                                <p className="text-xs text-danger">{form.error("email")}</p>
                            ) : null}
                        </div>
                        <div className="flex flex-col gap-1">
                            <label className="text-sm">Role</label>
                            <Select
                                value={values.role}
                                onValueChange={(value) => update("role", value)}
                                options={INVITE_ROLES.map((role) => ({ value: role, label: role }))}
                            />
                        </div>
                        {error ? <p className="text-sm text-danger">{error}</p> : null}
                        <Button type="submit" disabled={pending}>
                            {pending ? "Creating..." : "Create invite"}
                        </Button>
                    </form>
                    {link ? (
                        <div className="mt-3 rounded-md border border-border bg-muted/40 p-2">
                            <p className="mb-1 text-xs text-muted-foreground">
                                Share this link (valid 7 days):
                            </p>
                            <div className="flex items-center gap-2">
                                <code className="flex-1 truncate text-xs">{link}</code>
                                <Button
                                    size="icon"
                                    variant="ghost"
                                    onClick={copyLink}
                                    aria-label="Copy link"
                                >
                                    {copied ? (
                                        <Check className="size-4 text-success" />
                                    ) : (
                                        <Copy className="size-4" />
                                    )}
                                </Button>
                            </div>
                        </div>
                    ) : null}

                    {invites.length > 0 ? (
                        <div className="mt-4">
                            <h3 className="mb-2 text-xs font-medium text-muted-foreground">
                                Pending invites
                            </h3>
                            <ul className="flex flex-col gap-1">
                                {invites.map((invite) => (
                                    <li
                                        key={invite.id}
                                        className="flex items-center justify-between text-sm"
                                    >
                                        <span className="truncate">{invite.email}</span>
                                        <Button
                                            size="icon"
                                            variant="ghost"
                                            onClick={() => onRevoke(invite.id)}
                                            aria-label={`Revoke invite for ${invite.email}`}
                                        >
                                            <Trash2 className="size-4" />
                                        </Button>
                                    </li>
                                ))}
                            </ul>
                        </div>
                    ) : null}
                </CardBody>
            </Card>

            <Card>
                <CardHeader>
                    <CardTitle>People ({users.length})</CardTitle>
                </CardHeader>
                <CardBody>
                    <ul className="flex flex-col gap-2">
                        {users.map((user) => (
                            <li key={user.id} className="flex items-center justify-between gap-2">
                                <span className="min-w-0">
                                    <span className="block truncate text-sm font-medium">
                                        {user.name}
                                    </span>
                                    <span className="block truncate text-xs text-muted-foreground">
                                        {user.email}
                                    </span>
                                </span>
                                {user.isAdmin ? <Badge variant="primary">admin</Badge> : null}
                            </li>
                        ))}
                    </ul>
                </CardBody>
            </Card>
        </div>
    );
}
