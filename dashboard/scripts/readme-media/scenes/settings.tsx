/** Settings: the deployment's own page, with an update waiting. */

import { PageHeader } from "@polaris/ui";
import { Chrome } from "../runtime/chrome";
import { label } from "../runtime/interact";
import { defineScene } from "../runtime/scene";
import { TEAM, VIEWER } from "../fixtures/people";
import { SecurityView } from "@/app/(app)/account/security/security-view";
import { SettingsView } from "@/app/(app)/admin/settings/settings-view";
import { TransferCard } from "@/app/(app)/admin/settings/transfer-card";
import { SeasonalAdminCard } from "@/app/(app)/admin/settings/seasonal-card";
import { DEPLOYMENT, quietUpdateLog, settingsOverview, updateStatus } from "../fixtures/settings";

export const settings = defineScene({
    id: "settings",
    path: "/admin/settings",
    actions: (ctx) => ({ checkUpdatesAction: () => updateStatus(ctx) }),
    api: (ctx) => ({
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
                        { method: "totp", enabled: true, available: true, target: null, blocker: null },
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
