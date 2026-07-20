"use client";

/**
 * Manage private container-registry logins used when deploying private images.
 * Credentials are stored per registry host (password envelope-encrypted); a deploy
 * `docker login`s automatically before pulling an image from a matching registry.
 */

import { useEffect, useState, useTransition } from "react";
import { KeyRound, Loader2, Plus, Trash2 } from "lucide-react";
import { Button, Dialog, DialogContent, DialogHeader, DialogTitle, Input } from "@polaris/ui";
import {
    deleteRegistryCredentialAction,
    listRegistryCredentialsAction,
    saveRegistryCredentialAction
} from "./actions";

interface Credential {
    id: string;
    registry: string;
    username: string;
    updatedAt: string;
}

export function RegistryCredentialsButton() {
    const [open, setOpen] = useState(false);
    return (
        <>
            <Button variant="outline" onClick={() => setOpen(true)}>
                <KeyRound className="size-4" /> Registries
            </Button>
            <Dialog open={open} onOpenChange={setOpen}>
                <DialogContent className="max-w-lg">
                    <DialogHeader>
                        <DialogTitle>Private registry credentials</DialogTitle>
                    </DialogHeader>
                    {open && <RegistryManager />}
                </DialogContent>
            </Dialog>
        </>
    );
}

function RegistryManager() {
    const [items, setItems] = useState<Credential[] | null>(null);
    const [registry, setRegistry] = useState("");
    const [username, setUsername] = useState("");
    const [password, setPassword] = useState("");
    const [error, setError] = useState<string | null>(null);
    const [pending, startTransition] = useTransition();

    function reload() {
        void listRegistryCredentialsAction().then(setItems);
    }

    useEffect(() => {
        reload();
    }, []);

    function add() {
        setError(null);
        startTransition(async () => {
            const result = await saveRegistryCredentialAction({ registry, username, password });
            if (result.error) {
                setError(result.error);
                return;
            }
            setRegistry("");
            setUsername("");
            setPassword("");
            reload();
        });
    }

    function remove(id: string) {
        startTransition(async () => {
            await deleteRegistryCredentialAction(id);
            reload();
        });
    }

    return (
        <div className="flex flex-col gap-4">
            {items === null ? (
                <div className="flex items-center gap-2 py-4 text-sm text-muted-foreground">
                    <Loader2 className="size-4 animate-spin" /> Loading...
                </div>
            ) : items.length === 0 ? (
                <p className="text-sm text-muted-foreground">No registry logins yet.</p>
            ) : (
                <ul className="flex flex-col gap-1">
                    {items.map((item) => (
                        <li key={item.id} className="flex items-center gap-2 rounded-md border border-border/60 px-3 py-2 text-sm">
                            <span className="font-medium">{item.registry}</span>
                            <span className="text-muted-foreground">{item.username}</span>
                            <Button
                                variant="ghost"
                                size="icon"
                                className="ml-auto"
                                title="Remove"
                                disabled={pending}
                                onClick={() => remove(item.id)}
                            >
                                <Trash2 className="size-4" />
                            </Button>
                        </li>
                    ))}
                </ul>
            )}

            <div className="flex flex-col gap-2 border-t border-border/60 pt-3">
                <span className="text-xs font-medium text-muted-foreground">Add a login</span>
                <Input value={registry} onChange={(event) => setRegistry(event.target.value)} placeholder="ghcr.io (or docker.io)" />
                <Input value={username} onChange={(event) => setUsername(event.target.value)} placeholder="username" />
                <Input
                    type="password"
                    autoComplete="off"
                    value={password}
                    onChange={(event) => setPassword(event.target.value)}
                    placeholder="password or token"
                />
                {error && <p className="text-sm text-danger">{error}</p>}
                <div className="flex justify-end">
                    <Button onClick={add} disabled={pending || !registry.trim() || !username.trim() || !password}>
                        {pending ? <Loader2 className="size-4 animate-spin" /> : <Plus className="size-4" />} Save login
                    </Button>
                </div>
            </div>
        </div>
    );
}
