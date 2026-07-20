"use client";

/**
 * Deploy app view. Lists projects and their applications, and drives create and
 * deploy actions. Projects group environments; each environment holds
 * applications and managed databases. All confirmations are in-app (no native
 * dialogs). Full build/deploy on the local host needs the full edition; the view
 * says so plainly when it is unavailable rather than failing silently.
 */

import { useState, useTransition } from "react";
import { useRouter } from "next/navigation";
import { Boxes, Database, Plus, Rocket, Trash2 } from "lucide-react";
import { Badge, Button, Card, CardBody, CardHeader, CardTitle, Input } from "@polaris/ui";
import {
    createApplicationAction,
    createProjectAction,
    deleteProjectAction,
    deployApplicationAction
} from "./actions";

export interface ProjectSummary {
    id: string;
    name: string;
    environments: {
        id: string;
        name: string;
        applications: { id: string; name: string; sourceType: string; currentDeploymentId: string | null }[];
        databases: { id: string; name: string; engine: string; status: string }[];
    }[];
}

export function DeployView({
    projects,
    canManage,
    localReady
}: {
    projects: ProjectSummary[];
    canManage: boolean;
    localReady: boolean;
}) {
    const router = useRouter();
    const [pending, startTransition] = useTransition();
    const [newProject, setNewProject] = useState("");
    const [error, setError] = useState<string | null>(null);
    const [confirmDelete, setConfirmDelete] = useState<string | null>(null);

    function onCreateProject() {
        if (!newProject.trim()) return;
        setError(null);
        startTransition(async () => {
            const result = await createProjectAction({ name: newProject });
            if (result.error) setError(result.error);
            else setNewProject("");
            router.refresh();
        });
    }

    return (
        <div className="flex flex-col gap-6">
            {!localReady && canManage && (
                <Card>
                    <CardBody className="text-sm text-muted-foreground">
                        The local host is not ready to build and deploy. This needs the full edition with a
                        running <code>polaris-hostd</code>. Remote servers added in the Servers view work regardless.
                    </CardBody>
                </Card>
            )}

            {canManage && (
                <div className="flex items-end gap-2">
                    <div className="flex flex-col gap-1">
                        <label className="text-xs text-muted-foreground">New project</label>
                        <Input
                            value={newProject}
                            onChange={(event) => setNewProject(event.target.value)}
                            placeholder="my-project"
                            onKeyDown={(event) => event.key === "Enter" && onCreateProject()}
                        />
                    </div>
                    <Button onClick={onCreateProject} disabled={pending || !newProject.trim()}>
                        <Plus className="size-4" /> Create
                    </Button>
                </div>
            )}
            {error && <p className="text-sm text-red-400">{error}</p>}

            {projects.length === 0 ? (
                <p className="text-sm text-muted-foreground">No projects yet. Create one to deploy your first app.</p>
            ) : (
                projects.map((project) => (
                    <Card key={project.id}>
                        <CardHeader className="flex items-center justify-between">
                            <CardTitle className="flex items-center gap-2">
                                <Boxes className="size-4" /> {project.name}
                            </CardTitle>
                            {canManage &&
                                (confirmDelete === project.id ? (
                                    <div className="flex items-center gap-2">
                                        <span className="text-xs text-muted-foreground">Delete project?</span>
                                        <Button
                                            variant="danger"
                                            onClick={() =>
                                                startTransition(async () => {
                                                    await deleteProjectAction(project.id);
                                                    setConfirmDelete(null);
                                                    router.refresh();
                                                })
                                            }
                                        >
                                            Confirm
                                        </Button>
                                        <Button variant="ghost" onClick={() => setConfirmDelete(null)}>
                                            Cancel
                                        </Button>
                                    </div>
                                ) : (
                                    <Button variant="ghost" onClick={() => setConfirmDelete(project.id)}>
                                        <Trash2 className="size-4" />
                                    </Button>
                                ))}
                        </CardHeader>
                        <CardBody className="flex flex-col gap-4">
                            {project.environments.map((environment) => (
                                <EnvironmentBlock
                                    key={environment.id}
                                    environment={environment}
                                    canManage={canManage}
                                    onChanged={() => router.refresh()}
                                />
                            ))}
                        </CardBody>
                    </Card>
                ))
            )}
        </div>
    );
}

function EnvironmentBlock({
    environment,
    canManage,
    onChanged
}: {
    environment: ProjectSummary["environments"][number];
    canManage: boolean;
    onChanged: () => void;
}) {
    const [pending, startTransition] = useTransition();
    const [name, setName] = useState("");
    const [image, setImage] = useState("");
    const [error, setError] = useState<string | null>(null);

    function onCreateApp() {
        setError(null);
        startTransition(async () => {
            const result = await createApplicationAction({ environmentId: environment.id, name, imageRef: image });
            if (result.error) setError(result.error);
            else {
                setName("");
                setImage("");
            }
            onChanged();
        });
    }

    function onDeploy(applicationId: string) {
        startTransition(async () => {
            await deployApplicationAction(applicationId);
            onChanged();
        });
    }

    return (
        <div className="rounded-md border border-border/60 p-3">
            <div className="mb-2 text-xs uppercase tracking-wide text-muted-foreground">{environment.name}</div>

            <div className="flex flex-col gap-2">
                {environment.applications.length === 0 && environment.databases.length === 0 && (
                    <p className="text-sm text-muted-foreground">No applications yet.</p>
                )}
                {environment.applications.map((app) => (
                    <div key={app.id} className="flex items-center justify-between gap-2">
                        <div className="flex items-center gap-2">
                            <Rocket className="size-4 text-muted-foreground" />
                            <span className="text-sm">{app.name}</span>
                            <Badge>{app.sourceType}</Badge>
                        </div>
                        {canManage && (
                            <Button variant="secondary" onClick={() => onDeploy(app.id)} disabled={pending}>
                                Deploy
                            </Button>
                        )}
                    </div>
                ))}
                {environment.databases.map((database) => (
                    <div key={database.id} className="flex items-center justify-between gap-2">
                        <div className="flex items-center gap-2">
                            <Database className="size-4 text-muted-foreground" />
                            <span className="text-sm">{database.name}</span>
                            <Badge>{database.engine}</Badge>
                        </div>
                        <Badge>{database.status}</Badge>
                    </div>
                ))}
            </div>

            {canManage && (
                <div className="mt-3 flex flex-wrap items-end gap-2">
                    <Input
                        value={name}
                        onChange={(event) => setName(event.target.value)}
                        placeholder="app name"
                        className="w-40"
                    />
                    <Input
                        value={image}
                        onChange={(event) => setImage(event.target.value)}
                        placeholder="image e.g. nginx:latest"
                        className="w-56"
                    />
                    <Button onClick={onCreateApp} disabled={pending || !name.trim() || !image.trim()}>
                        <Plus className="size-4" /> Add app
                    </Button>
                </div>
            )}
            {error && <p className="mt-2 text-sm text-red-400">{error}</p>}
        </div>
    );
}
