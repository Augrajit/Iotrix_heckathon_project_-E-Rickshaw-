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

async function assignRideToPuller(rideDoc)
{
  const availableEntries = Array.from(pullerSockets.entries());
  if (availableEntries.length === 0)
  {
    console.log("[DISPATCH] No pullers online. Marking ride as pending.");
    return null;
  }
  const [pullerId, ws] = availableEntries[0];
  const payload = {
    type: "ASSIGN_RIDE",
    rideId: rideDoc.rideId,
    blockId: rideDoc.blockId,
    pickupLat: rideDoc.pickupLocation?.latitude || 0,
    pickupLon: rideDoc.pickupLocation?.longitude || 0,
    dropLat: rideDoc.dropLocation?.latitude || 0,
    dropLon: rideDoc.dropLocation?.longitude || 0,
  };
  ws.send(JSON.stringify(payload));
  console.log(`[DISPATCH] Ride ${rideDoc.rideId} → ${pullerId}`);
  rideDoc.status = "ASSIGNED";
  rideDoc.pullerId = pullerId;
  await rideDoc.save();
  await Puller.updateOne({ pullerId }, { status: "ON_TRIP" });
  return pullerId;
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
 */
app.post("/acceptRide", async (req, res) => {
  const { rideId, pullerId } = req.body;
  const ride = await Ride.findOne({ rideId });
  if (!ride)
  {
    return res.status(404).json({ error: "Ride not found" });
  }
  ride.status = "ACCEPTED";
  ride.pullerId = pullerId;
  ride.acceptedAt = new Date();
  await ride.save();
  logTestEvent(6, "PASS", `Ride ${rideId} accepted by ${pullerId}`);
  res.json({ ok: true });
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
 * POST /completeRide
 * Payload: { rideId, pullerId, dropDistance, points }
 */
app.post("/completeRide", async (req, res) => {
  const { rideId, pullerId, dropDistance, points } = req.body;
  const ride = await Ride.findOne({ rideId });
  if (!ride)
  {
    return res.status(404).json({ error: "Ride not found" });
  }
  ride.status = "COMPLETED";
  ride.completedAt = new Date();
  ride.rewardPoints = points;
  await ride.save();

  await Puller.findOneAndUpdate(
    { pullerId },
    { $inc: { totalPoints: points }, status: "AVAILABLE" }
  );

  await PointsHistory.create({
    pullerId,
    rideId,
    delta: points,
    reason: `Drop distance ${dropDistance}m`,
  });

  logTestEvent(7, "PASS", `Ride ${rideId} completed with ${points} pts`);
  res.json({ ok: true });
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

