const statusClass = {
  ACCEPTED: "status-pill status-accepted",
  ASSIGNED: "status-pill status-pending",
  PENDING_ASSIGNMENT: "status-pill status-pending",
  COMPLETED: "status-pill status-completed",
  REJECTED: "status-pill",
  CANCELLED: "status-pill"
};

const formatTime = (iso) => {
  if (!iso) return "—";
  return new Date(iso).toLocaleTimeString();
};

export default function RideTable({ rides, loading }) {
  return (
    <div className="card">
      <h3>Recent ride activity</h3>
      <table>
        <thead>
          <tr>
            <th>Ride</th>
            <th>Block</th>
            <th>Puller</th>
            <th>Status</th>
            <th>Requested</th>
            <th>Completed</th>
          </tr>
        </thead>
        <tbody>
          {loading ? (
            <tr>
              <td colSpan={6}>Loading…</td>
            </tr>
          ) : rides.length === 0 ? (
            <tr>
              <td colSpan={6}>No rides recorded yet.</td>
            </tr>
          ) : (
            rides.map((ride) => (
              <tr key={ride.rideId}>
                <td>{ride.rideId}</td>
                <td>{ride.blockId}</td>
                <td>{ride.pullerId || "—"}</td>
                <td>
                  <span className={statusClass[ride.status] || "status-pill"}>
                    {ride.status.replace("_", " ")}
                  </span>
                </td>
                <td>{formatTime(ride.requestedAt)}</td>
                <td>{formatTime(ride.completedAt)}</td>
              </tr>
            ))
          )}
        </tbody>
      </table>
    </div>
  );
}

