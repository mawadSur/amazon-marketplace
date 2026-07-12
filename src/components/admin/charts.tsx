"use client";

// Reusable recharts wrappers for the admin dashboard. All colors are pulled
// from the Tailwind CSS-variable design tokens (hsl(var(--…))) so the charts
// track the Boutique Warm palette. Each chart fills its parent width via
// ResponsiveContainer and renders at a fixed height.

import type { CSSProperties } from "react";
import {
  Area,
  AreaChart,
  Bar,
  BarChart,
  Cell,
  Legend,
  Pie,
  PieChart,
  ResponsiveContainer,
  Tooltip,
  XAxis,
  YAxis,
} from "recharts";

// Warm categorical palette (fits the rose/gold/ink tokens). Reused across the
// bar + pie charts for consistent series coloring.
const PALETTE = [
  "hsl(333 78% 42%)", // rose (primary)
  "hsl(32 95% 44%)", // gold (secondary)
  "hsl(0 58% 40%)", // sale red (destructive)
  "hsl(200 55% 40%)", // teal
  "hsl(150 42% 38%)", // green
  "hsl(268 45% 52%)", // plum
];

const AXIS = "hsl(24 12% 40%)"; // muted-foreground
const GRID = "hsl(28 30% 88%)"; // border

const tooltipStyle: CSSProperties = {
  background: "hsl(0 0% 100%)",
  border: "1px solid hsl(28 30% 88%)",
  borderRadius: 8,
  fontSize: 12,
  color: "hsl(24 22% 12%)",
};

const axisProps = {
  stroke: AXIS,
  tick: { fontSize: 11, fill: AXIS } as const,
  tickLine: false,
  axisLine: { stroke: GRID },
} as const;

/** GMV ($) and order-count area chart over a daily time series. */
export function GmvAreaChart({
  data,
}: {
  data: Array<{ date: string; gmvUsd: number; orders: number }>;
}) {
  if (data.length === 0) return <EmptyChart label="No orders in the last 30 days." />;
  return (
    <ResponsiveContainer width="100%" height={240}>
      <AreaChart data={data} margin={{ top: 8, right: 8, bottom: 0, left: -8 }}>
        <defs>
          <linearGradient id="gmvFill" x1="0" y1="0" x2="0" y2="1">
            <stop offset="0%" stopColor={PALETTE[0]} stopOpacity={0.35} />
            <stop offset="100%" stopColor={PALETTE[0]} stopOpacity={0.02} />
          </linearGradient>
        </defs>
        <XAxis dataKey="date" {...axisProps} tickFormatter={(d: string) => d.slice(5)} />
        <YAxis {...axisProps} width={48} tickFormatter={(v: number) => `$${Math.round(v)}`} />
        <Tooltip
          contentStyle={tooltipStyle}
          formatter={(value: number) => [`$${value.toFixed(2)}`, "GMV"]}
        />
        <Area
          type="monotone"
          dataKey="gmvUsd"
          stroke={PALETTE[0]}
          strokeWidth={2}
          fill="url(#gmvFill)"
        />
      </AreaChart>
    </ResponsiveContainer>
  );
}

/** Horizontal-friendly vertical bar chart for a set of labelled counts. */
export function CountBarChart({
  data,
  colorIndex = 0,
}: {
  data: Array<{ label: string; count: number }>;
  colorIndex?: number;
}) {
  if (data.length === 0) return <EmptyChart label="No data yet." />;
  return (
    <ResponsiveContainer width="100%" height={240}>
      <BarChart data={data} margin={{ top: 8, right: 8, bottom: 0, left: -8 }}>
        <XAxis
          dataKey="label"
          {...axisProps}
          interval={0}
          angle={-25}
          textAnchor="end"
          height={56}
        />
        <YAxis {...axisProps} width={32} allowDecimals={false} />
        <Tooltip contentStyle={tooltipStyle} cursor={{ fill: "hsl(26 40% 94%)" }} />
        <Bar dataKey="count" radius={[4, 4, 0, 0]} fill={PALETTE[colorIndex % PALETTE.length]} />
      </BarChart>
    </ResponsiveContainer>
  );
}

/** Pie/donut breakdown for a small set of labelled counts. */
export function CountPieChart({
  data,
}: {
  data: Array<{ label: string; count: number }>;
}) {
  const nonZero = data.filter((d) => d.count > 0);
  if (nonZero.length === 0) return <EmptyChart label="No data yet." />;
  return (
    <ResponsiveContainer width="100%" height={240}>
      <PieChart>
        <Tooltip contentStyle={tooltipStyle} />
        <Legend
          verticalAlign="bottom"
          height={36}
          wrapperStyle={{ fontSize: 11, color: AXIS }}
        />
        <Pie
          data={nonZero}
          dataKey="count"
          nameKey="label"
          innerRadius={44}
          outerRadius={78}
          paddingAngle={2}
        >
          {nonZero.map((entry, i) => (
            <Cell key={entry.label} fill={PALETTE[i % PALETTE.length]} />
          ))}
        </Pie>
      </PieChart>
    </ResponsiveContainer>
  );
}

function EmptyChart({ label }: { label: string }) {
  return (
    <div className="flex h-[240px] items-center justify-center text-sm text-muted-foreground">
      {label}
    </div>
  );
}
