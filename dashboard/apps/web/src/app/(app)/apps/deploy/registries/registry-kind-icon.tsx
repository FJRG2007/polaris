"use client";

import { Package } from "lucide-react";
import { DockerMark, GitHubMark } from "@/components/brand-icons";
import type { RegistryKind } from "@/lib/registries/registry-form";

/** The mark of the service a login is for; a plain package for the rest. */
export function RegistryKindIcon({ kind }: { kind: RegistryKind }) {
    if (kind === "dockerhub") return <DockerMark className="size-4 shrink-0" aria-hidden />;
    if (kind === "ghcr") return <GitHubMark className="size-4 shrink-0" aria-hidden />;
    return <Package className="size-4 shrink-0 text-muted-foreground" aria-hidden />;
}
