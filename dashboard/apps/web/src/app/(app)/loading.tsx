import { RouteSkeleton } from "@/components/route-skeleton";

/**
 * What every dashboard screen shows while its own page is still resolving.
 *
 * Next renders this the moment a navigation starts, so the chrome stays put and
 * the content area sketches what is coming instead of the previous page sitting
 * there looking clickable. The sketch is the recorded shape of the screen being
 * opened, so what appears is where the real content lands.
 */
export default function Loading() {
    return <RouteSkeleton />;
}
