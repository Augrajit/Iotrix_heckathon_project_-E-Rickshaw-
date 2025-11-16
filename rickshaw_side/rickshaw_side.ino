#include <Arduino.h>
#include <WiFi.h>
#include <HTTPClient.h>
#include <WebSocketsClient.h>
#include <TinyGPSPlus.h>
#include <Wire.h>
#include <Adafruit_GFX.h>
#include <Adafruit_SSD1306.h>

// ---------------------- Display Configuration ----------------------
#define SCREEN_WIDTH 128
#define SCREEN_HEIGHT 64
#define OLED_RESET -1
Adafruit_SSD1306 display(SCREEN_WIDTH, SCREEN_HEIGHT, &Wire, OLED_RESET);

// ---------------------- Hardware Serial for GPS --------------------
HardwareSerial SerialGPS(1); // UART1 on ESP32
TinyGPSPlus gps;

// ---------------------- Pin Definitions ----------------------------
const uint8_t PIN_OLED_SDA = 22;
const uint8_t PIN_OLED_SCL = 21;

// ---------------------- WiFi / Backend -----------------------------
const char *WIFI_SSID = "TP-Link_6C58";
const char *WIFI_PASS = "Na2co3.10h2o";
const char *BACKEND_WS_HOST = "192.168.0.103";
const uint16_t BACKEND_WS_PORT = 3000;
const char *BACKEND_HTTP_URL = "http://192.168.0.103:4000";
const char *PULLER_ID = "puller-neo-01";

// ---------------------- Timing -------------------------------------
const uint32_t LOCATION_PUSH_INTERVAL_MS = 4000;
const uint32_t IDLE_LOCATION_PUSH_INTERVAL_MS = 10000; // Send location every 10s when idle
const uint32_t GPS_BLANK_TIMEOUT_MS = 8000;

// ---------------------- Ride State ---------------------------------
struct RideContext
{
  String rideId = "";
  String userBlockId = "";
  double pickupLat = 0;
  double pickupLon = 0;
  double dropLat = 0;
  double dropLon = 0;
  bool active = false;
  uint32_t lastLocationPush = 0;
} currentRide;

uint32_t lastIdleLocationPush = 0; // Track location updates when idle

enum class RickshawState
{
  IDLE,
  EN_ROUTE_PICKUP,
  ON_TRIP,
  COMPLETED
};

RickshawState state = RickshawState::IDLE;

// ---------------------- Forward Declarations -----------------------
void connectWiFi();
void connectWebSocket();
void webSocketEvent(WStype_t type, uint8_t *payload, size_t length);
void updateDisplay(const String &l1, const String &l2 = "", const String &l3 = "");
void pushLocation();
void pushIdleLocation(); // Send location when idle
bool postAcceptRide(const String &rideId);
bool postCompleteRide(const String &rideId, double dropDistance);
double computeDistanceMeters(double lat1, double lon1, double lat2, double lon2);
void logTest(uint8_t testId, const String &status, const String &detail);

WebSocketsClient wsClient;
uint32_t lastGPSFix = 0;
bool backendReachable = false;
uint32_t lastBackendCheck = 0;
const uint32_t BACKEND_CHECK_INTERVAL_MS = 30000; // Check backend every 30 seconds
const uint32_t WS_RECONNECT_DELAY_MS = 10000; // Wait 10 seconds before retrying WebSocket
uint32_t lastWSReconnectAttempt = 0;

// ---------------------- Setup --------------------------------------
void setup()
{
  Serial.begin(115200);
  Serial.println("\n[AERAS Rickshaw] Boot sequence...");

  Wire.begin(PIN_OLED_SDA, PIN_OLED_SCL);
  if (!display.begin(SSD1306_SWITCHCAPVCC, 0x3C))
  {
    Serial.println("[ERROR] OLED init failed.");
    while (true)
    {
      delay(1000);
    }
  }
  updateDisplay("Rickshaw Unit", "Booting...", "");

  SerialGPS.begin(9600, SERIAL_8N1, 16, 17); // GPS pins
  connectWiFi();
  
  // Only connect WebSocket if backend is reachable
  if (backendReachable) {
    connectWebSocket();
    updateDisplay("Rickshaw Ready", "Awaiting ride...", "");
  } else {
    updateDisplay("Backend offline", "Check server IP", "Retrying...");
  }
}

// ---------------------- Loop ---------------------------------------
void loop()
{
  // Periodically check if backend becomes available
  if (!backendReachable && (millis() - lastBackendCheck > BACKEND_CHECK_INTERVAL_MS)) {
    Serial.println("[NET] Retrying backend connection...");
    HTTPClient http;
    http.begin(String(BACKEND_HTTP_URL) + "/");
    http.setTimeout(5000);
    int httpCode = http.GET();
    http.end();
    
    if (httpCode > 0) {
      Serial.printf("[✓] Backend is now reachable! HTTP Code: %d\n", httpCode);
      backendReachable = true;
      updateDisplay("Backend online", "Connecting...", "");
      connectWebSocket();
    } else {
      Serial.println("[✗] Backend still not reachable. Will retry in 30s...");
      lastBackendCheck = millis();
    }
  }
  
  // Only run WebSocket loop if backend is reachable
  if (backendReachable) {
    wsClient.loop();
  }

  while (SerialGPS.available())
  {
    if (gps.encode(SerialGPS.read()))
    {
      lastGPSFix = millis();
    }
  }

  // Send location updates when on a ride
  if (currentRide.active && millis() - currentRide.lastLocationPush > LOCATION_PUSH_INTERVAL_MS)
  {
    pushLocation();
  }
  
  // Send location updates when idle (for proximity-based assignment)
  if (!currentRide.active && gps.location.isValid() && 
      millis() - lastIdleLocationPush > IDLE_LOCATION_PUSH_INTERVAL_MS)
  {
    pushIdleLocation();
    lastIdleLocationPush = millis();
  }

  if (currentRide.active)
  {
    // Check completion proximity
    if (gps.location.isValid())
    {
      double distanceToDrop = computeDistanceMeters(gps.location.lat(), gps.location.lng(), currentRide.dropLat, currentRide.dropLon);
      if (state == RickshawState::ON_TRIP && distanceToDrop <= 50.0)
      {
        double rewardDistance = computeDistanceMeters(currentRide.pickupLat, currentRide.pickupLon, gps.location.lat(), gps.location.lng());
        double points = max(0.0, 10.0 - (distanceToDrop / 10.0));
        Serial.printf("[POINTS] Distance from block: %.2f m -> %.2f pts\n", distanceToDrop, points);
        if (postCompleteRide(currentRide.rideId, distanceToDrop))
        {
          logTest(7, "PASS", "Ride completion + points update success.");
          updateDisplay("Ride complete", "Points: " + String(points, 1), "");
          currentRide.active = false;
          state = RickshawState::COMPLETED;
        }
        else
        {
          logTest(7, "FAIL", "Failed to POST /completeRide");
        }
      }
    }
    else if (millis() - lastGPSFix > GPS_BLANK_TIMEOUT_MS)
    {
      Serial.println("[WARN] GPS fix lost.");
      logTest(7, "RUN", "GPS fix missing, attempting reacquire.");
      updateDisplay("GPS signal", "lost... hold", "open sky");
    }
  }
}

// ---------------------- WiFi & WebSocket ---------------------------
void connectWiFi()
{
  WiFi.mode(WIFI_STA);
  WiFi.begin(WIFI_SSID, WIFI_PASS);
  Serial.printf("[NET] Connecting to %s", WIFI_SSID);
  int attempts = 0;
  while (WiFi.status() != WL_CONNECTED)
  {
    delay(500);
    Serial.print(".");
    attempts++;
    if (attempts > 40)
    {
      updateDisplay("WiFi failed", "Rebooting...", "");
      ESP.restart();
    }
  }
  Serial.printf("\n[NET] Connected. IP=%s\n", WiFi.localIP().toString().c_str());
  logTest(6, "PASS", "Rickshaw connected to WiFi.");
  
  // Test backend connection
  Serial.println("[NET] Testing backend connection...");
  HTTPClient http;
  http.begin(String(BACKEND_HTTP_URL) + "/");
  http.setTimeout(5000);
  int httpCode = http.GET();
  http.end();
  
  if (httpCode > 0) {
    Serial.printf("[✓] Backend reachable! HTTP Code: %d\n", httpCode);
    logTest(6, "PASS", "Backend server accessible");
    backendReachable = true;
  } else {
    Serial.printf("[✗] Backend not reachable!\n");
    Serial.printf("[ERROR] Cannot connect to %s\n", BACKEND_HTTP_URL);
    Serial.println("[INFO] Check if backend is running and IP address is correct");
    Serial.printf("[INFO] Backend should be at: %s (HTTP) and %s:%d (WebSocket)\n", 
                  BACKEND_HTTP_URL, BACKEND_WS_HOST, BACKEND_WS_PORT);
    Serial.println("[INFO] Will retry connection periodically...");
    logTest(6, "FAIL", "Backend server not accessible");
    backendReachable = false;
  }
  lastBackendCheck = millis();
}

void connectWebSocket()
{
  if (!backendReachable) {
    Serial.println("[WS] Skipping WebSocket connection - backend not reachable");
    updateDisplay("Backend offline", "Retrying...", "");
    return;
  }
  
  // WebSocket path doesn't matter - server accepts all connections
  wsClient.begin(BACKEND_WS_HOST, BACKEND_WS_PORT, "/");
  wsClient.onEvent(webSocketEvent);
  wsClient.setReconnectInterval(10000); // Increased to 10 seconds
  wsClient.enableHeartbeat(15000, 3000, 2);
  Serial.println("[WS] Connecting to backend...");
  lastWSReconnectAttempt = millis();
}

void webSocketEvent(WStype_t type, uint8_t *payload, size_t length)
{
  switch (type)
  {
  case WStype_CONNECTED:
  {
    Serial.println("[WS] Connected to dispatcher.");
    updateDisplay("WS connected", "Awaiting ride...", "");
    // Register immediately upon connection
    String registerMsg = String("{\"type\":\"REGISTER\",\"pullerId\":\"") + PULLER_ID + "\"}";
    wsClient.sendTXT(registerMsg);
    Serial.printf("[WS] Sent registration: %s\n", registerMsg.c_str());
    break;
  }

  case WStype_DISCONNECTED:
  {
    uint32_t timeSinceLastAttempt = millis() - lastWSReconnectAttempt;
    if (timeSinceLastAttempt > WS_RECONNECT_DELAY_MS) {
      Serial.println("[WS] Disconnected. Will retry connection...");
      updateDisplay("WS disconnected", "Retrying...", "");
      lastWSReconnectAttempt = millis();
      // Only reconnect if backend is still reachable
      if (backendReachable) {
        // The WebSocket library will automatically reconnect due to setReconnectInterval
      } else {
        Serial.println("[WS] Backend not reachable - stopping reconnection attempts");
        updateDisplay("Backend offline", "Check server", "");
      }
    }
    break;
  }
  
  case WStype_ERROR:
    if (payload && length > 0) {
      Serial.printf("[WS] Error: %.*s\n", length, payload);
    } else {
      Serial.println("[WS] Error: Unknown error");
    }
    break;

  case WStype_TEXT:
  {
    String msg = String((char *)payload);
    Serial.printf("[WS MESSAGE] %s\n", msg.c_str());
    
    // Handle REGISTERED confirmation
    if (msg.indexOf("REGISTERED") >= 0)
    {
      Serial.println("[WS] Registration confirmed by backend.");
      logTest(6, "PASS", "WebSocket registration successful.");
    }
    else if (msg.indexOf("ASSIGN_RIDE") >= 0)
    {
      logTest(6, "PASS", "Ride assignment received via WS.");
      // naive parsing (JSON string). For robustness, parse properly.
      int idStart = msg.indexOf("\"rideId\":\"") + 10;
      int idEnd = msg.indexOf("\"", idStart);
      currentRide.rideId = msg.substring(idStart, idEnd);

      int pickupLatStart = msg.indexOf("\"pickupLat\":") + 12;
      int pickupLatEnd = msg.indexOf(",", pickupLatStart);
      currentRide.pickupLat = msg.substring(pickupLatStart, pickupLatEnd).toDouble();

      int pickupLonStart = msg.indexOf("\"pickupLon\":") + 12;
      int pickupLonEnd = msg.indexOf(",", pickupLonStart);
      currentRide.pickupLon = msg.substring(pickupLonStart, pickupLonEnd).toDouble();

      int dropLatStart = msg.indexOf("\"dropLat\":") + 10;
      int dropLatEnd = msg.indexOf(",", dropLatStart);
      currentRide.dropLat = msg.substring(dropLatStart, dropLatEnd).toDouble();

      int dropLonStart = msg.indexOf("\"dropLon\":") + 10;
      int dropLonEnd = msg.indexOf(",", dropLonStart);
      currentRide.dropLon = msg.substring(dropLonStart, dropLonEnd).toDouble();

      currentRide.active = true;
      state = RickshawState::EN_ROUTE_PICKUP;

      updateDisplay("Ride assigned", "ID: " + currentRide.rideId, "Accepting...");
      if (postAcceptRide(currentRide.rideId))
      {
        logTest(6, "PASS", "Accept ride POST success.");
        updateDisplay("Heading pickup", "Ride: " + currentRide.rideId, "");
      }
      else
      {
        logTest(6, "FAIL", "Failed to POST /acceptRide");
      }
    }
    else if (msg.indexOf("CANCEL_RIDE") >= 0)
    {
      logTest(6, "FAIL", "Ride cancelled by backend.");
      updateDisplay("Ride cancelled", "", "");
      currentRide.active = false;
      state = RickshawState::IDLE;
    }
    break;
  }

  default:
    break;
  }
}

// ---------------------- HTTP Helpers -------------------------------
void pushLocation()
{
  if (!gps.location.isValid())
  {
    Serial.println("[GPS] Waiting for valid fix...");
    return;
  }

  HTTPClient http;
  String url = String(BACKEND_HTTP_URL) + "/updateLocation";
  http.begin(url);
  http.addHeader("Content-Type", "application/json");

  String payload = String("{\"pullerId\":\"") + PULLER_ID + "\","
                    "\"latitude\":" + String(gps.location.lat(), 6) + ","
                    "\"longitude\":" + String(gps.location.lng(), 6) + ","
                    "\"rideId\":\"" + currentRide.rideId + "\"}";

  int code = http.POST(payload);
  if (code > 0)
  {
    Serial.printf("[HTTP %d] updateLocation\n", code);
    if (code == 200)
    {
      logTest(7, "RUN", "Location push ok.");
    }
  }
  else
  {
    Serial.printf("[HTTP ERR] %s\n", http.errorToString(code).c_str());
    logTest(7, "FAIL", "updateLocation failed.");
  }
  http.end();
  currentRide.lastLocationPush = millis();
}

void pushIdleLocation()
{
  if (!gps.location.isValid())
  {
    return; // Silently skip if no GPS fix
  }

  HTTPClient http;
  String url = String(BACKEND_HTTP_URL) + "/updateLocation";
  http.begin(url);
  http.addHeader("Content-Type", "application/json");

  // Send location without rideId when idle
  String payload = String("{\"pullerId\":\"") + PULLER_ID + "\","
                    "\"latitude\":" + String(gps.location.lat(), 6) + ","
                    "\"longitude\":" + String(gps.location.lng(), 6) + "}";

  int code = http.POST(payload);
  if (code == 200)
  {
    Serial.printf("[HTTP %d] Idle location update\n", code);
  }
  http.end();
}

bool postAcceptRide(const String &rideId)
{
  HTTPClient http;
  http.begin(String(BACKEND_HTTP_URL) + "/acceptRide");
  http.addHeader("Content-Type", "application/json");
  String payload = String("{\"rideId\":\"") + rideId + "\",\"pullerId\":\"" + PULLER_ID + "\"}";
  int code = http.POST(payload);
  if (code == 200)
  {
    state = RickshawState::ON_TRIP;
    http.end();
    return true;
  }
  Serial.printf("[HTTP %d] acceptRide\n", code);
  http.end();
  return false;
}

bool postCompleteRide(const String &rideId, double dropDistance)
{
  HTTPClient http;
  http.begin(String(BACKEND_HTTP_URL) + "/completeRide");
  http.addHeader("Content-Type", "application/json");
  double points = max(0.0, 10.0 - (dropDistance / 10.0));
  String payload = String("{\"rideId\":\"") + rideId + "\",\"pullerId\":\"" + PULLER_ID + "\","
                    "\"dropDistance\":" + String(dropDistance, 2) + ","
                    "\"points\":" + String(points, 2) + "}";
  int code = http.POST(payload);
  if (code == 200)
  {
    http.end();
    return true;
  }
  Serial.printf("[HTTP %d] completeRide\n", code);
  http.end();
  return false;
}

// ---------------------- Utilities ---------------------------------
double computeDistanceMeters(double lat1, double lon1, double lat2, double lon2)
{
  double radLat1 = radians(lat1);
  double radLat2 = radians(lat2);
  double deltaLat = radians(lat2 - lat1);
  double deltaLon = radians(lon2 - lon1);
  double a = sin(deltaLat / 2) * sin(deltaLat / 2) +
             cos(radLat1) * cos(radLat2) * sin(deltaLon / 2) * sin(deltaLon / 2);
  double c = 2 * atan2(sqrt(a), sqrt(1 - a));
  return 6371000.0 * c;
}

void updateDisplay(const String &l1, const String &l2, const String &l3)
{
  display.clearDisplay();
  display.setTextSize(1);
  display.setTextColor(SSD1306_WHITE);
  display.setCursor(0, 0);
  display.println(l1);
  display.setCursor(0, 16);
  display.println(l2);
  display.setCursor(0, 32);
  display.println(l3);
  display.display();
}

void logTest(uint8_t testId, const String &status, const String &detail)
{
  Serial.printf("[TEST-%u][%s] %s\n", testId, status.c_str(), detail.c_str());
}

