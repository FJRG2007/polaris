"use client";

/**
 * The facts of an account and the three switches that decide its reach: the
 * role, opening the account as them, and administrator access.
 */

import type { ReactNode } from "react";
import { Eye, Shield } from "lucide-react";
import { useRouter } from "next/navigation";
import type { RoleOption } from "@/lib/role-service";
import { useAccountAction } from "./use-account-action";
import type { UserOverviewAccount } from "./data";
import { viewAsUserAction } from "@/app/(app)/view-as-actions";
import { useDisplayFormat } from "@/components/display-format";
import { useTranslations } from "@/components/i18n/i18n-provider";
import { Button, Card, CardBody, Select, Switch } from "@polaris/ui";
import { setAdminAccessAction, setUserRoleAction } from "../actions";

/** A labelled fact in the identity grid. */
function Fact({ label, children }: { label: string; children: ReactNode }) {
    return (
        <div className="min-w-0">
            <dt className="text-xs text-muted-foreground">{label}</dt>
            <dd className="truncate text-sm">{children}</dd>
        </div>
    );
}

export function OverviewControls({
    user,
    roles,
    isSelf
}: {
    user: UserOverviewAccount;
    /** Every role this instance defines, for the picker. */
    roles: RoleOption[];
    isSelf: boolean;
}) {
    const t = useTranslations("admin");
    const router = useRouter();
    const format = useDisplayFormat();
    const { busy, error, run } = useAccountAction();
    const role = user.roles[0] ?? "";

    /** Leave the operator screens behind and carry on as this person. The root
     *  resolves where their own access starts, which is rarely where you are. */
    async function onViewAs() {
        if (await run(() => viewAsUserAction(user.id))) router.push("/");
    }

    return (
        <Card>
            <CardBody className="flex flex-col gap-5">
                <dl className="grid grid-cols-2 gap-3 sm:grid-cols-3">
                    <Fact label={t("usersDetail.account.facts.username")}>
                        {user.username ?? "-"}
                    </Fact>
                    <Fact label={t("usersDetail.account.facts.company")}>
                        {user.company ?? "-"}
                    </Fact>
                    <Fact label={t("usersDetail.account.facts.joined")}>
                        {format.date(user.createdAt)}
                    </Fact>
                    <Fact label={t("usersDetail.account.facts.email")}>
                        {user.emailVerified
                            ? t("usersDetail.account.facts.verified")
                            : t("usersDetail.account.facts.unverified")}
                    </Fact>
                    <Fact label={t("usersDetail.account.facts.twoFactor")}>
                        {user.twoFactorEnabled
                            ? t("usersDetail.account.facts.on")
                            : t("usersDetail.account.facts.off")}
                    </Fact>
                    <Fact label={t("usersDetail.account.facts.groups")}>
                        {user.groups.length > 0 ? user.groups.join(", ") : "-"}
                    </Fact>
                </dl>

                <section className="flex flex-col gap-3 border-t border-border pt-4">
                    <h2 className="text-sm font-medium">{t("usersDetail.account.access.title")}</h2>
                    <div className="flex items-center justify-between gap-3">
                        <div className="min-w-0">
                            <p className="text-sm">{t("usersDetail.account.access.role")}</p>
                            <p className="text-xs text-muted-foreground">
                                {t("usersDetail.account.access.roleHint")}
                            </p>
                        </div>
                        <Select
                            className="w-40"
                            aria-label={t("usersDetail.account.access.roleLabel", {
                                name: user.name
                            })}
                            value={role}
                            placeholder={t("usersDetail.account.access.noRole")}
                            disabled={busy}
                            onValueChange={(next) =>
                                void run(() => setUserRoleAction(user.id, next))
                            }
                            options={roles.map((option) => ({
                                value: option.name,
                                label: option.name
                            }))}
                        />
                    </div>
                    <div className="flex items-center justify-between gap-3">
                        <div className="min-w-0">
                            <p className="flex items-center gap-1.5 text-sm">
                                <Eye className="size-4 shrink-0 text-muted-foreground" />
                                {t("usersDetail.account.access.openAccount")}
                            </p>
                            <p className="text-xs text-muted-foreground">
                                {t("usersDetail.account.access.openHint", { name: user.name })}
                            </p>
                        </div>
                        <Button
                            size="sm"
                            variant="ghost"
                            disabled={busy || isSelf}
                            onClick={() => void onViewAs()}
                        >
                            <Eye className="size-4" />
                            {t("usersDetail.account.access.open")}
                        </Button>
                    </div>
                    <div className="flex items-center justify-between gap-3">
                        <div className="min-w-0">
                            <p className="flex items-center gap-1.5 text-sm">
                                <Shield className="size-4 shrink-0 text-muted-foreground" />
                                {t("usersDetail.account.access.admin")}
                            </p>
                            <p className="text-xs text-muted-foreground">
                                {t("usersDetail.account.access.adminHint")}
                            </p>
                        </div>
                        <Switch
                            checked={user.isAdmin}
                            disabled={busy || isSelf}
                            aria-label={t("usersDetail.account.access.adminLabel", {
                                name: user.name
                            })}
                            onChange={(checked) =>
                                void run(() => setAdminAccessAction(user.id, checked))
                            }
                        />
                    </div>
                </section>

                {error ? <p className="text-sm text-danger">{error}</p> : null}
            </CardBody>
        </Card>
    );
}
