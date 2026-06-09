import { Skeleton } from "@/app/_components/ui/skeleton";

// Productos loading skeleton — approximates: page header + (optional form card) + product list rows.
export default function ProductosLoading() {
  return (
    <div className="space-y-6">
      {/* Page header placeholder */}
      <div className="space-y-2">
        <Skeleton className="h-8 w-32" />
        <Skeleton className="h-4 w-56" />
      </div>

      {/* Product list rows placeholder */}
      <div className="space-y-3">
        <Skeleton className="h-16 w-full" />
        <Skeleton className="h-16 w-full" />
        <Skeleton className="h-16 w-full" />
        <Skeleton className="h-16 w-full" />
        <Skeleton className="h-16 w-4/5" />
      </div>
    </div>
  );
}
