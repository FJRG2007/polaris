/**
 * Every read a Management screen asks for after its shell has painted, by the
 * name its route answers to (`/api/admin/paint/<name>`).
 *
 * A route, not a server action: the actions one tab sends run one at a time, so
 * a screen with two regions, or a region next to a panel that reads on open,
 * waited for each read behind the others. GETs go out together. Each read is
 * the same server action the screen would have called, so the permission is
 * asked again inside it, and the query is checked against its schema before it
 * is run.
 */

import { z } from "zod";
import * as agents from "./agents/data";
import * as apps from "./apps/data";
import * as appSettings from "./apps/[appId]/settings/data";
import * as billing from "./billing/data";
import * as diagnostics from "./diagnostics/data";
import * as email from "./email/data";
import * as channels from "./email/channels/data";
import * as integrations from "./integrations/data";
import * as models from "./integrations/models/data";
import * as retention from "./retention/data";
import * as safety from "./safety/data";
import * as seasonal from "./seasonal-themes/data";
import * as settings from "./settings/data";
import * as updates from "./updates/data";
import * as uploads from "./uploads/data";
import * as user from "./users/[id]/data";

const none = z.object({});
const person = z.object({ id: z.string().trim().min(1).max(200) });

/** `inbox` marks a read held by whoever holds `inbox.read` (Email & SMS and its
 *  channels), not the operator alone. */
function read<Q extends z.ZodTypeAny, A>(
    query: Q,
    run: (input: z.infer<Q>) => Promise<A>,
    inbox = false
) {
    return { query, run, inbox };
}

export const PAINT_READS = {
    "users.sessions": read(person, ({ id }) => user.loadUserSessionsAction(id)),
    "users.overview": read(person, ({ id }) => user.loadUserOverviewAction(id)),
    "users.access": read(person, ({ id }) => user.loadUserAccessAction(id)),
    "users.security": read(person, ({ id }) => user.loadUserSecurityAction(id)),
    "users.danger": read(person, ({ id }) => user.loadUserDangerAction(id)),
    agents: read(none, () => agents.loadAgentsAdminAction()),
    apps: read(none, () => apps.loadPolarisAppsAction()),
    "apps.settings": read(z.object({ appId: z.string().trim().min(1).max(100) }), ({ appId }) =>
        appSettings.loadAppSettingsAction(appId)
    ),
    "billing.rates": read(none, () => billing.loadBillingRatesAction()),
    diagnostics: read(none, () => diagnostics.loadDiagnosticsAction()),
    email: read(none, () => email.loadEmailAdminAction(), true),
    channels: read(none, () => channels.loadChannelsAction(), true),
    integrations: read(none, () => integrations.loadIntegrationsAction()),
    "integrations.runners": read(none, () => integrations.loadRunnerAccessAction()),
    "integrations.models": read(none, () => models.loadModelProvidersAction()),
    retention: read(none, () => retention.loadRetentionAction()),
    safety: read(z.object({ status: z.string().trim().max(40).optional() }), ({ status }) =>
        safety.loadSafetyAction(status)
    ),
    seasonal: read(none, () => seasonal.loadSeasonalAdminAction()),
    settings: read(none, () => settings.loadSettingsAdminAction()),
    "settings.cards": read(none, () => settings.loadSettingsCardsAction()),
    updates: read(none, () => updates.loadUpdatesAdminAction()),
    uploads: read(none, () => uploads.loadUploadsAction())
};

export type PaintReadName = keyof typeof PAINT_READS;
export type PaintQuery<K extends PaintReadName> = z.input<(typeof PAINT_READS)[K]["query"]>;
export type PaintAnswer<K extends PaintReadName> = Awaited<
    ReturnType<(typeof PAINT_READS)[K]["run"]>
>;
