const placeholders = [
  { key: "users", label: "Registered Blocks" },
  { key: "pullers", label: "E-Rickshaw Pullers" },
  { key: "rides", label: "Total Rides" },
  { key: "activeRides", label: "Active Dispatches" },
  { key: "completedRides", label: "Completed Rides" }
];

export default function StatsCards({ totals, loading }) {
  return (
    <div className="grid grid-4">
      {placeholders.map((item) => (
        <div className="card" key={item.key}>
          <h3>{item.label}</h3>
          <div className="value">
            {loading ? "…" : totals[item.key] ?? 0}
          </div>
        </div>
      ))}
    </div>
  );
}

