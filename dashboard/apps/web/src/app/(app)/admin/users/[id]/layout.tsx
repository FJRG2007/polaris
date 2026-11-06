/**
 * One person, split into sections that each load only their own data.
 *
 * The header and the section links are all the layout draws: the name, the
 * address and the badges come from the one directory read every section shares.
 */

import Link from "next/link";
import type { ReactNode } from "react";
import { ArrowLeft } from "lucide-react";
import { requireAdmin } from "@/lib/session";
import { loadUserRecord } from "./user-record";
import { UserSectionNav } from "./section-nav";
import { Badge, PageHeader } from "@polaris/ui";
import { getTranslations } from "@/lib/i18n/request";

export const dynamic = "force-dynamic";

export default async function UserRecordLayout({
    params,
    children
}: {
    params: Promise<{ id: string }>;
    children: ReactNode;
}) {
    await requireAdmin();
    const t = await getTranslations("admin");
    const { id } = await params;
    const account = await loadUserRecord(id);

    return (
        <>
            {/* Above the name, because that is where somebody looks for the way
                back out of a record they opened from a list. */}
            <Link
                href="/admin/users"
                className="mb-2 flex w-fit items-center gap-1 text-sm text-muted-foreground transition-colors hover:text-foreground"
            >
                <ArrowLeft className="size-4 shrink-0" aria-hidden="true" />
                {t("usersDetail.back")}
            </Link>
            <PageHeader
                title={account.name}
                description={account.email}
                actions={
                    <>
                        {account.isAdmin ? (
                            <Badge variant="primary">{t("usersDetail.badges.admin")}</Badge>
                        ) : null}
                        {account.banned ? (
                            <Badge variant="danger">{t("usersDetail.badges.banned")}</Badge>
                        ) : null}
                    </>
                }
            />
            <UserSectionNav userId={account.id} />
            {children}
        </>
    );
}
