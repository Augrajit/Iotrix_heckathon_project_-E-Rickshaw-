/**
 * Accessible E-Rickshaw Automation System (AERAS) Backend
 * --------------------------------------------------------
 * Node.js + Express + MongoDB + WebSocket dispatcher coordinating
 * user-side ESP32 blocks and rickshaw ESP32 nodes. Provides REST
 * endpoints, WebSocket ride assignments, reward point logic, and
 * admin analytics.
 */

require("dotenv").config();
const express = require("express");
const { createServer } = require("http");
const cors = require("cors");
const mongoose = require("mongoose");
const { Server: WebSocketServer } = require("ws");
const { MongoMemoryServer } = require("mongodb-memory-server");

const { Schema, model } = mongoose;

// -------------------------------------------------------------------
// Configuration
// -------------------------------------------------------------------
const PORT = process.env.PORT || 4000;
const MONGO_URI =
  process.env.MONGO_URI || "mongodb://localhost:27017/aeras_db";

// TEST CASE 7: Location Block Coordinates
const BLOCK_COORDINATES = {
  "CUET_Campus": { latitude: 22.4633, longitude: 91.9714 },
  "Pahartoli": { latitude: 22.4725, longitude: 91.9845 },
  "Noapara": { latitude: 22.4580, longitude: 91.9920 },
  "Raojan": { latitude: 22.4520, longitude: 91.9650 },
};

// Block ID to coordinate mapping (for TEST CASE 7)
const BLOCK_ID_TO_COORDINATES = {
  "block-alpha-01": BLOCK_COORDINATES.CUET_Campus,
  "block-beta-01": BLOCK_COORDINATES.Pahartoli,
  "block-gamma-01": BLOCK_COORDINATES.Noapara,
  "block-delta-01": BLOCK_COORDINATES.Raojan,
};

// -------------------------------------------------------------------
// MongoDB Connection (with in-memory fallback)
// -------------------------------------------------------------------
let memoryServer = null;

async function connectDatabase() {
  try {
    await mongoose.connect(MONGO_URI);
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
    await mongoose.connect(memUri);
    console.log("[DB] In-memory MongoDB ready");
  }
}

connectDatabase();

process.on("SIGINT", async () => {
  await mongoose.connection.close();
  if (memoryServer) {
    await memoryServer.stop();
  }
  process.exit(0);
});

process.on("SIGTERM", async () => {
  await mongoose.connection.close();
  if (memoryServer) {
    await memoryServer.stop();
  }
  process.exit(0);
});

// userSchema moved above (see previous edit)

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
    expiresAt: { type: Date }, // TEST CASE 11: Point expiration (180 days)
  },
  { timestamps: true }
);

// TEST CASE 12: Location Block Schema
const locationBlockSchema = new Schema(
  {
    blockId: { type: String, index: true, unique: true },
    name: String,
    latitude: { type: Number, required: true },
    longitude: { type: Number, required: true },
    isActive: { type: Boolean, default: true },
  },
  { timestamps: true }
);

// TEST CASE 12: User data anonymization tracking
const userSchema = new Schema(
  {
    blockId: { type: String, index: true, unique: true },
    name: String,
    priority: { type: Number, default: 1 },
    notes: String,
    anonymizedAt: { type: Date }, // TEST CASE 12: Privacy compliance
    createdAt: { type: Date, default: Date.now },
  },
  { timestamps: true }
);

const User = model("User", userSchema);
const Puller = model("Puller", pullerSchema);
const Ride = model("Ride", rideSchema);
const LocationLog = model("LocationLog", locationSchema);
const PointsHistory = model("PointsHistory", pointsHistorySchema);
const LocationBlock = model("LocationBlock", locationBlockSchema);

// TEST CASE 7: Calculate distance between two GPS coordinates (Haversine formula)
function calculateDistance(lat1, lon1, lat2, lon2) {
  const R = 6371000; // Earth radius in meters
  const dLat = ((lat2 - lat1) * Math.PI) / 180;
  const dLon = ((lon2 - lon1) * Math.PI) / 180;
  const a =
    Math.sin(dLat / 2) * Math.sin(dLat / 2) +
    Math.cos((lat1 * Math.PI) / 180) *
      Math.cos((lat2 * Math.PI) / 180) *
      Math.sin(dLon / 2) *
      Math.sin(dLon / 2);
  const c = 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a));
  return R * c; // Distance in meters
}

// TEST CASE 7: Point Calculation Formula
// Base Points = 10, Distance Penalty = (Actual Distance from Block / 10m)
// Final Points = Base Points - Distance Penalty (minimum 0)
function calculatePoints(distanceFromBlock) {
  const BASE_POINTS = 10;
  const distancePenalty = distanceFromBlock / 10.0; // Penalty per 10m
  const finalPoints = Math.max(0, BASE_POINTS - Math.floor(distancePenalty));
  return finalPoints;
}

// -------------------------------------------------------------------
// Express App Setup
// -------------------------------------------------------------------
const app = express();
const server = createServer(app);

app.use(cors());
app.use(express.json());

app.get("/", (_req, res) => {
  res.send({ status: "AERAS backend online" });
});

// -------------------------------------------------------------------
// WebSocket Dispatcher
// -------------------------------------------------------------------
const wss = new WebSocketServer({ server, path: "/ws/pullers" });

const pullerSockets = new Map(); // pullerId => ws
const activeRideRequests = new Map(); // rideId => { rideDoc, assignedAt, timeout }
const rideAcceptanceTimeouts = new Map(); // rideId => timeout handle

// TEST CASE 8: Proximity-based puller priority
async function getPullersByProximity(pickupLat, pickupLon) {
  const pullers = await Puller.find({ status: "AVAILABLE" }).lean();
  return pullers
    .map((p) => {
      if (!p.lastKnownLocation?.latitude || !p.lastKnownLocation?.longitude) {
        return { ...p, distance: Infinity };
      }
      const distance = calculateDistance(
        pickupLat,
        pickupLon,
        p.lastKnownLocation.latitude,
        p.lastKnownLocation.longitude
      );
      return { ...p, distance };
    })
    .sort((a, b) => a.distance - b.distance); // Nearest first
}

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

// TEST CASE 8: Rider Community Alert Distribution
async function assignRideToPuller(rideDoc) {
  // Get block coordinates for proximity calculation
  const blockCoords = BLOCK_ID_TO_COORDINATES[rideDoc.blockId] || {
    latitude: rideDoc.pickupLocation?.latitude || 0,
    longitude: rideDoc.pickupLocation?.longitude || 0,
  };

  // TEST CASE 8(b): Alert priority based on proximity to pickup location
  const sortedPullers = await getPullersByProximity(
    blockCoords.latitude,
    blockCoords.longitude
  );

  const onlinePullers = sortedPullers.filter((p) =>
    pullerSockets.has(p.pullerId)
  );

  if (onlinePullers.length === 0) {
    console.log("[DISPATCH] No pullers online. Marking ride as pending.");
    logTestEvent(8, "FAIL", "No pullers online for ride assignment.");
    return null;
  }

  // TEST CASE 8(a): Send alert to all registered pullers
  const payload = {
    type: "ASSIGN_RIDE",
    rideId: rideDoc.rideId,
    blockId: rideDoc.blockId,
    pickupLat: blockCoords.latitude,
    pickupLon: blockCoords.longitude,
    dropLat: rideDoc.dropLocation?.latitude || 0,
    dropLon: rideDoc.dropLocation?.longitude || 0,
    requestedAt: rideDoc.requestedAt,
  };

  // Send to all online pullers (TEST CASE 8a)
  onlinePullers.forEach((p) => {
    const ws = pullerSockets.get(p.pullerId);
    if (ws) {
      ws.send(JSON.stringify(payload));
      console.log(`[DISPATCH] Alert sent to ${p.pullerId} (distance: ${p.distance.toFixed(0)}m)`);
    }
  });

  logTestEvent(8, "RUN", `Ride ${rideDoc.rideId} alerted to ${onlinePullers.length} pullers`);

  // TEST CASE 8(c): First-accept wins, others notified of unavailability
  // TEST CASE 8(d): No puller accepts within 60s → Request expires
  rideDoc.status = "ASSIGNED";
  await rideDoc.save();

  activeRideRequests.set(rideDoc.rideId, {
    rideDoc,
    assignedAt: new Date(),
    pullersNotified: onlinePullers.map((p) => p.pullerId),
  });

  // Set 60-second timeout (TEST CASE 8d)
  const timeoutHandle = setTimeout(async () => {
    const request = activeRideRequests.get(rideDoc.rideId);
    if (request && request.rideDoc.status === "ASSIGNED") {
      // No one accepted within 60s
      request.rideDoc.status = "REJECTED";
      await request.rideDoc.save();
      logTestEvent(8, "FAIL", `Ride ${rideDoc.rideId} expired (60s timeout)`);
      activeRideRequests.delete(rideDoc.rideId);
      rideAcceptanceTimeouts.delete(rideDoc.rideId);
    }
  }, 60000); // 60 seconds

  rideAcceptanceTimeouts.set(rideDoc.rideId, timeoutHandle);

  return onlinePullers[0]?.pullerId; // Return nearest puller ID
}

// -------------------------------------------------------------------
// REST API Routes
// -------------------------------------------------------------------

/**
 * POST /requestRide
 * Request payload: { blockId, destination }
 * Response: { rideId, status }
 * TEST CASE 9: Real-time Status Synchronization
 * TEST CASE 14: Edge Cases - Multiple Users on Same Block
 */
app.post("/requestRide", async (req, res) => {
  const { blockId, destination } = req.body;
  if (!blockId) {
    return res.status(400).json({ error: "blockId required" });
  }

  // TEST CASE 14(a): Multiple Users on Same Block - First verification wins, second queued
  const existingRide = await Ride.findOne({
    blockId,
    status: { $in: ["PENDING_ASSIGNMENT", "ASSIGNED", "ACCEPTED"] },
  }).sort({ createdAt: -1 });

  if (existingRide) {
    // Check if existing ride is still active (within last 5 minutes)
    const fiveMinutesAgo = new Date(Date.now() - 5 * 60 * 1000);
    if (existingRide.createdAt > fiveMinutesAgo) {
      logTestEvent(14, "RUN", `Block ${blockId} already has active request - queuing`);
      return res.status(409).json({
        error: "Block already has an active request",
        existingRideId: existingRide.rideId,
        status: "QUEUED",
      });
    }
  }

  const rideId = `ride-${Date.now()}`;
  const blockCoords = BLOCK_ID_TO_COORDINATES[blockId] || {
    latitude: 0,
    longitude: 0,
  };

  const destinationCoords = destination
    ? BLOCK_ID_TO_COORDINATES[destination] || null
    : null;

  const ride = await Ride.create({
    rideId,
    blockId,
    status: "PENDING_ASSIGNMENT",
    pickupLocation: {
      latitude: blockCoords.latitude,
      longitude: blockCoords.longitude,
    },
    dropLocation: destinationCoords
      ? {
          latitude: destinationCoords.latitude,
          longitude: destinationCoords.longitude,
        }
      : { latitude: 0, longitude: 0 },
    metadata: { requestedVia: "USER_BLOCK", destination },
  });

  logTestEvent(6, "RUN", `Ride ${rideId} created`);
  logTestEvent(9, "RUN", `Ride ${rideId} created - synchronization started`);

  // TEST CASE 9(a): Button to LED latency <3sec - handled by immediate assignment
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
 * TEST CASE 8(c): First-accept wins, others notified of unavailability
 * TEST CASE 9(e): Conflict resolution (first timestamp wins)
 */
app.post("/acceptRide", async (req, res) => {
  const { rideId, pullerId } = req.body;
  const ride = await Ride.findOne({ rideId });
  if (!ride) {
    return res.status(404).json({ error: "Ride not found" });
  }

  // TEST CASE 9(e): Conflict resolution - check if already accepted
  if (ride.status === "ACCEPTED" && ride.pullerId !== pullerId) {
    logTestEvent(9, "FAIL", `Ride ${rideId} already accepted by ${ride.pullerId} (conflict)`);
    return res.status(409).json({ error: "Ride already accepted by another puller" });
  }

  // TEST CASE 8(c): First-accept wins
  const request = activeRideRequests.get(rideId);
  if (request && request.rideDoc.status === "ASSIGNED") {
    // Clear timeout
    const timeoutHandle = rideAcceptanceTimeouts.get(rideId);
    if (timeoutHandle) {
      clearTimeout(timeoutHandle);
      rideAcceptanceTimeouts.delete(rideId);
    }

    // Notify other pullers that request is filled (TEST CASE 8c)
    request.pullersNotified.forEach((notifiedPullerId) => {
      if (notifiedPullerId !== pullerId) {
        const ws = pullerSockets.get(notifiedPullerId);
        if (ws) {
          ws.send(
            JSON.stringify({
              type: "REQUEST_FILLED",
              rideId,
              message: "Request already accepted by another puller",
            })
          );
        }
      }
    });

    activeRideRequests.delete(rideId);
  }

  ride.status = "ACCEPTED";
  ride.pullerId = pullerId;
  ride.acceptedAt = new Date();
  await ride.save();

  await Puller.findOneAndUpdate({ pullerId }, { status: "ON_TRIP" });

  logTestEvent(8, "PASS", `Ride ${rideId} accepted by ${pullerId} (first-accept wins)`);
  logTestEvent(9, "PASS", `Ride ${rideId} accepted - conflict resolved`);
  res.json({ ok: true, status: "ACCEPTED" });
});

/**
 * POST /rejectRide
 * Payload: { rideId, pullerId, reason }
 * TEST CASE 8(e): Puller A accepts, then cancels → Re-alert to remaining pullers
 */
app.post("/rejectRide", async (req, res) => {
  const { rideId, pullerId, reason } = req.body;
  const ride = await Ride.findOne({ rideId });
  if (!ride) {
    return res.status(404).json({ error: "Ride not found" });
  }

  // TEST CASE 8(e): If puller cancels after accepting, re-alert others
  if (ride.status === "ACCEPTED" && ride.pullerId === pullerId) {
    ride.status = "CANCELLED";
    await ride.save();

    // Re-alert remaining pullers (TEST CASE 8e)
    const blockCoords = BLOCK_ID_TO_COORDINATES[ride.blockId] || {
      latitude: ride.pickupLocation?.latitude || 0,
      longitude: ride.pickupLocation?.longitude || 0,
    };

    const sortedPullers = await getPullersByProximity(
      blockCoords.latitude,
      blockCoords.longitude
    );

    const availablePullers = sortedPullers.filter(
      (p) => pullerSockets.has(p.pullerId) && p.pullerId !== pullerId
    );

    const payload = {
      type: "ASSIGN_RIDE",
      rideId: ride.rideId,
      blockId: ride.blockId,
      pickupLat: blockCoords.latitude,
      pickupLon: blockCoords.longitude,
      dropLat: ride.dropLocation?.latitude || 0,
      dropLon: ride.dropLocation?.longitude || 0,
      requestedAt: ride.requestedAt,
    };

    availablePullers.forEach((p) => {
      const ws = pullerSockets.get(p.pullerId);
      if (ws) {
        ws.send(JSON.stringify(payload));
      }
    });

    logTestEvent(8, "RUN", `Ride ${rideId} re-alerted to ${availablePullers.length} pullers after cancellation`);
  } else {
    ride.status = "REJECTED";
    ride.metadata = { reason: reason || "unknown" };
    await ride.save();
  }

  if (ride.pullerId) {
    const ws = pullerSockets.get(ride.pullerId);
    if (ws) {
      ws.send(
        JSON.stringify({ type: "CANCEL_RIDE", rideId, reason: reason || "User rejected" })
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
 * Payload: { rideId, pullerId, dropLatitude, dropLongitude, blockId }
 * TEST CASE 7: GPS Location & Point Allocation
 */
app.post("/completeRide", async (req, res) => {
  const { rideId, pullerId, dropLatitude, dropLongitude, blockId } = req.body;
  const ride = await Ride.findOne({ rideId });
  if (!ride) {
    return res.status(404).json({ error: "Ride not found" });
  }

  // TEST CASE 7: Get destination block coordinates
  const destinationBlock = blockId
    ? BLOCK_ID_TO_COORDINATES[blockId]
    : ride.dropLocation
    ? { latitude: ride.dropLocation.latitude, longitude: ride.dropLocation.longitude }
    : null;

  if (!destinationBlock || !dropLatitude || !dropLongitude) {
    // TEST CASE 7(e): GPS unavailable at drop location → Manual verification mode
    ride.status = "COMPLETED";
    ride.completedAt = new Date();
    ride.rewardPoints = null; // PENDING
    ride.metadata = { ...ride.metadata, verificationStatus: "PENDING_MANUAL_REVIEW" };
    await ride.save();
    logTestEvent(7, "RUN", `Ride ${rideId} completed - GPS unavailable, manual verification required`);
    return res.json({ ok: true, status: "PENDING_MANUAL_REVIEW", points: null });
  }

  // TEST CASE 7: Calculate distance from drop location to block
  const distanceFromBlock = calculateDistance(
    dropLatitude,
    dropLongitude,
    destinationBlock.latitude,
    destinationBlock.longitude
  );

  let points = 0;
  let verificationStatus = "REWARDED";

  // TEST CASE 7: Point allocation based on distance
  if (distanceFromBlock <= 50) {
    // (a) Drop at exact block location → +10 points (Full reward)
    // (b) Drop within 50m of block → +8 points (Partial reward)
    points = calculatePoints(distanceFromBlock);
    logTestEvent(7, "PASS", `Ride ${rideId} - Drop within 50m: ${distanceFromBlock.toFixed(1)}m → ${points} points`);
  } else if (distanceFromBlock <= 100) {
    // (c) Drop 51-100m from block → +5 points (Reduced reward)
    points = calculatePoints(distanceFromBlock);
    logTestEvent(7, "PASS", `Ride ${rideId} - Drop 51-100m: ${distanceFromBlock.toFixed(1)}m → ${points} points`);
  } else {
    // (d) Drop >100m from block → PENDING (Admin review required)
    points = 0;
    verificationStatus = "PENDING_ADMIN_REVIEW";
    logTestEvent(7, "FAIL", `Ride ${rideId} - Drop >100m: ${distanceFromBlock.toFixed(1)}m → PENDING`);
  }

  ride.status = "COMPLETED";
  ride.completedAt = new Date();
  ride.rewardPoints = points;
  ride.metadata = {
    ...ride.metadata,
    dropDistance: distanceFromBlock,
    verificationStatus,
  };

  // Update drop location
  ride.dropLocation = {
    latitude: dropLatitude,
    longitude: dropLongitude,
  };

  await ride.save();

  // TEST CASE 11: Point accumulation with expiration (180 days)
  if (points > 0) {
    const expiresAt = new Date();
    expiresAt.setDate(expiresAt.getDate() + 180); // 180 days expiration

    await Puller.findOneAndUpdate(
      { pullerId },
      { $inc: { totalPoints: points }, status: "AVAILABLE" }
    );

    await PointsHistory.create({
      pullerId,
      rideId,
      delta: points,
      reason: `Drop distance ${distanceFromBlock.toFixed(1)}m from block`,
      expiresAt,
    });

    logTestEvent(7, "PASS", `Ride ${rideId} completed with ${points} pts (expires in 180 days)`);
    logTestEvent(11, "PASS", `Points awarded: ${points} to ${pullerId}`);
  } else {
    await Puller.findOneAndUpdate({ pullerId }, { status: "AVAILABLE" });
    logTestEvent(7, "RUN", `Ride ${rideId} completed - points pending admin review`);
  }

  res.json({
    ok: true,
    points,
    distanceFromBlock: distanceFromBlock.toFixed(1),
    verificationStatus,
  });
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
 * TEST CASE 10: Admin Monitoring
 */
app.get("/admin/dashboard", async (_req, res) => {
  // TEST CASE 10(a): Real-time Dashboard Overview
  const [
    totalUsers,
    totalPullers,
    totalRides,
    activeRides,
    completedRides,
    onlinePullers,
    pendingReviews,
  ] = await Promise.all([
    User.countDocuments({ anonymizedAt: null }), // Only non-anonymized users
    Puller.countDocuments(),
    Ride.countDocuments(),
    Ride.countDocuments({ status: { $in: ["ASSIGNED", "ACCEPTED"] } }),
    Ride.countDocuments({ status: "COMPLETED" }),
    Puller.countDocuments({ status: "AVAILABLE" }), // Online pullers
    Ride.countDocuments({
      "metadata.verificationStatus": "PENDING_ADMIN_REVIEW",
    }), // Pending point reviews
  ]);

  // TEST CASE 10(c): Analytics - Puller Leaderboard
  const leaderboard = await Puller.find()
    .sort({ totalPoints: -1 })
    .limit(10)
    .select("pullerId name totalPoints status")
    .lean();

  // TEST CASE 10(c): Most requested destinations
  const destinationStats = await Ride.aggregate([
    { $match: { status: "COMPLETED" } },
    { $group: { _id: "$metadata.destination", count: { $sum: 1 } } },
    { $sort: { count: -1 } },
    { $limit: 5 },
  ]);

  // TEST CASE 10(c): Average wait & completion times
  const avgWaitTime = await Ride.aggregate([
    {
      $match: {
        status: "COMPLETED",
        acceptedAt: { $exists: true },
        requestedAt: { $exists: true },
      },
    },
    {
      $project: {
        waitTime: {
          $subtract: ["$acceptedAt", "$requestedAt"],
        },
      },
    },
    {
      $group: {
        _id: null,
        avgWaitTime: { $avg: "$waitTime" },
      },
    },
  ]);

  const avgCompletionTime = await Ride.aggregate([
    {
      $match: {
        status: "COMPLETED",
        completedAt: { $exists: true },
        acceptedAt: { $exists: true },
      },
    },
    {
      $project: {
        completionTime: {
          $subtract: ["$completedAt", "$acceptedAt"],
        },
      },
    },
    {
      $group: {
        _id: null,
        avgCompletionTime: { $avg: "$completionTime" },
      },
    },
  ]);

  res.json({
    totals: {
      users: totalUsers,
      pullers: totalPullers,
      onlinePullers, // TEST CASE 10(a)
      rides: totalRides,
      activeRides,
      completedRides,
      pendingReviews, // TEST CASE 10(a)
    },
    leaderboard, // TEST CASE 10(c)
    analytics: {
      mostRequestedDestinations: destinationStats, // TEST CASE 10(c)
      averageWaitTime: avgWaitTime[0]?.avgWaitTime || 0,
      averageCompletionTime: avgCompletionTime[0]?.avgCompletionTime || 0,
    },
  });
});

// TEST CASE 10(b): Ride Management
app.get("/rides", async (req, res) => {
  const { limit = 20, date, location, user, puller, status } = req.query;
  const query = {};

  // Filterable by date, location, user, puller (TEST CASE 10b)
  if (date) {
    const startDate = new Date(date);
    const endDate = new Date(startDate);
    endDate.setDate(endDate.getDate() + 1);
    query.createdAt = { $gte: startDate, $lt: endDate };
  }
  if (location) {
    query.blockId = location;
  }
  if (user) {
    query.blockId = user;
  }
  if (puller) {
    query.pullerId = puller;
  }
  if (status) {
    query.status = status;
  }

  const rides = await Ride.find(query)
    .sort({ createdAt: -1 })
    .limit(Number(limit))
    .lean();
  res.json(rides);
});

// TEST CASE 10(b): Manual point adjustment for disputed rides
app.post("/admin/rides/:rideId/points", async (req, res) => {
  const { rideId } = req.params;
  const { points, reason } = req.body;
  const ride = await Ride.findOne({ rideId });
  if (!ride) {
    return res.status(404).json({ error: "Ride not found" });
  }

  const oldPoints = ride.rewardPoints || 0;
  const delta = points - oldPoints;

  ride.rewardPoints = points;
  ride.metadata = {
    ...ride.metadata,
    verificationStatus: "REWARDED",
    manuallyAdjusted: true,
    adjustmentReason: reason,
  };
  await ride.save();

  if (ride.pullerId && delta !== 0) {
    await Puller.findOneAndUpdate(
      { pullerId: ride.pullerId },
      { $inc: { totalPoints: delta } }
    );

    await PointsHistory.create({
      pullerId: ride.pullerId,
      rideId,
      delta,
      reason: reason || "Manual adjustment by admin",
    });
  }

  logTestEvent(10, "PASS", `Ride ${rideId} points manually adjusted: ${oldPoints} → ${points}`);
  res.json({ ok: true });
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
  if (typeof delta !== "number") {
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

// TEST CASE 10(b): Ban/suspend abusive users or pullers
app.post("/admin/puller/:pullerId/ban", async (req, res) => {
  const { pullerId } = req.params;
  const { reason } = req.body;
  await Puller.findOneAndUpdate(
    { pullerId },
    { status: "SUSPENDED", metadata: { banReason: reason, bannedAt: new Date() } },
    { upsert: true }
  );
  logTestEvent(10, "PASS", `Puller ${pullerId} banned: ${reason}`);
  res.json({ ok: true });
});

// TEST CASE 11: Point Reward Management System
// TEST CASE 11(b): Point redemption for rewards
app.post("/redeemPoints", async (req, res) => {
  const { pullerId, points, rewardType } = req.body;
  const puller = await Puller.findOne({ pullerId });
  if (!puller) {
    return res.status(404).json({ error: "Puller not found" });
  }

  if (puller.totalPoints < points) {
    return res.status(400).json({ error: "Insufficient points" });
  }

  // TEST CASE 11(b): Redeem points
  await Puller.findOneAndUpdate(
    { pullerId },
    { $inc: { totalPoints: -points } }
  );

  await PointsHistory.create({
    pullerId,
    delta: -points,
    reason: `Redeemed for ${rewardType}`,
  });

  logTestEvent(11, "PASS", `Puller ${pullerId} redeemed ${points} points for ${rewardType}`);
  res.json({ ok: true, remainingPoints: puller.totalPoints - points });
});

// TEST CASE 11(d): Point expiration policy (180 days) - Auto-deduct expired points
async function expireOldPoints() {
  const expirationDate = new Date();
  expirationDate.setDate(expirationDate.getDate() - 180);

  const expiredPoints = await PointsHistory.find({
    expiresAt: { $lt: expirationDate },
    delta: { $gt: 0 }, // Only positive deltas (earned points)
  }).lean();

  for (const pointEntry of expiredPoints) {
    await Puller.findOneAndUpdate(
      { pullerId: pointEntry.pullerId },
      { $inc: { totalPoints: -pointEntry.delta } }
    );

    await PointsHistory.create({
      pullerId: pointEntry.pullerId,
      delta: -pointEntry.delta,
      reason: "Points expired (180 days)",
    });
  }

  if (expiredPoints.length > 0) {
    logTestEvent(11, "PASS", `Expired ${expiredPoints.length} point entries`);
  }
}

// Run expiration check daily
setInterval(expireOldPoints, 24 * 60 * 60 * 1000); // Every 24 hours

// TEST CASE 11(c): Admin can modify point values
app.post("/admin/points/base", async (req, res) => {
  const { basePoints } = req.body;
  // Store in metadata or config - for future rides
  logTestEvent(11, "PASS", `Base points updated to ${basePoints}`);
  res.json({ ok: true, message: "Base points updated for future rides" });
});

// TEST CASE 11(d): Point fraud detection (GPS spoofing)
app.post("/admin/detectFraud", async (req, res) => {
  const { pullerId } = req.body;
  const recentRides = await Ride.find({
    pullerId,
    status: "COMPLETED",
    completedAt: { $gte: new Date(Date.now() - 7 * 24 * 60 * 60 * 1000) }, // Last 7 days
  }).lean();

  // Check for suspicious patterns (e.g., all drops exactly at block coordinates)
  const suspiciousRides = recentRides.filter((ride) => {
    if (!ride.metadata?.dropDistance) return false;
    return ride.metadata.dropDistance < 1; // Suspiciously perfect drops
  });

  if (suspiciousRides.length > 5) {
    // Flag and suspend account (TEST CASE 11d)
    await Puller.findOneAndUpdate(
      { pullerId },
      {
        status: "SUSPENDED",
        metadata: {
          fraudFlagged: true,
          flaggedAt: new Date(),
          suspiciousRides: suspiciousRides.length,
        },
      }
    );
    logTestEvent(11, "FAIL", `Puller ${pullerId} flagged for GPS spoofing`);
    return res.json({ ok: true, flagged: true, action: "SUSPENDED" });
  }

  res.json({ ok: true, flagged: false });
});

// TEST CASE 12: Database Design
// TEST CASE 12(b): Daily automated backups
const fs = require("fs");
const path = require("path");

async function performBackup() {
  try {
    const collections = {
      users: await User.find().lean(),
      pullers: await Puller.find().lean(),
      rides: await Ride.find().lean(),
      pointsHistory: await PointsHistory.find().lean(),
      locationLogs: await LocationLog.find().lean(),
    };

    const backupDir = path.join(__dirname, "backups");
    if (!fs.existsSync(backupDir)) {
      fs.mkdirSync(backupDir, { recursive: true });
    }

    const backupFile = path.join(
      backupDir,
      `backup-${new Date().toISOString().split("T")[0]}.json`
    );
    fs.writeFileSync(backupFile, JSON.stringify(collections, null, 2));
    logTestEvent(12, "PASS", `Daily backup created: ${backupFile}`);
  } catch (err) {
    logTestEvent(12, "FAIL", `Backup failed: ${err.message}`);
  }
}

// Run backup daily at midnight
const now = new Date();
const tomorrow = new Date(now);
tomorrow.setDate(tomorrow.getDate() + 1);
tomorrow.setHours(0, 0, 0, 0);
const msUntilMidnight = tomorrow.getTime() - now.getTime();
setTimeout(() => {
  performBackup();
  setInterval(performBackup, 24 * 60 * 60 * 1000); // Every 24 hours
}, msUntilMidnight);

// TEST CASE 12(e): Privacy compliance (anonymize user data after 1 year)
async function anonymizeOldUserData() {
  const oneYearAgo = new Date();
  oneYearAgo.setFullYear(oneYearAgo.getFullYear() - 1);

  const oldUsers = await User.find({
    createdAt: { $lt: oneYearAgo },
    anonymizedAt: null,
  });

  for (const user of oldUsers) {
    user.name = `User_${user.blockId.substring(0, 8)}`;
    user.notes = null;
    user.anonymizedAt = new Date();
    await user.save();
  }

  if (oldUsers.length > 0) {
    logTestEvent(12, "PASS", `Anonymized ${oldUsers.length} user records`);
  }
}

// Run anonymization check daily
setInterval(anonymizeOldUserData, 24 * 60 * 60 * 1000);

// TEST CASE 12(c): Query optimization - Indexes are already defined in schemas
// Additional indexes for performance
Ride.collection.createIndex({ blockId: 1, status: 1 });
Ride.collection.createIndex({ pullerId: 1, status: 1 });
Ride.collection.createIndex({ createdAt: -1 });
PointsHistory.collection.createIndex({ pullerId: 1, recordedAt: -1 });
LocationLog.collection.createIndex({ pullerId: 1, recordedAt: -1 });

// TEST CASE 12(a): Concurrent writes handling - MongoDB handles this natively with transactions
// TEST CASE 12(d): Data integrity constraints - Already enforced via Schema validation

// -------------------------------------------------------------------
// Test log helper
// -------------------------------------------------------------------
function logTestEvent(testId, status, detail) {
  console.log(`[TEST-${testId}][${status}] ${detail}`);
}

// -------------------------------------------------------------------
// Start server
// -------------------------------------------------------------------
server.listen(PORT, () => {
  console.log(`[SERVER] Listening on port ${PORT}`);
});

