/**
 * Tools > Images.
 *
 * The server draws the heading and hands over; the picture, and everything done
 * to it, belongs to the browser. There is nothing to fetch here - the screen is
 * empty until somebody chooses a file - so blocking the page on anything would
 * be blocking it on nothing.
 */

import { PageHeader } from "@polaris/ui";
import { ImagesView } from "./images-view";
import { requireToolsReach } from "@/lib/tools/access";

export const dynamic = "force-dynamic";

export default async function ToolsImagesPage() {
    await requireToolsReach();

    return (
        <div className="mx-auto flex w-full max-w-5xl flex-col gap-6">
            <PageHeader
                title="Images"
                description="Convert, resize and make a picture smaller - and see what each choice costs."
            />
            <ImagesView />
        </div>
    );
}
