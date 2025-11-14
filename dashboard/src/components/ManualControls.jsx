import { useState } from "react";
import axios from "axios";

const API_BASE = "http://localhost:4000";

export default function ManualControls({ onSuccess }) {
  const [pullerId, setPullerId] = useState("");
  const [status, setStatus] = useState("AVAILABLE");
  const [pointsDelta, setPointsDelta] = useState(5);
  const [reason, setReason] = useState("Manual adjustment");
  const [message, setMessage] = useState("");

  const handleStatus = async (event) => {
    event.preventDefault();
    try {
      await axios.post(`${API_BASE}/admin/puller/${pullerId}/status`, {
        status
      });
      setMessage("Status updated successfully.");
      onSuccess?.();
    } catch (err) {
      setMessage("Failed to update status.");
      console.error(err);
    }
  };

  const handlePoints = async (event) => {
    event.preventDefault();
    try {
      await axios.post(`${API_BASE}/admin/puller/${pullerId}/points`, {
        delta: Number(pointsDelta),
        reason
      });
      setMessage("Points updated successfully.");
      onSuccess?.();
    } catch (err) {
      setMessage("Failed to update points.");
      console.error(err);
    }
  };

  return (
    <div className="card controls">
      <h3>Manual interventions</h3>
      <form onSubmit={handleStatus}>
        <label htmlFor="puller">Puller ID</label>
        <input
          id="puller"
          placeholder="puller-neo-01"
          value={pullerId}
          onChange={(e) => setPullerId(e.target.value)}
          required
        />

        <label htmlFor="status">Status</label>
        <select
          id="status"
          value={status}
          onChange={(e) => setStatus(e.target.value)}
        >
          <option value="AVAILABLE">Available</option>
          <option value="ON_TRIP">On trip</option>
          <option value="SUSPENDED">Suspended</option>
        </select>

        <button type="submit">Update status</button>
      </form>

      <form onSubmit={handlePoints}>
        <label htmlFor="points">Points delta</label>
        <input
          id="points"
          type="number"
          value={pointsDelta}
          onChange={(e) => setPointsDelta(e.target.value)}
        />

        <label htmlFor="reason">Reason</label>
        <textarea
          id="reason"
          rows={3}
          value={reason}
          onChange={(e) => setReason(e.target.value)}
        />

        <button type="submit">Apply points</button>
      </form>

      {message && (
        <p style={{ marginTop: "1rem", color: "#246bfd" }}>{message}</p>
      )}
    </div>
  );
}

