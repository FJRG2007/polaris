/**
 * The captured layout of each screen, drawn while the real page resolves.
 *
 * The `.bones.json` files beside this one are generated - see
 * dashboard/docs/skeletons.md for how to record them. This list is not: add a
 * line when a screen earns a capture, and drop one when its route goes.
 */

import routeAdmin from "./route-admin.bones.json";
import routeDrive from "./route-drive.bones.json";
import routeInbox from "./route-inbox.bones.json";
import routeTasks from "./route-tasks.bones.json";
import routeTrash from "./route-trash.bones.json";
import routeWatch from "./route-watch.bones.json";
import type { ResponsiveLayout } from "@polaris/ui";
import routeAccount from "./route-account.bones.json";
import routeSettings from "./route-settings.bones.json";
import routeFavorites from "./route-favorites.bones.json";
import routeTelemetry from "./route-telemetry.bones.json";
import routeAnalytics from "./route-analytics.bones.json";
import routeInboxLogs from "./route-inbox-logs.bones.json";
import routeTasksDocs from "./route-tasks-docs.bones.json";
import routeTasksTime from "./route-tasks-time.bones.json";
import routeAdminEmail from "./route-admin-email.bones.json";
import routeAdminUsers from "./route-admin-users.bones.json";
import routeAppsDeploy from "./route-apps-deploy.bones.json";
import routeTasksGoals from "./route-tasks-goals.bones.json";
import routeAdminGroups from "./route-admin-groups.bones.json";
import routeAppsBackups from "./route-apps-backups.bones.json";
import routeAppsRunners from "./route-apps-runners.bones.json";
import routeAppsServers from "./route-apps-servers.bones.json";
import routeDriveRecent from "./route-drive-recent.bones.json";
import routeWatchAlarms from "./route-watch-alarms.bones.json";
import routeIntegrations from "./route-integrations.bones.json";
import routeAdminDisplay from "./route-admin-display.bones.json";
import routeAdminDomains from "./route-admin-domains.bones.json";
import routeAppsFirewall from "./route-apps-firewall.bones.json";
import routeTasksReports from "./route-tasks-reports.bones.json";
import routeTasksSprints from "./route-tasks-sprints.bones.json";
import routeWatchServers from "./route-watch-servers.bones.json";
import routeAccountAccess from "./route-account-access.bones.json";
import routeAdminActivity from "./route-admin-activity.bones.json";
import routeAdminPolicies from "./route-admin-policies.bones.json";
import routeDriveOverview from "./route-drive-overview.bones.json";
import routeInboxChannels from "./route-inbox-channels.bones.json";
import routeInboxContacts from "./route-inbox-contacts.bones.json";
import routeWatchServices from "./route-watch-services.bones.json";
import routeWatchWebhooks from "./route-watch-webhooks.bones.json";
import routeAppsContainers from "./route-apps-containers.bones.json";
import routeAnalyticsSites from "./route-analytics-sites.bones.json";
import routeAnalyticsPages from "./route-analytics-pages.bones.json";
import routeAccountApiKeys from "./route-account-api-keys.bones.json";
import routeAccountSecurity from "./route-account-security.bones.json";
import routeAccountSessions from "./route-account-sessions.bones.json";
import routeAppsMarketplace from "./route-apps-marketplace.bones.json";
import routeTasksEverything from "./route-tasks-everything.bones.json";
import routeWatchContainers from "./route-watch-containers.bones.json";
import routeTelemetryIssues from "./route-telemetry-issues.bones.json";
import routeAnalyticsEvents from "./route-analytics-events.bones.json";
import routeDriveDropPoints from "./route-drive-drop-points.bones.json";
import routeAnalyticsSources from "./route-analytics-sources.bones.json";
import routeAnalyticsReports from "./route-analytics-reports.bones.json";
import routeDriveSharedLinks from "./route-drive-shared-links.bones.json";
import routeAnalyticsRealtime from "./route-analytics-realtime.bones.json";
import routeAnalyticsSessions from "./route-analytics-sessions.bones.json";
import routeAnalyticsSettings from "./route-analytics-settings.bones.json";
import routeAnalyticsSitesNew from "./route-analytics-sites-new.bones.json";
import routeAccountPreferences from "./route-account-preferences.bones.json";
import routeAnalyticsGeography from "./route-analytics-geography.bones.json";
import routeAccountNotifications from "./route-account-notifications.bones.json";
import routeInboxChannelsConnect from "./route-inbox-channels-connect.bones.json";

export const ROUTE_BONES: Record<string, ResponsiveLayout | undefined> = {
    "route-account": routeAccount,
    "route-account-access": routeAccountAccess,
    "route-account-api-keys": routeAccountApiKeys,
    "route-account-notifications": routeAccountNotifications,
    "route-account-preferences": routeAccountPreferences,
    "route-account-security": routeAccountSecurity,
    "route-account-sessions": routeAccountSessions,
    "route-admin": routeAdmin,
    "route-admin-activity": routeAdminActivity,
    "route-admin-display": routeAdminDisplay,
    "route-admin-domains": routeAdminDomains,
    "route-admin-email": routeAdminEmail,
    "route-admin-groups": routeAdminGroups,
    "route-admin-policies": routeAdminPolicies,
    "route-admin-users": routeAdminUsers,
    "route-analytics": routeAnalytics,
    "route-analytics-events": routeAnalyticsEvents,
    "route-analytics-geography": routeAnalyticsGeography,
    "route-analytics-pages": routeAnalyticsPages,
    "route-analytics-realtime": routeAnalyticsRealtime,
    "route-analytics-reports": routeAnalyticsReports,
    "route-analytics-sessions": routeAnalyticsSessions,
    "route-analytics-settings": routeAnalyticsSettings,
    "route-analytics-sites": routeAnalyticsSites,
    "route-analytics-sites-new": routeAnalyticsSitesNew,
    "route-analytics-sources": routeAnalyticsSources,
    "route-apps-backups": routeAppsBackups,
    "route-apps-containers": routeAppsContainers,
    "route-apps-deploy": routeAppsDeploy,
    "route-apps-firewall": routeAppsFirewall,
    "route-apps-marketplace": routeAppsMarketplace,
    "route-apps-runners": routeAppsRunners,
    "route-apps-servers": routeAppsServers,
    "route-drive": routeDrive,
    "route-drive-drop-points": routeDriveDropPoints,
    "route-drive-overview": routeDriveOverview,
    "route-drive-recent": routeDriveRecent,
    "route-drive-shared-links": routeDriveSharedLinks,
    "route-favorites": routeFavorites,
    "route-inbox": routeInbox,
    "route-inbox-channels": routeInboxChannels,
    "route-inbox-channels-connect": routeInboxChannelsConnect,
    "route-inbox-contacts": routeInboxContacts,
    "route-inbox-logs": routeInboxLogs,
    "route-integrations": routeIntegrations,
    "route-settings": routeSettings,
    "route-tasks": routeTasks,
    "route-tasks-docs": routeTasksDocs,
    "route-tasks-everything": routeTasksEverything,
    "route-tasks-goals": routeTasksGoals,
    "route-tasks-reports": routeTasksReports,
    "route-tasks-sprints": routeTasksSprints,
    "route-tasks-time": routeTasksTime,
    "route-telemetry": routeTelemetry,
    "route-telemetry-issues": routeTelemetryIssues,
    "route-trash": routeTrash,
    "route-watch": routeWatch,
    "route-watch-alarms": routeWatchAlarms,
    "route-watch-containers": routeWatchContainers,
    "route-watch-servers": routeWatchServers,
    "route-watch-services": routeWatchServices,
    "route-watch-webhooks": routeWatchWebhooks
};
