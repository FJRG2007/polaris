/**
 * Deploy's one-click templates, as entries of the user marketplace.
 *
 * Read from `SERVICE_TEMPLATES` every time rather than copied: the template list
 * is Deploy's, and a template added there or taken out is on the shelf or off it
 * with nothing to change here. What the store needs and the template does not
 * say - which shelf category it sits on - is the one thing kept here, keyed by
 * template id, and a template it does not name sits under Tools.
 *
 * An entry's id is `template-<template id>`, so it can never be mistaken for a
 * catalog app of the same name. Deploying one is Deploy's own template flow,
 * into a project the reader picks: nothing here creates a service.
 */

import { LayoutTemplate } from "lucide-react";
import type { AppCategory, AppManifest } from "./catalog";
import { SERVICE_TEMPLATES, serviceTemplate, type ServiceTemplate } from "@polaris/core";

export const TEMPLATE_APP_PREFIX = "template-";

const TEMPLATE_CATEGORIES: Readonly<Record<string, AppCategory>> = {
    anythingllm: "AI",
    flowise: "AI",
    langflow: "AI",
    "open-webui": "AI",
    gotify: "Messaging",
    mattermost: "Messaging",
    ntfy: "Messaging",
    actual: "Productivity",
    "calibre-web": "Productivity",
    directus: "Productivity",
    freshrss: "Productivity",
    ghost: "Productivity",
    gitea: "Productivity",
    grav: "Productivity",
    linkding: "Productivity",
    memos: "Productivity",
    metabase: "Productivity",
    miniflux: "Productivity",
    n8n: "Productivity",
    nextcloud: "Productivity",
    nocodb: "Productivity",
    "paperless-ngx": "Productivity",
    "stirling-pdf": "Productivity",
    vikunja: "Productivity",
    wikijs: "Productivity",
    wordpress: "Productivity"
};

/** The store entry for one template. */
export function templateApp(template: ServiceTemplate): AppManifest {
    return {
        id: `${TEMPLATE_APP_PREFIX}${template.id}`,
        name: template.name,
        category: TEMPLATE_CATEGORIES[template.id] ?? "Tools",
        icon: LayoutTemplate,
        summary: template.description,
        description: template.description,
        installMethod: "deploy-template",
        deployTemplate: template.id,
        capabilities: [],
        dashboard: "generic"
    };
}

/** Every template, as store entries, in the order Deploy lists them. */
export function templateApps(): AppManifest[] {
    return SERVICE_TEMPLATES.map(templateApp);
}

/** The entry for `id`, when it names a template Deploy has. */
export function findTemplateApp(id: string): AppManifest | undefined {
    if (!id.startsWith(TEMPLATE_APP_PREFIX)) return undefined;
    const template = serviceTemplate(id.slice(TEMPLATE_APP_PREFIX.length));
    return template ? templateApp(template) : undefined;
}
