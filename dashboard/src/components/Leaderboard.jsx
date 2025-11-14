export default function Leaderboard({ entries }) {
  return (
    <div className="card">
      <h3>Top performing pullers</h3>
      <table>
        <thead>
          <tr>
            <th>Puller</th>
            <th>Name</th>
            <th>Status</th>
            <th>Points</th>
          </tr>
        </thead>
        <tbody>
          {entries.length === 0 ? (
            <tr>
              <td colSpan={4}>No pullers registered yet.</td>
            </tr>
          ) : (
            entries.map((entry) => (
              <tr key={entry.pullerId}>
                <td>{entry.pullerId}</td>
                <td>{entry.name || "N/A"}</td>
                <td>{entry.status}</td>
                <td>{entry.totalPoints}</td>
              </tr>
            ))
          )}
        </tbody>
      </table>
    </div>
  );
}

