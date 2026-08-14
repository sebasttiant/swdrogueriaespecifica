"use client";

import {
  Bar,
  BarChart,
  CartesianGrid,
  Legend,
  ResponsiveContainer,
  Tooltip,
  XAxis,
  YAxis,
} from "recharts";

import type { TrendPoint } from "@/server/services/reports.service";

import { CHART_CHROME, SERIES_COLORS } from "./palette";

type TrendBarsProps = {
  data: TrendPoint[];
};

// Barras de creación por día: dos series (pendientes vs faltantes) sobre un
// único eje de conteo. Color por entidad, leyenda arriba, tooltip al hover.
export function TrendBars({ data }: TrendBarsProps) {
  const hasData = data.some((p) => p.pendings > 0 || p.missing > 0);

  if (!hasData) {
    return (
      <div className="flex h-64 items-center justify-center text-sm text-muted-foreground">
        Sin actividad en el período.
      </div>
    );
  }

  return (
    <div className="h-72 w-full">
      <ResponsiveContainer width="100%" height="100%">
        <BarChart data={data} margin={{ top: 8, right: 8, bottom: 0, left: -16 }}>
          <CartesianGrid vertical={false} stroke={CHART_CHROME.grid} />
          <XAxis
            dataKey="label"
            tick={{ fontSize: 11, fill: CHART_CHROME.tick }}
            tickLine={false}
            axisLine={{ stroke: CHART_CHROME.axisLine }}
            interval="preserveStartEnd"
            minTickGap={16}
          />
          <YAxis
            allowDecimals={false}
            tick={{ fontSize: 11, fill: CHART_CHROME.tick }}
            tickLine={false}
            axisLine={false}
            width={32}
          />
          <Tooltip
            cursor={{ fill: CHART_CHROME.cursor, fillOpacity: 0.06 }}
            content={({ active, payload, label }) => {
              if (!active || !payload?.length) return null;
              const point = payload[0]?.payload as TrendPoint;
              return (
                <div className="rounded-md border border-border bg-surface px-3 py-2 text-xs shadow-md">
                  <p className="font-semibold text-text">{label}</p>
                  <p style={{ color: SERIES_COLORS.pendings }}>
                    Pendientes: {point.pendings}
                  </p>
                  <p style={{ color: SERIES_COLORS.missing }}>
                    Faltantes: {point.missing}
                  </p>
                </div>
              );
            }}
          />
          <Legend
            wrapperStyle={{ fontSize: 12 }}
            formatter={(value) =>
              value === "pendings" ? "Pendientes" : "Faltantes"
            }
          />
          <Bar
            dataKey="pendings"
            name="pendings"
            fill={SERIES_COLORS.pendings}
            radius={[3, 3, 0, 0]}
            isAnimationActive={false}
          />
          <Bar
            dataKey="missing"
            name="missing"
            fill={SERIES_COLORS.missing}
            radius={[3, 3, 0, 0]}
            isAnimationActive={false}
          />
        </BarChart>
      </ResponsiveContainer>
    </div>
  );
}
