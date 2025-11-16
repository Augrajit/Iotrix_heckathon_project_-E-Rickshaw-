import { useEffect, useState, useRef } from "react";
import axios from "axios";
import "./puller-styles.css";

// Helpers for dynamic backend targeting
const getStoredHost = () => {
  try {
    const saved = localStorage.getItem("aeras_backend_host");
    if (saved && typeof saved === "string" && saved.trim().length > 0) return saved.trim();
  } catch {}
  if (typeof window !== "undefined" && window.location && window.location.hostname) {
    return window.location.hostname;
  }
  return "localhost";
};
// Accept full URLs or raw hosts; return just the hostname/IP
const sanitizeHost = (input) => {
  if (!input) return "";
  let v = input.trim();
  // Remove trailing slashes
  v = v.replace(/\/+$/, "");
  // If includes scheme, parse via URL
  if (/^https?:\/\//i.test(v) || /^wss?:\/\//i.test(v)) {
    try {
      const u = new URL(v);
      return u.hostname || v;
    } catch {
      // fallthrough
    }
  }
  // If contains path, keep before first slash
  const slashIdx = v.indexOf("/");
  if (slashIdx > 0) v = v.slice(0, slashIdx);
  // If contains port, keep before colon
  const colonIdx = v.indexOf(":");
  if (colonIdx > 0) v = v.slice(0, colonIdx);
  // Strip stray protocols
  v = v.replace(/^https?:\/\//i, "").replace(/^wss?:\/\//i, "").replace(/^ws?:\/\//i, "");
  return v;
};
const buildApiBase = (host) => `http://${host}:4000`;
const buildWsUrl = (host) => `ws://${host}:3000`;

export default function PullerApp() {
  const [pullerId, setPullerId] = useState("");
  const [isConnected, setIsConnected] = useState(false);
  const [currentRide, setCurrentRide] = useState(null);
  const [rideStatus, setRideStatus] = useState("IDLE"); // IDLE, ASSIGNED, ACCEPTED, PICKING_UP, ON_TRIP, COMPLETED
  const [backendHost, setBackendHost] = useState(getStoredHost());
  const [currentLocation, setCurrentLocation] = useState(null);
  const [distanceToPickup, setDistanceToPickup] = useState(null);
  const [distanceToDropoff, setDistanceToDropoff] = useState(null);
  const [points, setPoints] = useState(0);
  const [pointsHistory, setPointsHistory] = useState([]);
  const [notificationPermission, setNotificationPermission] = useState(false);
  const [acceptTimeout, setAcceptTimeout] = useState(null);
  const [shouldConnect, setShouldConnect] = useState(false);
  const [connectError, setConnectError] = useState("");
  
  const wsRef = useRef(null);
  const locationWatchId = useRef(null);
  const audioRef = useRef(null);
  const connectTimeoutRef = useRef(null);

  // Derived endpoints from backendHost
  const API_BASE = buildApiBase(backendHost);
  const WS_URL = buildWsUrl(backendHost);

  // Request notification and geolocation permissions
  useEffect(() => {
    if ("Notification" in window) {
      Notification.requestPermission().then((permission) => {
        setNotificationPermission(permission === "granted");
      });
    }

    // Create audio function using Web Audio API for notifications
    audioRef.current = null;

    return () => {
      if (locationWatchId.current) {
        navigator.geolocation.clearWatch(locationWatchId.current);
      }
      if (acceptTimeout) {
        clearTimeout(acceptTimeout);
      }
    };
  }, []);

  // Connect to WebSocket when pullerId is set (only after form submission)
  useEffect(() => {
    if (!shouldConnect || !pullerId || isConnected) return;

    const connectWebSocket = () => {
      try {
        const ws = new WebSocket(WS_URL);
        wsRef.current = ws;

        ws.onopen = () => {
          console.log("[WS] Connected");
          setConnectError("");
          if (connectTimeoutRef.current) {
            clearTimeout(connectTimeoutRef.current);
            connectTimeoutRef.current = null;
          }
          ws.send(JSON.stringify({ type: "REGISTER", pullerId }));
        };

        ws.onmessage = (event) => {
          const data = JSON.parse(event.data);
          console.log("[WS] Message:", data);

          if (data.type === "REGISTERED") {
            setIsConnected(true);
            loadPoints();
            loadPointsHistory();
            startLocationTracking();
          } else if (data.type === "ASSIGN_RIDE") {
            handleRideAssignment(data);
          } else if (data.type === "CANCEL_RIDE") {
            handleRideCancellation(data);
          }
        };

        ws.onerror = (error) => {
          console.error("[WS] Error:", error);
        };

        ws.onclose = () => {
          console.log("[WS] Disconnected");
          setIsConnected(false);
          // Reconnect after 3 seconds
          setTimeout(connectWebSocket, 3000);
        };
      } catch (error) {
        console.error("[WS] Connection error:", error);
        setConnectError("Unable to open WebSocket connection.");
      }
    };

    connectWebSocket();

    // If not connected in 5s, show message
    connectTimeoutRef.current = setTimeout(() => {
      if (!isConnected) {
        setConnectError(`Cannot connect to server at ${WS_URL}. Make sure the backend is running and reachable on your network.`);
      }
    }, 5000);

    return () => {
      if (wsRef.current) {
        wsRef.current.close();
      }
      if (connectTimeoutRef.current) {
        clearTimeout(connectTimeoutRef.current);
        connectTimeoutRef.current = null;
      }
    };
  }, [shouldConnect, pullerId, isConnected]);

  // Track location
  const startLocationTracking = () => {
    if (!navigator.geolocation) {
      console.error("Geolocation not supported");
      return;
    }

    locationWatchId.current = navigator.geolocation.watchPosition(
      (position) => {
        const { latitude, longitude } = position.coords;
        setCurrentLocation({ latitude, longitude });
      },
      (error) => {
        console.error("Geolocation error:", error);
      },
      {
        enableHighAccuracy: true,
        timeout: 10000,
        maximumAge: 0,
      }
    );
  };

  // Update location and calculate distances when needed
  useEffect(() => {
    if (!currentLocation || !currentRide || !currentRide.rideId) return;

    const updateLocationAndDistances = async () => {
      // Update location in backend
      try {
        await axios.post(`${API_BASE}/updateLocation`, {
          pullerId,
          rideId: currentRide.rideId,
          latitude: currentLocation.latitude,
          longitude: currentLocation.longitude,
        });
      } catch (error) {
        console.error("Error updating location:", error);
      }

      // Calculate distance using Haversine formula
      const calculateDistance = (lat1, lon1, lat2, lon2) => {
        const R = 6371e3; // Earth radius in meters
        const φ1 = (lat1 * Math.PI) / 180;
        const φ2 = (lat2 * Math.PI) / 180;
        const Δφ = ((lat2 - lat1) * Math.PI) / 180;
        const Δλ = ((lon2 - lon1) * Math.PI) / 180;

        const a =
          Math.sin(Δφ / 2) * Math.sin(Δφ / 2) +
          Math.cos(φ1) * Math.cos(φ2) * Math.sin(Δλ / 2) * Math.sin(Δλ / 2);
        const c = 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a));

        return R * c; // Distance in meters
      };

      // Calculate distance to pickup
      if (rideStatus === "ACCEPTED" || rideStatus === "PICKING_UP") {
        const dist = calculateDistance(
          currentLocation.latitude,
          currentLocation.longitude,
          currentRide.pickupLat,
          currentRide.pickupLon
        );
        setDistanceToPickup(dist);

        // Enable pickup confirmation button if within 50m
        if (dist < 50 && rideStatus === "ACCEPTED") {
          setRideStatus("PICKING_UP");
        }
      }

      // Calculate distance to dropoff
      if (rideStatus === "ON_TRIP") {
        const dist = calculateDistance(
          currentLocation.latitude,
          currentLocation.longitude,
          currentRide.dropLat,
          currentRide.dropLon
        );
        setDistanceToDropoff(dist);
      }
    };

    updateLocationAndDistances();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [currentLocation, currentRide, rideStatus, pullerId]);


  // Load puller points
  const loadPoints = async () => {
    try {
      const response = await axios.get(`${API_BASE}/getPoints?pullerId=${pullerId}`);
      setPoints(response.data.totalPoints || 0);
    } catch (error) {
      console.error("Error loading points:", error);
    }
  };

  // Load points history
  const loadPointsHistory = async () => {
    try {
      const response = await axios.get(`${API_BASE}/getPoints?pullerId=${pullerId}`);
      setPointsHistory(response.data.history || []);
    } catch (error) {
      console.error("Error loading points history:", error);
    }
  };

  // Utils
  const formatMeters = (m) => (m < 1000 ? `${Math.round(m)}m` : `${(m / 1000).toFixed(2)}km`);
  const googleMapsLink = (lat, lon) => `https://www.google.com/maps/dir/?api=1&destination=${lat},${lon}`;

  // Notify with audio and vibration
  const triggerNotification = (message) => {
    // Audio using Web Audio API
    try {
      const audioContext = new (window.AudioContext || window.webkitAudioContext)();
      const oscillator = audioContext.createOscillator();
      const gainNode = audioContext.createGain();
      
      oscillator.connect(gainNode);
      gainNode.connect(audioContext.destination);
      
      oscillator.frequency.value = 800;
      oscillator.type = "sine";
      
      gainNode.gain.setValueAtTime(0.3, audioContext.currentTime);
      gainNode.gain.exponentialRampToValueAtTime(0.01, audioContext.currentTime + 0.5);
      
      oscillator.start(audioContext.currentTime);
      oscillator.stop(audioContext.currentTime + 0.5);
    } catch (error) {
      console.error("Error playing notification sound:", error);
    }

    // Vibration
    if ("vibrate" in navigator) {
      navigator.vibrate([200, 100, 200]);
    }

    // Browser notification
    if (notificationPermission) {
      new Notification("New Ride Request", {
        body: message,
        icon: "/favicon.ico",
        tag: "ride-request",
      });
    }
  };

  // Handle ride assignment
  const handleRideAssignment = (data) => {
    const ride = {
      rideId: data.rideId,
      blockId: data.blockId,
      pickupLat: data.pickupLat,
      pickupLon: data.pickupLon,
      dropLat: data.dropLat,
      dropLon: data.dropLon,
      priority: data.priority || "NORMAL",
      distance: typeof data.distance === "number" ? data.distance : null,
    };
    
    setCurrentRide(ride);
    setRideStatus("ASSIGNED");
    triggerNotification(`New ride (${ride.priority}) from ${data.blockId}${ride.distance !== null ? ` - ${formatMeters(ride.distance)} away` : ""}. Accept or reject?`);
    
    // Auto-pass to next puller if not accepted within 30 seconds (TEST CASE 6)
    const timeout = setTimeout(() => {
      if (rideStatus === "ASSIGNED" && currentRide?.rideId === data.rideId) {
        rejectRide();
        triggerNotification("Ride request timeout - automatically passed to next puller");
      }
    }, 30000); // 30 seconds
    
    setAcceptTimeout(timeout);
  };

  // Handle ride cancellation
  const handleRideCancellation = (data) => {
    if (acceptTimeout) {
      clearTimeout(acceptTimeout);
      setAcceptTimeout(null);
    }
    setCurrentRide(null);
    setRideStatus("IDLE");
    setDistanceToPickup(null);
    setDistanceToDropoff(null);
  };

  // Accept ride
  const acceptRide = async () => {
    if (!currentRide) return;

    if (acceptTimeout) {
      clearTimeout(acceptTimeout);
      setAcceptTimeout(null);
    }

    try {
      const startTime = Date.now();
      await axios.post(`${API_BASE}/acceptRide`, {
        rideId: currentRide.rideId,
        pullerId,
      });
      const latency = Date.now() - startTime;
      
      if (latency > 2000) {
        console.warn(`Acceptance confirmation latency: ${latency}ms (expected <2s)`);
      }
      
      setRideStatus("ACCEPTED");
      loadPoints();
    } catch (error) {
      console.error("Error accepting ride:", error);
      if (error.response?.status === 409) {
        alert("Ride already accepted by another puller");
        handleRideCancellation({});
      } else {
        alert("Error accepting ride");
      }
    }
  };

  // Reject ride
  const rejectRide = async () => {
    if (!currentRide) return;

    if (acceptTimeout) {
      clearTimeout(acceptTimeout);
      setAcceptTimeout(null);
    }

    try {
      await axios.post(`${API_BASE}/rejectRide`, {
        rideId: currentRide.rideId,
        pullerId,
        reason: "Rejected by puller",
      });
      setCurrentRide(null);
      setRideStatus("IDLE");
      setDistanceToPickup(null);
    } catch (error) {
      console.error("Error rejecting ride:", error);
      alert("Error rejecting ride");
    }
  };

  // Confirm pickup
  const confirmPickup = async () => {
    if (!currentRide) return;

    try {
      await axios.post(`${API_BASE}/confirmPickup`, {
        rideId: currentRide.rideId,
        pullerId,
      });
      setRideStatus("ON_TRIP");
      setDistanceToPickup(null);
    } catch (error) {
      console.error("Error confirming pickup:", error);
      alert("Error confirming pickup");
    }
  };

  // Complete ride
  const completeRide = async () => {
    if (!currentRide || distanceToDropoff === null) return;

    // Calculate points based on dropoff distance (TEST CASE 7)
    // Base Points = 10, Distance Penalty = (Actual Distance / 10m), Final Points = Base Points - Distance Penalty (minimum 0)
    const basePoints = 10;
    const distancePenalty = Math.floor(distanceToDropoff / 10);
    const points = Math.max(0, basePoints - distancePenalty);
    
    // Determine status based on distance (TEST CASE 7)
    let pointStatus = "REWARDED";
    if (distanceToDropoff > 100) {
      pointStatus = "PENDING"; // Admin review required
    }

    try {
      await axios.post(`${API_BASE}/completeRide`, {
        rideId: currentRide.rideId,
        pullerId,
        dropDistance: distanceToDropoff,
        points: points,
        pointStatus: pointStatus,
      });
      
      setCurrentRide(null);
      setRideStatus("IDLE");
      setDistanceToPickup(null);
      setDistanceToDropoff(null);
      loadPoints();
      loadPointsHistory();
      
      if (pointStatus === "PENDING") {
        alert(`Ride completed! Points are pending admin review (${points} points calculated).`);
      } else {
        alert(`Ride completed! You earned ${points} points.`);
      }
    } catch (error) {
      console.error("Error completing ride:", error);
      alert("Error completing ride");
    }
  };

  // Register puller
  const handleRegister = (e) => {
    e.preventDefault();
    if (pullerId.trim()) {
      setIsConnected(false);
      try {
        const cleaned = sanitizeHost(backendHost);
        setBackendHost(cleaned);
        localStorage.setItem("aeras_backend_host", cleaned);
      } catch {}
      setShouldConnect(true); // Trigger WebSocket connection only after form submission
    }
  };

  return (
    <div className="puller-app">
      <header className="puller-header">
        <h1>🚲 Puller Dashboard</h1>
        <div className="puller-info">
          <span className={`status-indicator ${isConnected ? "connected" : "disconnected"}`}>
            {isConnected ? "● Connected" : "○ Disconnected"}
          </span>
          <span className="points-display">⭐ {points.toFixed(1)} points</span>
        </div>
      </header>

      <main className="puller-main">
        {(!pullerId || !shouldConnect) ? (
          <div className="register-card card">
            <h2>Register Puller</h2>
            <form onSubmit={handleRegister}>
              <input
                type="text"
                placeholder="Enter your Puller ID (e.g., puller-01)"
                value={pullerId}
                onChange={(e) => setPullerId(e.target.value)}
                required
              />
              <input
                type="text"
                placeholder="Server host/IP (e.g., 192.168.0.103 or http://192.168.0.103:4000)"
                value={backendHost}
                onChange={(e) => setBackendHost(e.target.value)}
                onBlur={(e) => setBackendHost(sanitizeHost(e.target.value))}
                required
                style={{ marginTop: 8 }}
              />
              <button type="submit">Connect</button>
            </form>
            <div className="hint" style={{ marginTop: 8 }}>
              Will connect to: <code>{API_BASE}</code> (HTTP), <code>{WS_URL}</code> (WebSocket)
            </div>
          </div>
        ) : shouldConnect && !isConnected ? (
          <div className="card">
            <p>Connecting to server...</p>
            {connectError && (
              <div className="hint warning" style={{ marginTop: 8 }}>
                {connectError}
              </div>
            )}
            <div className="hint" style={{ marginTop: 8 }}>
              Trying: <code>{API_BASE}</code> (HTTP), <code>{WS_URL}</code> (WebSocket)
            </div>
          </div>
        ) : (
          <>
            {rideStatus === "IDLE" && (
              <div className="card idle-card">
                <div className="idle-content">
                  <div className="idle-icon">🛑</div>
                  <h2>Awaiting Requests</h2>
                  <p>You are online and ready to receive new rides.</p>
                  {currentLocation && (
                    <p className="location-info">
                      📍 Location: {currentLocation.latitude.toFixed(6)}, {currentLocation.longitude.toFixed(6)}
                    </p>
                  )}
                </div>
                <div className="points-catalog card">
                  <h3>🎁 Rewards Catalog</h3>
                  <ul className="catalog-list">
                    <li>• 50 pts: Free water bottle</li>
                    <li>• 100 pts: Mobile recharge ₹50</li>
                    <li>• 250 pts: Raincoat</li>
                    <li>• 500 pts: Tyre puncture kit</li>
                    <li>• 1000 pts: Service voucher</li>
                  </ul>
                  <small>Redemptions subject to availability. Contact your admin.</small>
                </div>
                {pointsHistory.length > 0 && (
                  <div className="points-history-section">
                    <h3>Recent Points History (Last 10 rides)</h3>
                    <div className="points-history">
                      {pointsHistory.slice(0, 10).map((entry, index) => (
                        <div key={index} className="history-item">
                          <span className="history-date">{new Date(entry.recordedAt).toLocaleDateString()}</span>
                          <span className="history-points">+{entry.delta} pts</span>
                          <span className="history-reason">{entry.reason}</span>
                        </div>
                      ))}
                    </div>
                  </div>
                )}
              </div>
            )}

            {rideStatus === "ASSIGNED" && currentRide && (
              <div className="card notification-card">
                <div className="notification-header">
                  <h2>🔔 New Ride Request</h2>
                </div>
                <div className="ride-details">
                  {currentRide.priority && (
                    <div className="detail-item">
                      <span className="label">Priority:</span>
                      <span className="value">{currentRide.priority}</span>
                    </div>
                  )}
                  {typeof currentRide.distance === "number" && (
                    <div className="detail-item">
                      <span className="label">Distance:</span>
                      <span className="value">{formatMeters(currentRide.distance)}</span>
                    </div>
                  )}
                  <div className="detail-item">
                    <span className="label">Ride ID:</span>
                    <span className="value">{currentRide.rideId}</span>
                  </div>
                  <div className="detail-item">
                    <span className="label">Block ID:</span>
                    <span className="value">{currentRide.blockId}</span>
                  </div>
                  <div className="detail-item">
                    <span className="label">Pickup:</span>
                    <span className="value">{currentRide.pickupLat.toFixed(6)}, {currentRide.pickupLon.toFixed(6)}</span>
                  </div>
                  <div className="detail-item">
                    <span className="label">Drop:</span>
                    <span className="value">{currentRide.dropLat.toFixed(6)}, {currentRide.dropLon.toFixed(6)}</span>
                  </div>
                  <div className="detail-buttons">
                    <button className="btn-accept" onClick={acceptRide}>
                      ✅ Accept
                    </button>
                    <button className="btn-reject" onClick={rejectRide}>
                      ❌ Reject
                    </button>
                  </div>
                  <div className="timeout-hint">
                    ⏱️ You have 30 seconds to accept. Auto-passing to next puller after timeout.
                  </div>
                </div>
              </div>
            )}

            {(rideStatus === "ACCEPTED" || rideStatus === "PICKING_UP") && currentRide && (
              <div className="card navigation-card">
                <div className="navigation-header">
                  <h2>🧭 Navigating to Pickup</h2>
                </div>
                <div className="location-info">
                  <div className="location-item">
                    <span className="label">Destination:</span>
                    <span className="value">{currentRide.blockId}</span>
                  </div>
                  {distanceToPickup !== null && (
                    <div className="distance-display">
                      <span className="distance-value">
                        {distanceToPickup < 1000
                          ? `${Math.round(distanceToPickup)}m`
                          : `${(distanceToPickup / 1000).toFixed(2)}km`}
                      </span>
                      <span className="distance-label">to pickup</span>
                    </div>
                  )}
                  {currentLocation && (
                    <div className="coordinates">
                      <div>
                        📍 Pickup: {currentRide.pickupLat.toFixed(6)}, {currentRide.pickupLon.toFixed(6)}
                      </div>
                      <div>
                        🚲 You: {currentLocation.latitude.toFixed(6)}, {currentLocation.longitude.toFixed(6)}
                      </div>
                    </div>
                  )}
                  <div className="nav-buttons">
                    <a
                      className="btn-nav"
                      href={googleMapsLink(currentRide.pickupLat, currentRide.pickupLon)}
                      target="_blank"
                      rel="noreferrer"
                    >
                      🗺️ Open Pickup in Google Maps
                    </a>
                  </div>
                  {rideStatus === "PICKING_UP" && (
                    <button
                      className="btn-confirm-pickup"
                      onClick={confirmPickup}
                    >
                      ✅ Confirm Pickup
                    </button>
                  )}
                </div>
                {distanceToPickup !== null && distanceToPickup > 50 && (
                  <div className="hint">
                    ⚠️ Wait until within 50m of the location to confirm pickup
                  </div>
                )}
              </div>
            )}

            {rideStatus === "ON_TRIP" && currentRide && (
              <div className="card trip-card">
                <div className="trip-header">
                  <h2>🚗 On Trip</h2>
                </div>
                <div className="trip-info">
                  <div className="location-item">
                    <span className="label">Block ID:</span>
                    <span className="value">{currentRide.blockId}</span>
                  </div>
                  {distanceToDropoff !== null && (
                    <div className="distance-display">
                      <span className="distance-value">
                        {distanceToDropoff < 1000
                          ? `${Math.round(distanceToDropoff)}m`
                          : `${(distanceToDropoff / 1000).toFixed(2)}km`}
                      </span>
                      <span className="distance-label">to destination</span>
                    </div>
                  )}
                  {currentLocation && (
                    <div className="coordinates">
                      <div>
                        🎯 Dropoff: {currentRide.dropLat.toFixed(6)}, {currentRide.dropLon.toFixed(6)}
                      </div>
                      <div>
                        🚲 You: {currentLocation.latitude.toFixed(6)}, {currentLocation.longitude.toFixed(6)}
                      </div>
                    </div>
                  )}
                  <div className="nav-buttons">
                    <a
                      className="btn-nav"
                      href={googleMapsLink(currentRide.dropLat, currentRide.dropLon)}
                      target="_blank"
                      rel="noreferrer"
                    >
                      🗺️ Open Drop-off in Google Maps
                    </a>
                  </div>
                  {distanceToDropoff !== null && distanceToDropoff <= 50 && (
                    <button className="btn-complete" onClick={completeRide}>
                      ✅ Complete Ride
                    </button>
                  )}
                  {distanceToDropoff !== null && distanceToDropoff > 50 && distanceToDropoff <= 100 && (
                    <div className="hint">
                      ⚠️ Wait until within 50m of the destination to complete the ride
                    </div>
                  )}
                  {distanceToDropoff !== null && distanceToDropoff > 100 && (
                    <div className="hint warning">
                      ⚠️ You are more than 100m from the destination. Points will be PENDING for admin review.
                    </div>
                  )}
                </div>
              </div>
            )}
          </>
        )}
      </main>
    </div>
  );
}

