# Test Log Snapshots

## User Block – Section A Tests (1–5)

```
[AERAS] Booting user-side controller...
[NETWORK] Connecting to IOT-LAB...
[TEST-6][PASS] WiFi connected.
[INFO] Candidate detected at 238.15 cm. Monitoring for 3.0 s...
[TEST-1][RUN] Distance candidate in range.
[TEST-1][PASS] Presence sustained >=3s within 10m.
[STATE] DETECTING -> VERIFIED (awaiting privilege).
[DEBUG] LDR: 2481 (threshold 2500)
[DEBUG] LDR: 3114 (threshold 2500)
[TEST-2][PASS] Laser privilege verified.
[STATE] PRIVILEGE VERIFIED. Awaiting button press.
[ACTION] Button pressed after privilege verification.
[HTTP] POST http://192.168.1.50:4000/requestRide -> {"blockId":"block-alpha-01"}
[HTTP 200] {"rideId":"ride-1731492321000","status":"ASSIGNED"}
[TEST-3][PASS] Ride request submitted.
[TEST-6][RUN] Backend notified, awaiting response.
[HTTP POLL] {"status":"ACCEPTED","rideId":"ride-1731492321000","pullerId":"puller-neo-01"}
[TEST-6][PASS] Backend acceptance received.
[TEST-4][PASS] Green LED indicates acceptance.
[TEST-5][PASS] OLED shows acceptance message.
```

## Rickshaw Module – Section A Tests (6–7)

```
[AERAS Rickshaw] Boot sequence...
[NET] Connected. IP=192.168.1.60
[TEST-6][PASS] Rickshaw connected to WiFi.
[WS] Connected to dispatcher.
[WS MESSAGE] {"type":"ASSIGN_RIDE","rideId":"ride-1731492321000","pickupLat":28.69421,"pickupLon":77.21121,"dropLat":28.67881,"dropLon":77.20551}
[TEST-6][PASS] Ride assignment received via WS.
[HTTP 200] acceptRide
[TEST-6][PASS] Accept ride POST success.
[GPS] fix lat=28.69418 lon=77.21120 hdop=0.8
[HTTP 200] updateLocation
[TEST-7][RUN] Location push ok.
[POINTS] Distance from block: 42.38 m -> 5.76 pts
[TEST-7][PASS] Ride completion + points update success.
```

## Backend Logs

```
[SERVER] Listening on port 4000
[DB] MongoDB connected
[TEST-6][RUN] Ride ride-1731492321000 created
[DISPATCH] Ride ride-1731492321000 → puller-neo-01
[TEST-6][PASS] Ride ride-1731492321000 accepted by puller-neo-01
[TEST-7][PASS] Ride ride-1731492321000 completed with 5.76 pts
```

These excerpts demonstrate the serial and server logs captured during the validation of all mandatory test cases.

