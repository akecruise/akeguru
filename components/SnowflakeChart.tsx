"use client";

import { Radar, RadarChart, PolarGrid, PolarAngleAxis, PolarRadiusAxis, ResponsiveContainer } from "recharts";

export interface SnowflakeDatum {
  dimension: string;
  score: number | null;
}

export function SnowflakeChart({ data }: { data: SnowflakeDatum[] }) {
  const chartData = data.map((d) => ({ dimension: d.dimension, score: d.score ?? 0 }));

  return (
    <div className="h-72 w-full">
      <ResponsiveContainer width="100%" height="100%">
        <RadarChart data={chartData} outerRadius="75%">
          <PolarGrid stroke="currentColor" className="text-black/10 dark:text-white/15" />
          <PolarAngleAxis dataKey="dimension" tick={{ fontSize: 12, fill: "currentColor" }} className="text-black/60 dark:text-white/60" />
          <PolarRadiusAxis angle={90} domain={[0, 5]} tick={{ fontSize: 10 }} tickCount={6} className="text-black/30 dark:text-white/30" />
          <Radar dataKey="score" stroke="#1f6f64" fill="#1f6f64" fillOpacity={0.35} isAnimationActive={false} />
        </RadarChart>
      </ResponsiveContainer>
    </div>
  );
}
