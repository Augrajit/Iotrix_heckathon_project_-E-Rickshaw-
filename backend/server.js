/**
 * Accessible E-Rickshaw Automation System (AERAS) Backend
 * --------------------------------------------------------
 * Node.js + Express + MongoDB + WebSocket dispatcher coordinating
 * user-side ESP32 blocks and rickshaw ESP32 nodes. Provides REST
 * endpoints, WebSocket ride assignments, reward point logic, and
 * admin analytics.
 */

require("dotenv").config();
import express, { json } from "express";
import { createServer } from "http";
import cors from "cors";
import mongoose, { connect, connection } from "mongoose";
import WebSocket, { WebSocketServer } from 'ws';
import { MongoMemoryServer } from "mongodb-memory-server";


const { Schema, model } = mongoose;

// -------------------------------------------------------------------
// Configuration
// -------------------------------------------------------------------
const PORT = process.env.PORT || 3000;
const MONGO_URI =
  process.env.MONGO_URI || "mongodb://localhost:27017/aeras_db";

// -------------------------------------------------------------------
// MongoDB Connection (with in-memory fallback)
// -------------------------------------------------------------------
let memoryServer = null;

async function connectDatabase() {
  try {
    await connect(MONGO_URI);
    console.log(`[DB] MongoDB connected (${MONGO_URI})`);
  } catch (err) {
    console.error("[DB] Connection failed", err.message);
    console.log("[DB] Bootstrapping in-memory MongoDB instance...");
    memoryServer = await MongoMemoryServer.create({
      instance: {
        dbName: "aeras_db",
      },
    });
    const memUri = memoryServer.getUri();
    await connect(memUri);
    console.log("[DB] In-memory MongoDB ready");
  }
}

connectDatabase();

process.on("SIGINT", async () => {
  await connection.close();
  if (memoryServer) {
    await memoryServer.stop();
  }
  process.exit(0);
});

process.on("SIGTERM", async () => {
  await connection.close();
  if (memoryServer) {
    await memoryServer.stop();
  }
  process.exit(0);
});

const userSchema = new Schema(
  {
    blockId: { type: String, index: true, unique: true },
    name: String,
    priority: { type: Number, default: 1 },
    notes: String,
  },
  { timestamps: true }
);

const pullerSchema = new Schema(
  {
    pullerId: { type: String, index: true, unique: true },
    name: String,
    status: {
      type: String,
      enum: ["AVAILABLE", "ON_TRIP", "SUSPENDED"],
      default: "AVAILABLE",
    },
    totalPoints: { type: Number, default: 0 },
    lastKnownLocation: {
      latitude: Number,
      longitude: Number,
      updatedAt: Date,
    },
  },
  { timestamps: true }
);

const rideSchema = new Schema(
  {
    rideId: { type: String, index: true, unique: true },
    blockId: String,
    pullerId: String,
    status: {
      type: String,
      enum: [
        "PENDING_ASSIGNMENT",
        "ASSIGNED",
        "ACCEPTED",
        "REJECTED",
        "CANCELLED",
        "PICKED_UP",
        "COMPLETED",
      ],
      default: "PENDING_ASSIGNMENT",
    },
    pickupLocation: {
      latitude: Number,
      longitude: Number,
    },
    dropLocation: {
      latitude: Number,
      longitude: Number,
    },
    requestedAt: { type: Date, default: Date.now },
    acceptedAt: Date,
    completedAt: Date,
    rewardPoints: Number,
    metadata: Schema.Types.Mixed,
  },
  { timestamps: true }
);

const locationSchema = new Schema(
  {
    pullerId: { type: String, index: true },
    rideId: String,
    latitude: Number,
    longitude: Number,
    recordedAt: { type: Date, default: Date.now },
  },
  { timestamps: true }
);

const pointsHistorySchema = new Schema(
  {
    pullerId: { type: String, index: true },
    rideId: String,
    delta: Number,
    reason: String,
    recordedAt: { type: Date, default: Date.now },
  },
  { timestamps: true }
);

const User = model("User", userSchema);
const Puller = model("Puller", pullerSchema);
const Ride = model("Ride", rideSchema);
const LocationLog = model("LocationLog", locationSchema);
const PointsHistory = model("PointsHistory", pointsHistorySchema);

// -------------------------------------------------------------------
// Express App Setup
// -------------------------------------------------------------------
const app = express();
const server = createServer(app);

app.use(cors());
app.use(json());

app.get("/", (_req, res) => {
  res.send({ status: "AERAS backend online" });
});

// -------------------------------------------------------------------
// WebSocket Dispatcher
// -------------------------------------------------------------------
const wss = new WebSocketServer({ port: 3000 });

const pullerSockets = new Map(); // pullerId => ws

wss.on("connection", (ws) => {
  console.log("[WS] Connection attempt - awaiting registration");

  ws.on("message", async (message) => {
    try
    {
      const data = JSON.parse(message.toString());
      if (data.type === "REGISTER" && data.pullerId)
      {
        pullerSockets.set(data.pullerId, ws);
        ws.pullerId = data.pullerId;
        console.log(`[WS] Puller ${data.pullerId} registered`);
        await Puller.findOneAndUpdate(
          { pullerId: data.pullerId },
          { status: "AVAILABLE" },
          { upsert: true }
        );
        ws.send(JSON.stringify({ type: "REGISTERED", pullerId: data.pullerId }));
      }
    }
    catch (err)
    {
      console.error("[WS] Invalid message", err);
    }
  });

  ws.on("close", async () => {
    if (ws.pullerId)
    {
      console.log(`[WS] Puller ${ws.pullerId} disconnected`);
      pullerSockets.delete(ws.pullerId);
      await Puller.findOneAndUpdate(
        { pullerId: ws.pullerId },
        { status: "AVAILABLE" }
      );
    }
  });
});

// Calculate distance using Haversine formula
function calculateDistance(lat1, lon1, lat2, lon2) {
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
}

// Store active ride assignments with timestamps for timeout handling
const activeRideAssignments = new Map(); // rideId => { assignedAt, timeoutId }

async function assignRideToPuller(rideDoc) {
  // TEST CASE 8: Proximity-based priority assignment
  const availablePullers = [];
  
  // Get all available pullers with their locations
  for (const [pullerId, ws] of pullerSockets.entries()) {
    const puller = await Puller.findOne({ pullerId });
    if (puller && puller.status === "AVAILABLE" && puller.lastKnownLocation) {
      const distance = calculateDistance(
        rideDoc.pickupLocation?.latitude || 0,
        rideDoc.pickupLocation?.longitude || 0,
        puller.lastKnownLocation.latitude,
        puller.lastKnownLocation.longitude
      );
      availablePullers.push({
        pullerId,
        ws,
        distance,
        location: puller.lastKnownLocation
      });
    }
  }

  if (availablePullers.length === 0) {
    console.log("[DISPATCH] No pullers online. Marking ride as pending.");
    return null;
  }

  // Sort by proximity (nearest first) - TEST CASE 8
  availablePullers.sort((a, b) => a.distance - b.distance);

  // Send notification to ALL available pullers (TEST CASE 8: All pullers receive notification)
  const payload = {
    type: "ASSIGN_RIDE",
    rideId: rideDoc.rideId,
    blockId: rideDoc.blockId,
    pickupLat: rideDoc.pickupLocation?.latitude || 0,
    pickupLon: rideDoc.pickupLocation?.longitude || 0,
    dropLat: rideDoc.dropLocation?.latitude || 0,
    dropLon: rideDoc.dropLocation?.longitude || 0,
  };

  // Broadcast to all available pullers (nearest first priority)
  for (const puller of availablePullers) {
    try {
      puller.ws.send(JSON.stringify({
        ...payload,
        priority: puller.distance < 1000 ? "HIGH" : "NORMAL", // Nearest get high priority
        distance: Math.round(puller.distance)
      }));
      console.log(`[DISPATCH] Ride ${rideDoc.rideId} → ${puller.pullerId} (${Math.round(puller.distance)}m away)`);
    } catch (error) {
      console.error(`[DISPATCH] Error sending to ${puller.pullerId}:`, error);
    }
  }

  rideDoc.status = "ASSIGNED";
  await rideDoc.save();

  // TEST CASE 8: Set timeout - if no puller accepts within 60 seconds, expire request
  const timeoutId = setTimeout(async () => {
    const updatedRide = await Ride.findOne({ rideId: rideDoc.rideId });
    if (updatedRide && updatedRide.status === "ASSIGNED") {
      // No puller accepted within 60 seconds
      updatedRide.status = "CANCELLED";
      await updatedRide.save();
      
      // Notify all pullers that request expired
      for (const puller of availablePullers) {
        try {
          puller.ws.send(JSON.stringify({
            type: "CANCEL_RIDE",
            rideId: rideDoc.rideId,
            reason: "Request expired - no puller accepted within 60 seconds"
          }));
        } catch (error) {
          console.error(`[DISPATCH] Error notifying expiry to ${puller.pullerId}:`, error);
        }
      }
      
      logTestEvent(8, "TIMEOUT", `Ride ${rideDoc.rideId} expired - no puller accepted`);
      console.log(`[DISPATCH] Ride ${rideDoc.rideId} expired - Red LED should turn ON`);
    }
    activeRideAssignments.delete(rideDoc.rideId);
  }, 60000); // 60 seconds timeout

  activeRideAssignments.set(rideDoc.rideId, {
    assignedAt: new Date(),
    timeoutId,
    availablePullers: availablePullers.map(p => p.pullerId)
  });

  return availablePullers[0].pullerId; // Return nearest puller ID
}

// -------------------------------------------------------------------
// REST API Routes
// -------------------------------------------------------------------

/**
 * POST /requestRide
 * Request payload: { blockId }
 * Response: { rideId, status }
 */
app.post("/requestRide", async (req, res) => {
  const { blockId } = req.body;
  if (!blockId)
  {
    return res.status(400).json({ error: "blockId required" });
  }

  const rideId = `ride-${Date.now()}`;
  const ride = await Ride.create({
    rideId,
    blockId,
    status: "PENDING_ASSIGNMENT",
    pickupLocation: { latitude: 0, longitude: 0 },
    dropLocation: { latitude: 0, longitude: 0 },
    metadata: { requestedVia: "USER_BLOCK" },
  });

  logTestEvent(6, "RUN", `Ride ${rideId} created`);

  await assignRideToPuller(ride);
  res.json({ rideId, status: ride.status });
});

/**
 * GET /requestRide?blockId=x
 * Used by user device to poll ride status.
 */
app.get("/requestRide", async (req, res) => {
  const { blockId } = req.query;
  if (!blockId)
  {
    return res.status(400).json({ error: "blockId required" });
  }
  const ride = await Ride.findOne({ blockId }).sort({ createdAt: -1 }).lean();
  if (!ride)
  {
    return res.json({ status: "NO_RIDE" });
  }
  res.json({
    status: ride.status,
    rideId: ride.rideId,
    pullerId: ride.pullerId || null,
  });
});

/**
 * POST /acceptRide
 * Payload: { rideId, pullerId }
 * TEST CASE 9: Conflict resolution - first timestamp wins
 */
app.post("/acceptRide", async (req, res) => {
  const { rideId, pullerId } = req.body;
  const ride = await Ride.findOne({ rideId });
  if (!ride) {
    return res.status(404).json({ error: "Ride not found" });
  }

  // TEST CASE 9: Conflict resolution - check if already accepted
  if (ride.status === "ACCEPTED" && ride.pullerId !== pullerId) {
    // Another puller already accepted (first timestamp wins)
    return res.status(409).json({ 
      error: "Ride already accepted by another puller",
      acceptedBy: ride.pullerId,
      acceptedAt: ride.acceptedAt
    });
  }

  // Cancel timeout if ride is accepted
  if (activeRideAssignments.has(rideId)) {
    const assignment = activeRideAssignments.get(rideId);
    clearTimeout(assignment.timeoutId);
    activeRideAssignments.delete(rideId);

    // TEST CASE 8: Notify other pullers that request was filled
    for (const otherPullerId of assignment.availablePullers) {
      if (otherPullerId !== pullerId) {
        const otherWs = pullerSockets.get(otherPullerId);
        if (otherWs) {
          try {
            otherWs.send(JSON.stringify({
              type: "CANCEL_RIDE",
              rideId: rideId,
              reason: "Request filled by another puller"
            }));
          } catch (error) {
            console.error(`[DISPATCH] Error notifying ${otherPullerId}:`, error);
          }
        }
      }
    }
  }

  ride.status = "ACCEPTED";
  ride.pullerId = pullerId;
  ride.acceptedAt = new Date();
  await ride.save();
  
  await Puller.findOneAndUpdate(
    { pullerId },
    { status: "ON_TRIP" }
  );

  logTestEvent(6, "PASS", `Ride ${rideId} accepted by ${pullerId} at ${ride.acceptedAt}`);
  res.json({ ok: true, acceptedAt: ride.acceptedAt });
});

/**
 * POST /rejectRide
 * Payload: { rideId, pullerId, reason }
 */
app.post("/rejectRide", async (req, res) => {
  const { rideId, pullerId, reason } = req.body;
  const ride = await Ride.findOneAndUpdate(
    { rideId },
    { status: "REJECTED", metadata: { reason } }
  );
  if (ride && ride.pullerId)
  {
    const ws = pullerSockets.get(ride.pullerId);
    if (ws)
    {
      ws.send(
        JSON.stringify({ type: "CANCEL_RIDE", rideId, reason: "User rejected" })
      );
    }
  }
  logTestEvent(6, "FAIL", `Ride ${rideId} rejected: ${reason || "unknown"}`);
  res.json({ ok: true });
});

/**
 * POST /updateLocation
 * Payload: { pullerId, rideId, latitude, longitude }
 */
app.post("/updateLocation", async (req, res) => {
  const { pullerId, rideId, latitude, longitude } = req.body;
  if (!pullerId || latitude === undefined || longitude === undefined)
  {
    return res.status(400).json({ error: "Invalid payload" });
  }
  await LocationLog.create({ pullerId, rideId, latitude, longitude });
  await Puller.findOneAndUpdate(
    { pullerId },
    {
      lastKnownLocation: {
        latitude,
        longitude,
        updatedAt: new Date(),
      },
    }
  );
  res.json({ ok: true });
});

/**
 * POST /confirmPickup
 * Payload: { rideId, pullerId }
 */
app.post("/confirmPickup", async (req, res) => {
  const { rideId, pullerId } = req.body;
  const ride = await Ride.findOne({ rideId });
  if (!ride)
  {
    return res.status(404).json({ error: "Ride not found" });
  }
  if (ride.pullerId !== pullerId)
  {
    return res.status(403).json({ error: "Unauthorized" });
  }
  ride.status = "PICKED_UP";
  await ride.save();
  logTestEvent(6, "PASS", `Ride ${rideId} pickup confirmed by ${pullerId}`);
  res.json({ ok: true });
});

/**
 * POST /completeRide
 * Payload: { rideId, pullerId, dropDistance, points, pointStatus }
 * TEST CASE 7: Point calculation based on GPS accuracy
 */
app.post("/completeRide", async (req, res) => {
  const { rideId, pullerId, dropDistance, points, pointStatus } = req.body;
  const ride = await Ride.findOne({ rideId });
  if (!ride) {
    return res.status(404).json({ error: "Ride not found" });
  }

  ride.status = "COMPLETED";
  ride.completedAt = new Date();
  ride.rewardPoints = points;
  ride.metadata = ride.metadata || {};
  ride.metadata.dropDistance = dropDistance;
  ride.metadata.pointStatus = pointStatus || "REWARDED";
  await ride.save();

  // TEST CASE 7: Only add points if status is REWARDED (not PENDING)
  if (pointStatus === "REWARDED") {
    await Puller.findOneAndUpdate(
      { pullerId },
      { $inc: { totalPoints: points }, status: "AVAILABLE" }
    );

    await PointsHistory.create({
      pullerId,
      rideId,
      delta: points,
      reason: `Drop distance ${dropDistance}m - Points rewarded`,
      recordedAt: new Date(),
    });

    logTestEvent(7, "PASS", `Ride ${rideId} completed with ${points} pts (REWARDED)`);
  } else {
    // TEST CASE 7: Points pending for admin review
    await PointsHistory.create({
      pullerId,
      rideId,
      delta: 0,
      reason: `Drop distance ${dropDistance}m - Points PENDING (admin review required)`,
      recordedAt: new Date(),
    });

    await Puller.findOneAndUpdate(
      { pullerId },
      { status: "AVAILABLE" }
    );

    logTestEvent(7, "PENDING", `Ride ${rideId} completed - ${points} pts PENDING admin review (distance: ${dropDistance}m)`);
  }

  res.json({ ok: true, pointStatus: pointStatus || "REWARDED", points });
});

/**
 * GET /getPoints?pullerId=...
 */
app.get("/getPoints", async (req, res) => {
  const { pullerId } = req.query;
  const puller = await Puller.findOne({ pullerId }).lean();
  if (!puller)
  {
    return res.status(404).json({ error: "Puller not found" });
  }
  const history = await PointsHistory.find({ pullerId })
    .sort({ recordedAt: -1 })
    .limit(10)
    .lean();
  res.json({
    pullerId,
    totalPoints: puller.totalPoints,
    history,
  });
});

/**
 * GET /admin/dashboard
 * Returns aggregated stats for dashboard visuals.
 */
app.get("/admin/dashboard", async (_req, res) => {
  const [totalUsers, totalPullers, totalRides, activeRides, completedRides] =
    await Promise.all([
      User.countDocuments(),
      Puller.countDocuments(),
      Ride.countDocuments(),
      Ride.countDocuments({ status: { $in: ["ASSIGNED", "ACCEPTED"] } }),
      Ride.countDocuments({ status: "COMPLETED" }),
    ]);

  const leaderboard = await Puller.find()
    .sort({ totalPoints: -1 })
    .limit(10)
    .select("pullerId name totalPoints status")
    .lean();

  res.json({
    totals: {
      users: totalUsers,
      pullers: totalPullers,
      rides: totalRides,
      activeRides,
      completedRides,
    },
    leaderboard,
  });
});

app.get("/rides", async (req, res) => {
  const { limit = 20 } = req.query;
  const rides = await Ride.find()
    .sort({ createdAt: -1 })
    .limit(Number(limit))
    .lean();
  res.json(rides);
});

app.get("/pullers", async (_req, res) => {
  const pullers = await Puller.find().lean();
  res.json(pullers);
});

// -------------------------------------------------------------------
// Admin actions
// -------------------------------------------------------------------
app.post("/admin/puller/:pullerId/status", async (req, res) => {
  const { pullerId } = req.params;
  const { status } = req.body;
  if (!["AVAILABLE", "ON_TRIP", "SUSPENDED"].includes(status))
  {
    return res.status(400).json({ error: "Invalid status" });
  }
  await Puller.findOneAndUpdate({ pullerId }, { status }, { upsert: true });
  res.json({ ok: true });
});

app.post("/admin/puller/:pullerId/points", async (req, res) => {
  const { pullerId } = req.params;
  const { delta, reason } = req.body;
  if (typeof delta !== "number")
  {
    return res.status(400).json({ error: "delta numeric required" });
  }
  await Puller.findOneAndUpdate(
    { pullerId },
    { $inc: { totalPoints: delta } },
    { upsert: true }
  );
  await PointsHistory.create({
    pullerId,
    delta,
    reason: reason || "Manual adjustment",
  });
  res.json({ ok: true });
});

// -------------------------------------------------------------------
// Test log helper
// -------------------------------------------------------------------
function logTestEvent(testId, status, detail)
{
  console.log(`[TEST-${testId}][${status}] ${detail}`);
}

// -------------------------------------------------------------------
// Start server
// -------------------------------------------------------------------
server.listen(PORT, '0.0.0.0', () => {
  console.log(`[SERVER] Running on http://0.0.0.0:${PORT}`);
  console.log(`[SERVER] Backend accessible from devices on network`);
});

