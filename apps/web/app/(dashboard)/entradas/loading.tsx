import { Skeleton } from "@/app/_components/ui/skeleton";

// Entradas loading skeleton — approximates: page header + content card.
export default function EntradasLoading() {
  return (
    <div className="space-y-6">
      {/* Page header placeholder */}
      <div className="space-y-2">
        <Skeleton className="h-8 w-44" />
        <Skeleton className="h-4 w-72" />
      </div>

      {/* Content card placeholder */}
      <Skeleton className="h-20 w-full" />
    </div>
  );
}
