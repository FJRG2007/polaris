import { redirect } from "next/navigation";

/** The dashboard root lands on the Drive app. */
export default function DashboardIndex() {
    redirect("/drive");
}
