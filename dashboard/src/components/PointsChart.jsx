import { useMemo } from "react";
import {
  BarChart,
  Bar,
  XAxis,
  YAxis,
  ResponsiveContainer,
  Tooltip,
  CartesianGrid
} from "recharts";

export default function PointsChart({ entries }) {
  const data = useMemo(
    () =>
      entries.map((item) => ({
        name: item.pullerId,
        points: item.totalPoints
      })),
    [entries]
  );

  return (
    <div className="card" style={{ height: 320 }}>
      <h3>Reward points trend</h3>
      <ResponsiveContainer width="100%" height="100%">
        <BarChart data={data}>
          <CartesianGrid strokeDasharray="3 3" />
          <XAxis dataKey="name" />
          <YAxis />
          <Tooltip />
          <Bar dataKey="points" fill="#246bfd" radius={[6, 6, 0, 0]} />
        </BarChart>
      </ResponsiveContainer>
    </div>
  );
}

