# Accessible E-Rickshaw Automation System (AERAS)

## Overview

AERAS is an end-to-end, app-less intelligent transportation assist platform tailored for elderly and special-needs commuters. The system spans two ESP32-based hardware nodes, a real-time web backend, and a dashboard for fleet administrators. All components coordinate to authenticate privileged rides at physical location blocks, dispatch nearby e-rickshaws, and award pullers with dynamic reward points.

## Repository Layout

- `user_side/` – ESP32 Arduino firmware for the location block hardware, responsible for multi-sensor user detection, laser privilege verification, ride confirmation, and rich feedback (LEDs, buzzer, OLED, serial test logs).
- `rickshaw_side/` – ESP32 Arduino firmware for the rickshaw module, combining GPS telemetry, backend connectivity, driver-facing OLED guidance, and reward tracking.
- `backend/` – Node.js + Express server with MongoDB ODM (Mongoose), providing REST + WebSocket APIs, ride orchestration, reward logic, and admin controls.
- `dashboard/` – React single-page application consuming backend APIs to manage rides, pullers, leaderboards, and manual interventions.
- `docs/` – Circuit diagrams (ASCII + optional Fritzing placeholders), testing transcripts, and integration notes.

## End-to-End Workflow

1. **User detection** – Ultrasonic sensor validates a presence within 10 m for ≥3 s; OLED + yellow LED communicate readiness.
2. **Privilege verification** – External laser raises LDR intensity above threshold, unlocking confirmation window.
3. **Ride confirmation** – Button press triggers buzzer chirps, posts `/requestRide`, and awaits backend decision. Red/green LEDs plus OLED copy reflect state.
4. **Dispatch coordination** – Backend matches ride to nearest available rickshaw via WebSocket broadcast. Rickshaw unit acknowledges by hitting `/acceptRide`.
5. **Navigation & tracking** – Rickshaw ESP32 streams GPS coordinates (`/updateLocation`) and displays pickup/drop hints.
6. **Completion & scoring** – Drop proximity (±50 m) finalizes ride, computes reward points, and updates `Points_History`.

## Hardware Overview

### User Block (ESP32 DevKit v1)

- **Ultrasonic HC-SR04:** TRIG→`D5`, ECHO→`D18`, 3.3 V supply with logic-level safe wiring.
- **LDR sensor:** Voltage divider with 10 kΩ resistor, output to `A0` (`GPIO36`) to detect the calibration laser.
- **Push button:** Normally open, connected to `D19` with ground reference; relies on internal pull-up.
- **Buzzer:** Passive buzzer on `D21` driven via LEDC (PWM).
- **LEDs:** Red→`D22`, Yellow→`D23`, Green→`D25` each with 220 Ω limit resistor.
- **OLED (SSD1306 I²C):** SDA→`D4`, SCL→`D15`, 3.3 V.
- **Power:** 5 V input (USB or DC) feeding ESP32 3.3 V rail; tie all sensor grounds together.

### Rickshaw Module (ESP32 + GPS)

- **GPS Neo-6M:** TX→`D16` (RX2), RX→`D17` (TX2), powered via 3.3 V/5 V as per module with common ground.
- **OLED (SSD1306 I²C):** SDA→`D4`, SCL→`D15`.
- **Optional status LED/buzzer** can be added on spare pins for driver alerts.

ASCII schematics are included in `docs/circuits.md`.

## Firmware Deployment

### Common Prerequisites

1. Install [Arduino IDE ≥ 2.2](https://www.arduino.cc/en/software).
2. Add ESP32 board support via *Preferences → Additional Board URLs* with `https://dl.espressif.com/dl/package_esp32_index.json`.
3. Install the following libraries from the Library Manager:
   - `Adafruit SSD1306`
   - `Adafruit GFX Library`
   - `TinyGPSPlus`
   - `WebSocketsClient`

### User Block (`user_side/user_side.ino`)

1. Open the sketch in Arduino IDE and select **Board:** ESP32 Dev Module.
2. Update Wi-Fi SSID/password and backend host IP near the top of the file.
3. Upload and open Serial Monitor at 115200 bps.
4. Validate Test Cases 1–5:
   - Maintain presence within 10 m for three seconds (TEST-1 PASS).
   - Shine laser on LDR to pass privilege (TEST-2 PASS).
   - Press button to send ride (TEST-3 PASS) and observe LED/OLED updates (TEST-4/5).
   - Backend communication logs appear as TEST-6 events.

### Rickshaw Unit (`rickshaw_side/rickshaw_side.ino`)

1. Update Wi-Fi credentials and backend host constants.
2. Flash to the ESP32 controlling the rickshaw module.
3. Ensure the GPS antenna has clear sky view; monitor serial output for `TEST-7` events when rides complete.

## Backend Deployment (`backend/server.js`)

1. Install Node.js ≥ 18 and MongoDB (local or cloud).
2. In `backend/`, create `.env` if needed:

   ```
   PORT=4000
   MONGO_URI=mongodb://localhost:27017/aeras_db
   ```

3. Install dependencies and start the server:

   ```bash
   cd backend
   npm install
   node server.js
   ```

4. The Express server exposes REST endpoints and a WebSocket endpoint (`/ws/pullers`).

## Admin Dashboard (`dashboard/`)

1. Requires Node.js; ensure backend is running at `http://localhost:4000`.
2. Install and run:

   ```bash
   cd dashboard
   npm install
   npm run dev
   ```

3. Visit `http://localhost:5173` to monitor live rides, adjust puller status, and review leaderboards.

## Test Coverage

| Test ID | Description | Artefact |
|---------|-------------|----------|
| TEST-1  | Ultrasonic distance detection (≥3 s validation) | Serial logs in user firmware |
| TEST-2  | LDR + laser privilege verification | Serial logs + OLED message |
| TEST-3  | Button debounce + buzzer confirmation | Serial logs + tone feedback |
| TEST-4  | LED state machine (red/yellow/green) | LED behavior + OLED |
| TEST-5  | OLED messaging state coverage | `updateDisplay()` strings |
| TEST-6  | Web integration flows | REST endpoints + WebSocket + serial logs |
| TEST-7  | GPS drop verification & points | Rickshaw firmware + `/completeRide` |

Serial output samples are archived in `docs/test_logs.md`.

## Integration Scenarios

End-to-end scenarios, failure handling (network loss, GPS dropout, simultaneous users), and recovery flows are documented in `docs/integration_tests.md`. These scripts can be replayed manually using the provided firmware and backend logs.

## API Summary

Detailed request/response specs for all REST routes reside in `docs/api_reference.md`. Key endpoints include `/requestRide`, `/acceptRide`, `/rejectRide`, `/updateLocation`, `/completeRide`, `/getPoints`, and `/admin/dashboard`.

## Next Steps & Deployment Tips

- Containerize the backend + MongoDB for production use (Docker Compose example provided in docs).
- Harden authentication with JWT or mutual TLS before public roll-out.
- Extend dashboard with live WebSocket charts by subscribing to a broadcast feed.
- Calibrate the LDR threshold using Serial Monitor (`[DEBUG] LDR:` logs) under real lighting conditions.

## Repository Status

| Component | Status |
|-----------|--------|
| User Hardware Firmware | ✅ Implemented |
| Rickshaw Firmware | ✅ Implemented |
| Backend APIs & Dispatcher | ✅ Implemented |
| Admin Dashboard | ✅ Implemented |
| Documentation & Diagrams | ✅ Implemented (see `docs/`) |

For troubleshooting, consult the serial logs and REST responses captured in the `docs/` folder or run the backend in verbose mode to trace ride state transitions. Contributions and extensions are welcome—please open an issue describing the environment and the scenario you wish to support.


