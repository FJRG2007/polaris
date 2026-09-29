"use client";

import { Card, CardBody } from "@polaris/ui";
import { useTranslations } from "@/components/i18n/i18n-provider";

/**
 * One answer for every reason a page is not being shown.
 *
 * No such account, one that keeps itself out of being found, a block, or a
 * deployment that does not publish profiles at all - telling them apart tells
 * somebody working through a list of handles which it was, and that is the whole
 * value of the list.
 *
 * The single exception is a reader with no session on a deployment that publishes
 * nothing: that is a fact about this Polaris rather than about anybody in it, and
 * leaving it unsaid sends them looking for a spelling mistake that is not there.
 */
export function NothingToShow({ closed, subject }: { closed: boolean; subject: "profile" | "organization" }) {
    const t = useTranslations("components");
    return (
        <Card>
            <CardBody className="flex flex-col gap-2 py-10 text-center">
                <p className="text-sm font-medium">{t("profileFrame.nothing")}</p>
                <p className="text-muted-foreground mx-auto max-w-md text-sm">
                    {closed
                        ? t("profileFrame.closed")
                        : subject === "organization"
                          ? t("profileFrame.noOrganization")
                          : t("profileFrame.noProfile")}
                </p>
            </CardBody>
        </Card>
    );
}
