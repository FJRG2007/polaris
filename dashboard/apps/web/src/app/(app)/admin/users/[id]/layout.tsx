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
import { UserRecordHeader } from "./loaders";
import { UserSectionNav } from "./section-nav";
import { getTranslations } from "@/lib/i18n/request";

export const dynamic = "force-dynamic";

/** The way back and the tabs paint at once; the name over them is asked for after. */
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
            <UserRecordHeader userId={id} revision={Date.now()} />
            <UserSectionNav userId={id} />
            {children}
        </>
    );
}
