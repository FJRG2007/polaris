"use client";

/**
 * Creating an environment, shared by every place that offers it: the switcher in
 * the header, the environments list in settings, and the environment picker above
 * the shared variables.
 *
 * `NEW_ENVIRONMENT` is the sentinel a Select uses for the option - picking it
 * opens this dialog instead of switching to an environment that does not exist.
 */

import { Plus } from "lucide-react";
import { useRouter } from "next/navigation";
import { useState, useTransition } from "react";
import { createEnvironmentAction } from "./actions";
import { Button, Dialog, DialogContent, DialogHeader, DialogTitle, Input } from "@polaris/ui";

export const NEW_ENVIRONMENT = "__new_environment__";

/** The trailing "New environment" entry for an environment Select. */
export function newEnvironmentOption(canManage: boolean) {
    return canManage
        ? [{ value: NEW_ENVIRONMENT, label: "New environment", icon: <Plus className="size-3.5 text-muted-foreground" /> }]
        : [];
}

export function NewEnvironmentDialog({
    projectId,
    open,
    onOpenChange,
    onCreated
}: {
    projectId: string;
    open: boolean;
    onOpenChange: (open: boolean) => void;
    /** Called with the new id so the caller can land on what was just created. */
    onCreated?: (id: string) => void;
}) {
    const router = useRouter();
    const [name, setName] = useState("");
    const [error, setError] = useState<string | null>(null);
    const [pending, startTransition] = useTransition();

    function submit() {
        if (!name.trim()) return;
        setError(null);
        startTransition(async () => {
            const result = await createEnvironmentAction({ projectId, name });
            if (result.error) {
                setError(result.error);
                return;
            }
            setName("");
            onOpenChange(false);
            // Land on what was just created: an environment made and then not
            // switched to reads as if nothing happened.
            if (result.id) onCreated?.(result.id);
            router.refresh();
        });
    }

    return (
        <Dialog open={open} onOpenChange={onOpenChange}>
            <DialogContent className="max-w-md">
                <DialogHeader>
                    <DialogTitle>New environment</DialogTitle>
                </DialogHeader>
                <div className="flex flex-col gap-3">
                    <label className="flex flex-col gap-1.5">
                        <span className="text-xs font-medium text-muted-foreground">Name</span>
                        <Input
                            autoFocus
                            value={name}
                            onChange={(event) => setName(event.target.value)}
                            placeholder="development"
                            onKeyDown={(event) => event.key === "Enter" && submit()}
                        />
                    </label>
                    {error && <p className="text-sm text-danger">{error}</p>}
                    <div className="flex justify-end gap-2">
                        <Button variant="ghost" onClick={() => onOpenChange(false)}>
                            Cancel
                        </Button>
                        <Button onClick={submit} disabled={pending || !name.trim()}>
                            Create
                        </Button>
                    </div>
                </div>
            </DialogContent>
        </Dialog>
    );
}
