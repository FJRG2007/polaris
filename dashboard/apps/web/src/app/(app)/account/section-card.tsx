/**
 * A titled block on one of the account's own screens.
 *
 * A heading, one line saying what the block is for, and whatever it holds. It is
 * a component rather than the same twelve lines on each screen because the
 * profile and the account are now two pages that have to look like two halves of
 * one thing.
 *
 * Deliberately quieter than a card header: these are sections of a page somebody
 * reads top to bottom, not cards competing for the eye.
 */

import type { ReactNode } from "react";
import { Card, CardBody } from "@polaris/ui";

export function SectionCard({
    title,
    description,
    children
}: {
    title: string;
    description: string;
    children: ReactNode;
}) {
    return (
        <Card>
            <CardBody className="flex flex-col gap-3">
                <div>
                    <h2 className="text-sm font-medium">{title}</h2>
                    <p className="text-xs text-muted-foreground">{description}</p>
                </div>
                {children}
            </CardBody>
        </Card>
    );
}
