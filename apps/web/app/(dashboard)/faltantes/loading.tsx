import { Skeleton } from "@/app/_components/ui/skeleton";

// Faltantes loading skeleton — approximates: page header + list rows.
export default function FaltantesLoading() {
  return (
    <div className="space-y-6">
      {/* Page header placeholder */}
      <div className="space-y-2">
        <Skeleton className="h-8 w-32" />
        <Skeleton className="h-4 w-96" />
      </div>

      {/* Missing items list placeholder */}
      <div className="space-y-3">
        <Skeleton className="h-16 w-full" />
        <Skeleton className="h-16 w-full" />
        <Skeleton className="h-16 w-full" />
        <Skeleton className="h-16 w-4/5" />
      </div>
    </div>
  );
}
