/** Settings: the deployment's own page, with an update waiting. */

import { PageHeader } from "@polaris/ui";
import { Chrome } from "../runtime/chrome";
import { label } from "../runtime/interact";
import { defineScene } from "../runtime/scene";
import { toWire } from "@/lib/app-bundles/wire";
import { TEAM, VIEWER } from "../fixtures/people";
import { SecurityView } from "@/app/(app)/account/security/security-view";
import { SettingsView } from "@/app/(app)/admin/settings/settings-view";
import { TransferCard } from "@/app/(app)/admin/settings/transfer-card";
import { SeasonalAdminCard } from "@/app/(app)/admin/settings/seasonal-card";
import { RolesAdmin } from "@/app/(app)/admin/roles/roles-admin";
import { DEFAULT_ROLES, PERMISSIONS, expandPermissions, type Permission } from "@polaris/core";
import type { RoleView } from "@/lib/role-service";
import { UsersAdmin } from "@/app/(app)/admin/users/users-admin";
import {
    DEPLOYMENT,
    ROLE_OPTIONS,
    directory,
    pendingInvites,
    quietUpdateLog,
    settingsOverview,
    updateStatus
} from "../fixtures/settings";

export const settings = defineScene({
    id: "settings",
    path: "/admin/settings",
    api: (ctx) => ({
        "GET /api/admin/settings/update-status": () => ({ value: toWire(updateStatus(ctx)) }),
        "GET /api/admin/settings/overview": () => settingsOverview(ctx),
        "GET /api/updates/logs": () => quietUpdateLog(ctx)
    }),
    // The page `/admin/settings` draws, with what it would have read.
    render: (ctx) => (
        <Chrome>
            <div className="mx-auto flex w-full max-w-2xl flex-col">
                <PageHeader
                    title={label(ctx.locale, "admin.settings.page.title")}
                    description={label(ctx.locale, "admin.settings.page.description")}
                />
                <SettingsView
                    initialPolicy={{ mode: "daily", at: "05:00" }}
                    initialSource="image"
                    initialContact="privacy@example.com"
                    publicPages={{
                        home: "https://polaris.example.com/about",
                        privacy: "https://polaris.example.com/legal/privacy",
                        terms: "https://polaris.example.com/legal/terms"
                    }}
                    deployment={DEPLOYMENT}
                />
                <SeasonalAdminCard initial />
                <TransferCard identity={[VIEWER.email, VIEWER.name]} />
            </div>
        </Chrome>
    )
});

/** Their own account's security: how it is proven and how long a session lasts. */
export const accountSecurity = defineScene({
    id: "account-security",
    path: "/account/security",
    actions: () => ({ stepUpRemainingAction: () => ({ remainingMs: 0 }) }),
    // The page `/account/security` draws, with what it would have read.
    render: (ctx) => (
        <Chrome>
            <div className="mx-auto flex w-full max-w-7xl flex-col gap-4">
                <div>
                    <h1 className="text-[1.0625rem] font-semibold tracking-tight">
                        {label(ctx.locale, "accountSecurity.page.title")}
                    </h1>
                    <p className="text-sm text-muted-foreground">
                        {label(ctx.locale, "accountSecurity.page.intro")}
                    </p>
                </div>
                <SecurityView
                    account={VIEWER.email}
                    newDeviceGraceDays={3}
                    hasPin
                    idleLockMinutes={15}
                    bindSessionsToClient
                    pinSessionsToAddress="mobile"
                    standing={{
                        lockedDown: false,
                        lockdownSince: null,
                        lockdownNote: "",
                        closure: null,
                        daysLeft: 0
                    }}
                    sessionMaxMinutes={60 * 24 * 7}
                    requireLoginApproval={false}
                    emailLinkSignIn={false}
                    usernameSignIn
                    username="alex"
                    canSendMail
                    twoFactorEnabled
                    backupCodesRemaining={8}
                    questions={[]}
                    passkeys={[]}
                    twoFactorMethods={[
                        {
                            method: "totp",
                            enabled: true,
                            available: true,
                            target: null,
                            blocker: null
                        },
                        {
                            method: "email",
                            enabled: true,
                            available: true,
                            target: "a***@example.com",
                            blocker: null
                        },
                        {
                            method: "whatsapp",
                            enabled: false,
                            available: false,
                            target: null,
                            blocker: null
                        }
                    ]}
                    twoFactorPreferred="totp"
                    trustedDevices={2}
                    connections={[
                        {
                            id: "fixture-connection-github",
                            provider: "github",
                            providerName: "GitHub",
                            label: "alex-rivera",
                            signInEnabled: true,
                            allowedHere: true
                        }
                    ]}
                    connectionChallenge={{ enabled: true, enforced: false }}
                    otherSessions={2}
                    successor={{ userId: TEAM.ana.id, name: TEAM.ana.name, contact: "@ana" }}
                />
            </div>
        </Chrome>
    )
});

/** A role as `/admin/roles` reads it: the seeded grants, or a list of its own. */
function role(n: number, name: string, memberCount: number, grants?: Permission[]): RoleView {
    const seeded = DEFAULT_ROLES[name];
    const wildcard = seeded?.includes("*") ?? false;
    const own = grants ?? ((seeded ?? []).filter((one) => one !== "*") as Permission[]);
    return {
        id: `00000000-0000-4000-8000-0000000000${String(n).padStart(2, "0")}`,
        name,
        isSystem: Boolean(seeded),
        wildcard,
        permissions: wildcard ? [...PERMISSIONS] : expandPermissions(own),
        memberCount
    };
}

/** Who may do what: the seeded roles and one the organization made, each a
 *  grid of the permissions it holds. */
export const settingsRoles = defineScene({
    id: "settings-roles",
    path: "/admin/roles",
    render: (ctx) => (
        <Chrome>
            <div className="mx-auto flex w-full max-w-4xl flex-col">
                <PageHeader
                    title={label(ctx.locale, "admin.roles.page.title")}
                    description={label(ctx.locale, "admin.roles.page.description")}
                />
                <RolesAdmin
                    roles={[
                        role(1, "admin", 2),
                        role(2, "member", 7),
                        role(3, "support", 2, [
                            "chat.use",
                            "chat.attach",
                            "chat.call",
                            "inbox.read",
                            "inbox.manage",
                            "tasks.read",
                            "tasks.manage",
                            "drive.read",
                            "games.read",
                            "games.moderate"
                        ]),
                        role(4, "viewer", 1),
                        role(5, "guest", 3)
                    ]}
                />
            </div>
        </Chrome>
    ),
    // The admin card says only that it holds everything; the first grid worth
    // reading is the member role's, so its card is brought up whole.
    prepare: () => {
        const title = [...document.querySelectorAll("h3")].find(
            (element) => element.textContent?.trim() === "member"
        );
        const card = title?.closest<HTMLElement>(".rounded-xl, [class*=rounded]") ?? title;
        if (!card) throw new Error("no member role");
        card.style.scrollMarginTop = "4.5rem";
        card.scrollIntoView({ block: "start" });
    }
});

/** Who is in: every account with its roles and access - admins, a support role,
 *  a guest limited to one country, one suspended - and the invitations waiting. */
export const settingsUsers = defineScene({
    id: "settings-users",
    path: "/admin/users",
    actions: (ctx) => ({ listUserDirectoryAction: () => directory(ctx) }),
    // The page `/admin/users` draws, with what it would have read.
    render: (ctx) => (
        <Chrome>
            <div className="mx-auto flex w-full max-w-5xl flex-col">
                <PageHeader
                    title={label(ctx.locale, "admin.users.page.title")}
                    description={label(ctx.locale, "admin.users.page.description")}
                />
                <UsersAdmin
                    first={directory(ctx)}
                    invites={pendingInvites(ctx)}
                    recoveries={[]}
                    groups={[]}
                    roles={ROLE_OPTIONS}
                    canSendMail
                    viewerId={VIEWER.id}
                />
            </div>
        </Chrome>
    )
});
