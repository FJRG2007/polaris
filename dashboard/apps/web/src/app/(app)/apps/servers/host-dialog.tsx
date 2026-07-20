"use client";

/**
 * Add a server (SSH host). On submit the server test-connects to validate the
 * credentials and captures the host key to pin (trust-on-add), so a registered
 * host is verified from the first real connection onward. Auth is a password or a
 * private key (with an optional passphrase for an encrypted key).
 */

import { useState, type FormEvent } from "react";
import { useRouter } from "next/navigation";
import { Plus } from "lucide-react";
import { SSH_AUTH_METHODS, type SshAuthMethod } from "@polaris/core";
import {
    Button,
    Dialog,
    DialogClose,
    DialogContent,
    DialogDescription,
    DialogHeader,
    DialogTitle,
    DialogTrigger,
    Input
} from "@polaris/ui";
import { createHostAction } from "./actions";

const AUTH_LABELS: Record<SshAuthMethod, string> = {
    password: "Password",
    key: "Private key"
};

export function HostDialog() {
    const router = useRouter();
    const [open, setOpen] = useState(false);
    const [authMethod, setAuthMethod] = useState<SshAuthMethod>("password");
    const [error, setError] = useState<string | null>(null);
    const [pending, setPending] = useState(false);

    async function onSubmit(event: FormEvent<HTMLFormElement>) {
        event.preventDefault();
        setPending(true);
        setError(null);
        const form = new FormData(event.currentTarget);
        const str = (key: string) => {
            const value = form.get(key);
            return value ? String(value) : undefined;
        };

        const config = {
            address: str("address"),
            port: Number(str("port") ?? 22),
            username: str("username"),
            authMethod
        };
        const credentials =
            authMethod === "password"
                ? { method: "password", password: str("password") }
                : { method: "key", privateKey: str("privateKey"), passphrase: str("passphrase") };

        const result = await createHostAction({ name: str("name"), config, credentials });
        setPending(false);
        if (result.error) {
            setError(result.error);
            return;
        }
        setOpen(false);
        router.refresh();
    }

    return (
        <Dialog open={open} onOpenChange={setOpen}>
            <DialogTrigger asChild>
                <Button size="sm" variant="secondary">
                    <Plus className="size-4" />
                    Add server
                </Button>
            </DialogTrigger>
            <DialogContent>
                <DialogHeader>
                    <DialogTitle>Add a server</DialogTitle>
                    <DialogDescription>
                        An SSH host, reusable in Containers (Docker) and Drive (SFTP).
                    </DialogDescription>
                </DialogHeader>
                <form onSubmit={onSubmit} className="flex flex-col gap-3">
                    <label className="flex flex-col gap-1 text-sm">
                        Name
                        <Input name="name" required placeholder="nas-01" />
                    </label>
                    <label className="flex flex-col gap-1 text-sm">
                        Address
                        <Input name="address" required placeholder="192.168.1.10" />
                    </label>
                    <div className="grid grid-cols-2 gap-2">
                        <label className="flex flex-col gap-1 text-sm">
                            Port
                            <Input name="port" type="number" defaultValue="22" />
                        </label>
                        <label className="flex flex-col gap-1 text-sm">
                            Username
                            <Input name="username" required />
                        </label>
                    </div>
                    <label className="flex flex-col gap-1 text-sm">
                        Authentication
                        <select
                            className="h-9 rounded-md border border-input bg-surface px-3 text-sm"
                            value={authMethod}
                            onChange={(event) => setAuthMethod(event.target.value as SshAuthMethod)}
                        >
                            {SSH_AUTH_METHODS.map((value) => (
                                <option key={value} value={value}>
                                    {AUTH_LABELS[value]}
                                </option>
                            ))}
                        </select>
                    </label>

                    {authMethod === "password" ? (
                        <label className="flex flex-col gap-1 text-sm">
                            Password
                            <Input name="password" type="password" required />
                        </label>
                    ) : (
                        <>
                            <label className="flex flex-col gap-1 text-sm">
                                Private key (PEM)
                                <textarea
                                    name="privateKey"
                                    required
                                    rows={4}
                                    className="rounded-md border border-input bg-surface px-3 py-1 text-sm"
                                />
                            </label>
                            <label className="flex flex-col gap-1 text-sm">
                                Key passphrase (optional)
                                <Input name="passphrase" type="password" />
                            </label>
                        </>
                    )}

                    {error ? <p className="text-sm text-danger">{error}</p> : null}
                    <div className="mt-2 flex justify-end gap-2">
                        <DialogClose asChild>
                            <Button type="button" variant="ghost">
                                Cancel
                            </Button>
                        </DialogClose>
                        <Button type="submit" disabled={pending}>
                            {pending ? "Connecting..." : "Add server"}
                        </Button>
                    </div>
                </form>
            </DialogContent>
        </Dialog>
    );
}
