# AERAS REST & WebSocket Reference

Base URL (default development): `http://localhost:4000`

## REST Endpoints

### `POST /requestRide`
- **Description:** Triggered by user block after successful authentication.
- **Payload:** `{ "blockId": "block-alpha-01" }`
- **Response:** `{ "rideId": "ride-1731492321000", "status": "ASSIGNED" }`
- **Errors:** `400` if blockId missing.

### `GET /requestRide?blockId=<id>`
- **Description:** User device polls ride status.
- **Response:** `{ "status": "ACCEPTED", "rideId": "...", "pullerId": "puller-neo-01" }` or `{ "status": "NO_RIDE" }`.

### `POST /acceptRide`
- **Payload:** `{ "rideId": "ride-...", "pullerId": "puller-neo-01" }`
- **Usage:** Rickshaw confirms assignment.
- **Response:** `{ "ok": true }`

### `POST /rejectRide`
- **Payload:** `{ "rideId": "ride-...", "pullerId": "puller-neo-01", "reason": "User already served" }`
- **Effect:** Ride marked `REJECTED`, user notified.

### `POST /updateLocation`
- **Payload:** `{ "pullerId": "...", "rideId": "...", "latitude": 28.67, "longitude": 77.21 }`
- **Response:** `{ "ok": true }`

### `POST /completeRide`
- **Payload:** `{ "rideId": "...", "pullerId": "...", "dropDistance": 42.3, "points": 5.8 }`
- **Effect:** Marks ride `COMPLETED`, updates points, stores history.

### `GET /getPoints?pullerId=<id>`
- **Response:** `{ "pullerId": "...", "totalPoints": 52.4, "history": [ ... ] }`

### `GET /admin/dashboard`
- **Response:** `{ "totals": { ... }, "leaderboard": [ ... ] }`

### `GET /rides?limit=20`
- **Response:** Latest rides sorted by creation time (descending).

### `GET /pullers`
- **Response:** List of pullers with status and total points.

### `POST /admin/puller/:pullerId/status`
- **Payload:** `{ "status": "SUSPENDED" }`
- **Effect:** Update puller availability.

### `POST /admin/puller/:pullerId/points`
- **Payload:** `{ "delta": 10, "reason": "Recognition bonus" }`
- **Effect:** Manual point adjustment.

## WebSocket (`ws://localhost:4000/ws/pullers`)

### Registration
- Upon connect, client sends: `{ "type": "REGISTER", "pullerId": "puller-neo-01" }`
- Server responds: `{ "type": "REGISTERED", "pullerId": "puller-neo-01" }`

### Ride Assignment
- Server → puller:  
  `{ "type": "ASSIGN_RIDE", "rideId": "...", "blockId": "block-alpha-01", "pickupLat": ..., "pickupLon": ..., "dropLat": ..., "dropLon": ... }`

### Ride Cancellation
- Server → puller: `{ "type": "CANCEL_RIDE", "rideId": "...", "reason": "User timeout" }`

### Heartbeat
- Server enables heartbeat (15 s interval). Client should rely on built-in reconnection to maintain session.

## Reward Formula

```
points = max(0, 10 - (distance_from_block_meters / 10))
```

Distance is computed on firmware using Haversine formula; backend trusts provided value but logs it for audit. Supervisors can override via admin endpoint if a correction is needed.

