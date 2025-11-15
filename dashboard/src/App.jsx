import { useEffect, useState } from "react";
import axios from "axios";
import StatsCards from "./components/StatsCards";
import RideTable from "./components/RideTable";
import Leaderboard from "./components/Leaderboard";
import ManualControls from "./components/ManualControls";
import PointsChart from "./components/PointsChart";

const API_BASE = "http://localhost:4000";

export default function App() {
  const [totals, setTotals] = useState({
    users: 0,
    pullers: 0,
    rides: 0,
    activeRides: 0,
    completedRides: 0
  });
  const [rides, setRides] = useState([]);
  const [leaderboard, setLeaderboard] = useState([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState("");

  const loadData = async () => {
    try {
      setLoading(true);
      const [dashboardRes, rideRes] = await Promise.all([
        axios.get(`${API_BASE}/admin/dashboard`),
        axios.get(`${API_BASE}/rides`)
      ]);
      setTotals(dashboardRes.data.totals);
      setLeaderboard(dashboardRes.data.leaderboard);
      setRides(rideRes.data);
      setError("");
    } catch (err) {
      console.error(err);
      setError("Failed to load data. Check backend connection.");
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => {
    loadData();
    const interval = setInterval(loadData, 5000);
    return () => clearInterval(interval);
  }, []);

  return (
    <div className="app-shell">
      <header>
        <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center" }}>
          <div>
            <h1>Accessible E-Rickshaw Automation System</h1>
            <p>Real-time operations dashboard for fleet supervisors</p>
          </div>
          <a
            href="http://localhost:5174"
            target="_blank"
            rel="noopener noreferrer"
            style={{
              color: "white",
              textDecoration: "none",
              padding: "0.5rem 1rem",
              background: "rgba(255, 255, 255, 0.2)",
              borderRadius: "8px",
              fontWeight: "600",
            }}
          >
            🚲 Puller Dashboard
          </a>
        </div>
      </header>
      <main>
        {error && <div className="card" style={{ color: "#d9534f" }}>{error}</div>}
        <StatsCards totals={totals} loading={loading} />
        <div className="grid two-column">
          <RideTable rides={rides} loading={loading} />
          <Leaderboard entries={leaderboard} />
        </div>
        <div className="grid" style={{ marginTop: "1.5rem" }}>
          <PointsChart entries={leaderboard} />
          <ManualControls onSuccess={loadData} />
        </div>
      </main>
    </div>
  );
}

