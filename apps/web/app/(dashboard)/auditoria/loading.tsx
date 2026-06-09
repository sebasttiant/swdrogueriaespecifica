import { Skeleton } from "@/app/_components/ui/skeleton";

// Auditoría loading skeleton — approximates: page header + audit log list rows.
export default function AuditoriaLoading() {
  return (
    <div className="space-y-6">
      {/* Page header placeholder */}
      <div className="space-y-2">
        <Skeleton className="h-8 w-28" />
        <Skeleton className="h-4 w-96" />
      </div>

      {/* Audit log list placeholder (mobile cards) */}
      <div className="space-y-3 lg:hidden">
        <Skeleton className="h-20 w-full" />
        <Skeleton className="h-20 w-full" />
        <Skeleton className="h-20 w-full" />
        <Skeleton className="h-20 w-full" />
        <Skeleton className="h-20 w-4/5" />
      </div>

      {/* Desktop table placeholder */}
      <Skeleton className="hidden h-64 w-full lg:block" />
    </div>
  );
}
