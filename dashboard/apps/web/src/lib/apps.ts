/**
 * The Polaris app registry - what appears in the top-left switcher. Drive is
 * live; the rest are declared but locked so the platform's direction is visible
 * from day one. Future phases unlock them (Docker/Kubernetes/servers/home) as
 * their apps land, most gated behind the full edition's host access.
 */

import { Boxes, Container, DatabaseBackup, HardDrive, Home, Server, type LucideIcon } from "lucide-react";

export interface AppEntry {
    id: string;
    label: string;
    description: string;
    icon: LucideIcon;
    href: string;
    locked?: boolean;
}

export const POLARIS_APPS: AppEntry[] = [
    { id: "drive", label: "Drive", description: "Files across every NAS", icon: HardDrive, href: "/drive" },
    { id: "containers", label: "Containers", description: "Docker & Compose", icon: Container, href: "/apps/containers" },
    { id: "backups", label: "Backups", description: "Databases, Polaris & NAS", icon: DatabaseBackup, href: "/apps/backups" },
    { id: "kubernetes", label: "Kubernetes", description: "Clusters & workloads", icon: Boxes, href: "/apps/kubernetes", locked: true },
    { id: "servers", label: "Servers", description: "Hosts, VMs & deploys", icon: Server, href: "/apps/servers", locked: true },
    { id: "home", label: "Home", description: "Home Assistant", icon: Home, href: "/apps/home", locked: true }
];
