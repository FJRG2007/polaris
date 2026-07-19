import Link from "next/link";
import { Folder, Star } from "lucide-react";
import { Card, CardBody, PageHeader } from "@polaris/ui";
import { requirePermission } from "@/lib/session";
import { listFavorites } from "@/lib/drive-meta-service";

export const dynamic = "force-dynamic";

/** The last path segment (an item's display name). */
function baseName(path: string): string {
    const slash = path.lastIndexOf("/");
    return slash >= 0 ? path.slice(slash + 1) : path;
}

/** Parent folder of a path, for a link that reveals the item in its folder. */
function parentOf(path: string): string {
    const slash = path.lastIndexOf("/");
    return slash >= 0 ? path.slice(0, slash) : "";
}

export default async function FavoritesPage() {
    const user = await requirePermission("drive.read");
    const favorites = await listFavorites(user.id);

    return (
        <>
            <PageHeader title="Favorites" description="Files and folders you have starred, across every connection." />
            {favorites.length === 0 ? (
                <Card>
                    <CardBody className="p-8 text-center text-sm text-muted-foreground">
                        No favorites yet. Right-click any file or folder and choose &quot;Add to favorites&quot;.
                    </CardBody>
                </Card>
            ) : (
                <div className="flex flex-col gap-2">
                    {favorites.map((item) => {
                        const parent = parentOf(item.path);
                        const query = new URLSearchParams({ c: item.connectionId });
                        if (parent) query.set("p", parent);
                        return (
                            <Card key={`${item.connectionId}:${item.path}`}>
                                <Link href={`/drive?${query.toString()}`}>
                                    <CardBody className="flex items-center gap-3">
                                        <Star className="size-4 shrink-0 fill-amber-400 text-amber-400" />
                                        <div className="min-w-0">
                                            <p className="truncate text-sm font-medium">{baseName(item.path)}</p>
                                            <p className="flex items-center gap-1 truncate text-xs text-muted-foreground">
                                                <Folder className="size-3 shrink-0" />
                                                {item.connectionName}
                                                {parent ? ` / ${parent}` : ""}
                                            </p>
                                        </div>
                                    </CardBody>
                                </Link>
                            </Card>
                        );
                    })}
                </div>
            )}
        </>
    );
}
