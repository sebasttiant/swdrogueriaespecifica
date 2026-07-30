import { Card, CardTitle } from "@/app/_components/ui/card";
import { formatBogotaDate } from "@/lib/datetime/bogota";
import type { MyMissingReport } from "@/server/repositories/missing-report.repository";

const LABELS = {
  PENDING_REVIEW: "En revisión",
  LINKED: "En revisión",
  ORDERED: "Pedido",
  EN_BODEGA: "Llegó a bodega",
  RECEIVED: "Cargado / recibido",
  DISCARDED: "Descartado",
} as const;

export function MyMissingReports({ reports }: { reports: MyMissingReport[] }) {
  return (
    <Card className="space-y-3 p-3">
      <CardTitle>Mis reportes</CardTitle>
      {reports.length === 0 ? <p className="text-sm text-muted-foreground">Todavía no reportaste faltantes.</p> : (
        <ul className="divide-y divide-border">
          {reports.map((report) => (
            <li key={report.id} className="py-2 text-sm">
              <p className="font-medium text-text">{report.rawName}</p>
              <p className="text-xs text-muted-foreground">
                {LABELS[report.status]} · Reportado {formatBogotaDate(report.createdAt, { style: "datetime" })}
                {report.arrivedAt ? ` · Llegó ${formatBogotaDate(report.arrivedAt, { style: "datetime" })}` : ""}
                {report.status === "RECEIVED" && report.resolvedAt ? ` · Pedido ${formatBogotaDate(report.resolvedAt, { style: "datetime" })}` : ""}
              </p>
            </li>
          ))}
        </ul>
      )}
    </Card>
  );
}
