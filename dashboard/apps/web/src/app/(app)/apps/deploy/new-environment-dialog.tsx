"use client";

/**
 * Creating an environment, shared by every place that offers it: the switcher in
 * the header, the environments list in settings, and the environment picker above
 * the shared variables.
 *
 * An environment can start empty or as a copy of another - its services,
 * variables and volumes, with new empty databases of its own - and can follow one
 * branch for every service in it that builds from a repository. A copy on a
 * branch is what a staging or feature environment is.
 *
 * `NEW_ENVIRONMENT` is the sentinel a Select uses for the option - picking it
 * opens this dialog instead of switching to an environment that does not exist.
 */

import { Plus } from "lucide-react";
import { useRouter } from "next/navigation";
import { useState, useTransition } from "react";
import { createEnvironmentAction } from "./actions";
import {
    Button,
    Dialog,
    DialogContent,
    DialogHeader,
    DialogTitle,
    Input,
    Select
} from "@polaris/ui";

export const NEW_ENVIRONMENT = "__new_environment__";

/** What "start from" is set to when the environment starts with nothing in it. */
const EMPTY = "__empty__";

/** The trailing "New environment" entry for an environment Select. */
export function newEnvironmentOption(canManage: boolean) {
    return canManage
        ? [
              {
                  value: NEW_ENVIRONMENT,
                  label: "New environment",
                  icon: <Plus className="size-3.5 text-muted-foreground" />
              }
          ]
        : [];
}

export function NewEnvironmentDialog({
    projectId,
    open,
    onOpenChange,
    onCreated,
    environments = []
}: {
    projectId: string;
    open: boolean;
    onOpenChange: (open: boolean) => void;
    /** Called with the new id so the caller can land on what was just created. */
    onCreated?: (id: string) => void;
    /** The environments a new one can be copied from. None offered means it
     *  starts empty, which is all a caller without the list can offer. */
    environments?: readonly { id: string; name: string }[];
}) {
    const router = useRouter();
    const [name, setName] = useState("");
    const [from, setFrom] = useState(EMPTY);
    const [branch, setBranch] = useState("");
    const [deploy, setDeploy] = useState(true);
    const [error, setError] = useState<string | null>(null);
    const [pending, startTransition] = useTransition();
    const cloning = from !== EMPTY;

    function submit() {
        if (!name.trim()) return;
        setError(null);
        startTransition(async () => {
            const result = await createEnvironmentAction({
                projectId,
                name,
                cloneFrom: cloning ? from : undefined,
                branch: branch.trim() || undefined,
                deploy: cloning && deploy
            });
            if (result.error) {
                setError(result.error);
                return;
            }
            setName("");
            setFrom(EMPTY);
            setBranch("");
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
                        <span className="text-xs font-medium text-muted-foreground">
                            Name <span aria-hidden>*</span>
                        </span>
                        <Input
                            autoFocus
                            value={name}
                            onChange={(event) => setName(event.target.value)}
                            placeholder="staging"
                            onKeyDown={(event) => event.key === "Enter" && submit()}
                        />
                    </label>
                    {environments.length > 0 && (
                        <label className="flex flex-col gap-1.5">
                            <span className="text-xs font-medium text-muted-foreground">
                                Start from
                            </span>
                            <Select
                                value={from}
                                onValueChange={setFrom}
                                aria-label="What the new environment starts with"
                                options={[
                                    { value: EMPTY, label: "Nothing - an empty environment" },
                                    ...environments.map((environment) => ({
                                        value: environment.id,
                                        label: `A copy of ${environment.name}`
                                    }))
                                ]}
                            />
                            {cloning && (
                                <span className="text-xs text-muted-foreground">
                                    Services, variables and volumes are copied. Databases are
                                    created new and empty.
                                </span>
                            )}
                        </label>
                    )}
                    <label className="flex flex-col gap-1.5">
                        <span className="text-xs font-medium text-muted-foreground">Branch</span>
                        <Input
                            value={branch}
                            onChange={(event) => setBranch(event.target.value)}
                            placeholder="Each service's own"
                            spellCheck={false}
                            onKeyDown={(event) => event.key === "Enter" && submit()}
                        />
                        <span className="text-xs text-muted-foreground">
                            Services built from a repository build from this branch and redeploy on
                            its pushes.
                        </span>
                    </label>
                    {cloning && (
                        <label className="flex items-center gap-2 text-sm">
                            <input
                                type="checkbox"
                                checked={deploy}
                                onChange={(event) => setDeploy(event.target.checked)}
                                className="size-4 accent-primary"
                            />
                            Deploy it once it is created
                        </label>
                    )}
                    {error && <p className="text-sm text-danger">{error}</p>}
                    <div className="flex justify-end gap-2">
                        <Button variant="ghost" onClick={() => onOpenChange(false)}>
                            Cancel
                        </Button>
                        <Button
                            onClick={submit}
                            disabled={pending || !name.trim()}
                            aria-disabled={!name.trim()}
                        >
                            Create
                        </Button>
                    </div>
                </div>
            </DialogContent>
        </Dialog>
    );
}
