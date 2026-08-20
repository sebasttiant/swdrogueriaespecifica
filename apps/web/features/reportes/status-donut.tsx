"use client";

import { Cell, Pie, PieChart, ResponsiveContainer, Tooltip } from "recharts";

import type { StatusSlice } from "@/server/services/reports.service";

import { CHART_CHROME, STATUS_COLORS } from "./palette";

type StatusDonutProps = {
  data: StatusSlice[];
  // Etiqueta central (ej. "pendientes"). El total se calcula de las slices.
  unitLabel: string;
};

function colorFor(status: string): string {
  // El respaldo es un color de interfaz, no de estado: sigue al tema para que
  // un estado desconocido no quede invisible en oscuro.
  return STATUS_COLORS[status] ?? CHART_CHROME.tick;
}

// Dona de distribución por estado con porcentajes. Tooltip al pasar el mouse y
// leyenda propia debajo (color + estado + conteo + %). Muestra un vacío legible
// cuando no hay registros en el período.
export function StatusDonut({ data, unitLabel }: StatusDonutProps) {
  const total = data.reduce((sum, slice) => sum + slice.count, 0);

  if (total === 0) {
    return (
      <div className="flex h-64 items-center justify-center text-sm text-muted-foreground">
        Sin registros en el período.
      </div>
    );
  }

  return (
    <div className="flex flex-col gap-4 sm:flex-row sm:items-center">
      <div className="relative h-56 w-full sm:h-48 sm:max-w-[16rem]">
        <ResponsiveContainer width="100%" height="100%">
          <PieChart>
            <Pie
              data={data}
              dataKey="count"
              nameKey="label"
              innerRadius="62%"
              outerRadius="90%"
              paddingAngle={2}
              strokeWidth={0}
              isAnimationActive={false}
            >
              {data.map((slice) => (
                <Cell key={slice.status} fill={colorFor(slice.status)} />
              ))}
            </Pie>
            <Tooltip
              cursor={false}
              content={({ active, payload }) => {
                if (!active || !payload?.length) return null;
                const slice = payload[0]?.payload as StatusSlice;
                return (
                  <div className="rounded-md border border-border bg-surface px-3 py-2 text-xs shadow-md">
                    <p className="font-semibold text-text">{slice.label}</p>
                    <p className="text-muted-foreground">
                      {slice.count} · {slice.percent}%
                    </p>
                  </div>
                );
              }}
            />
          </PieChart>
        </ResponsiveContainer>
        <div className="pointer-events-none absolute inset-0 flex flex-col items-center justify-center">
          <span className="text-2xl font-bold leading-none text-text">
            {total}
          </span>
          <span className="text-xs text-muted-foreground">{unitLabel}</span>
        </div>
      </div>

      <ul className="min-w-0 flex-1 space-y-2">
        {data.map((slice) => (
          <li
            key={slice.status}
            className="flex items-center gap-2 text-sm text-text"
          >
            <span
              className="size-3 shrink-0 rounded-full"
              style={{ backgroundColor: colorFor(slice.status) }}
              aria-hidden
            />
            <span className="min-w-0 flex-1 break-words">{slice.label}</span>
            <span className="tabular-nums text-muted-foreground">
              {slice.count} · {slice.percent}%
            </span>
          </li>
        ))}
      </ul>
    </div>
  );
}
