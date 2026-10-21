/**
 * /account/polar-tools moved into Polar's settings page. The address stays for
 * links already out there and for a connector sign-in that started before an
 * update, carrying its `?connector=` answer along.
 */

import { redirect } from "next/navigation";
import { polarToolsTarget } from "@/lib/polar/settings-path";

export default async function PolarToolsPage({
    searchParams
}: {
    searchParams: Promise<{ connector?: string | string[] }>;
}) {
    redirect(polarToolsTarget((await searchParams).connector));
}
