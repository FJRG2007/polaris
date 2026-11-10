import { SectionSkeleton } from "../section-skeleton";

export default function Loading() {
    return <SectionSkeleton parts={[{ kind: "banner" }, { kind: "table", count: 6 }, { kind: "rows", count: 3 }]} />;
}
