# Integration & Edge Case Playbook

## Scenario 1 – Happy Path Ride

1. User enters detection zone for ≥3 s → `TEST-1` pass.
2. Laser alignment authenticates privilege → `TEST-2` pass.
3. Button press within 8 s dispatch window posts `/requestRide`.
4. Backend dispatches to nearest online puller via WebSocket.
5. Rickshaw accepts ride; `/acceptRide` updates state to `ACCEPTED`.
6. User sees green LED/OLED update. Rickshaw streams GPS -> `/updateLocation`.
7. Rickshaw reaches drop zone (≤50 m) → `/completeRide` calculates reward points.

Validation: Observe serial logs + dashboard showing ride moving from *Active* to *Completed*, leaderboard updates.

## Scenario 2 – Multiple Users in Queue

1. Block A requests ride; no puller available.
2. Backend leaves ride in `PENDING_ASSIGNMENT` and logs `No pullers online`.
3. When a puller reconnects, backend cron (or manual trigger) re-runs `assignRideToPuller`.
4. Additional blocks create rides; each queue entry is assigned FIFO.

Expected: Dashboard ride list shows pending entries; when puller becomes available, assignments fire sequentially.

## Scenario 3 – Network Failure on User Block

1. Disconnect Wi-Fi after ride request sent.
2. `handleBackendResponse()` attempts reconnection; if still offline after timeout, user receives red LED + buzzer.
3. Backend auto-cancels ride after 20 s inactivity (manual extension recommended for production).

Expected: User logs include `TEST-4 FAIL Timeout waiting for ride acceptance`; dashboard shows ride `REJECTED`.

## Scenario 4 – GPS Signal Loss Mid-Trip

1. Cover GPS antenna; `gps.location.isValid()` returns false.
2. After `GPS_BLANK_TIMEOUT_MS`, firmware displays `GPS signal lost...`.
3. Location updates pause until fix reacquired, then resume pushing to backend.

Expected: `TEST-7 RUN GPS fix missing` log present, but ride stays active. Points only calculated once drop zone satisfied.

## Scenario 5 – Manual Puller Suspension

1. Supervisor uses dashboard to set puller status to `SUSPENDED`.
2. Backend updates `Puller` document; ride assignment skips suspended entries.
3. When status toggled back to `AVAILABLE`, dispatcher will include puller again.

Expected: Dashboard message “Status updated successfully.” and `Puller` list shows updated state; no new rides assigned while suspended.

## Scenario 6 – Reward Adjustment

1. Complete a ride to award automatic points.
2. Supervisor issues manual +2 points via dashboard form.
3. `/admin/puller/:pullerId/points` logs new history entry.

Expected: Dashboard leaderboard refreshes showing updated total; `PointsHistory` includes reason string.

## Scenario 7 – Backend Restart

1. Stop Node.js server mid-ride.
2. User block polls `/requestRide` and receives HTTP error; resets to idle.
3. Rickshaw WebSocket detects disconnect, attempts reconnect (heartbeat).
4. After backend restarts, state is restored from Mongo documents.

Expected: WS log `[WS] Disconnected. Reconnecting...`; after reconnection, dispatcher can reassign pending rides.

