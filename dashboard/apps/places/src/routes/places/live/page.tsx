/**
 * Where the camera wall used to be. It is the cameras page now, which shows the
 * same wall and manages it too; this keeps old bookmarks and links working.
 */

import { redirect } from "next/navigation";

export const dynamic = "force-dynamic";

export default function LivePage(): never {
    redirect("/places/cameras");
}
