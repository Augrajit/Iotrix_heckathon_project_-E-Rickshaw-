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
const uint8_t PIN_OLED_SDA = 4;
const uint8_t PIN_OLED_SCL = 15;

// ---------------------- WiFi / Backend -----------------------------
const char *WIFI_SSID = "YOUR_WIFI_SSID";
const char *WIFI_PASS = "YOUR_WIFI_PASSWORD";
const char *BACKEND_WS_HOST = "192.168.0.103";
const uint16_t BACKEND_WS_PORT = 3000;
const char *BACKEND_HTTP_URL = "http://192.168.0.103:3000";
const char *PULLER_ID = "puller-neo-01";

// ---------------------- Timing -------------------------------------
const uint32_t LOCATION_PUSH_INTERVAL_MS = 4000;
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
bool postAcceptRide(const String &rideId);
bool postCompleteRide(const String &rideId, double dropDistance);
double computeDistanceMeters(double lat1, double lon1, double lat2, double lon2);
void logTest(uint8_t testId, const String &status, const String &detail);

WebSocketsClient wsClient;
uint32_t lastGPSFix = 0;

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
  connectWebSocket();

  updateDisplay("Rickshaw Ready", "Awaiting ride...", "");
}

// ---------------------- Loop ---------------------------------------
void loop()
{
  wsClient.loop();

  while (SerialGPS.available())
  {
    if (gps.encode(SerialGPS.read()))
    {
      lastGPSFix = millis();
    }
  }

  if (currentRide.active && millis() - currentRide.lastLocationPush > LOCATION_PUSH_INTERVAL_MS)
  {
    pushLocation();
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
}

void connectWebSocket()
{
  wsClient.begin(BACKEND_WS_HOST, BACKEND_WS_PORT, "/ws/pullers");
  wsClient.onEvent(webSocketEvent);
  wsClient.setReconnectInterval(5000);
  wsClient.enableHeartbeat(15000, 3000, 2);
  Serial.println("[WS] Connecting to backend...");
}

void webSocketEvent(WStype_t type, uint8_t *payload, size_t length)
{
  switch (type)
  {
  case WStype_CONNECTED:
    Serial.println("[WS] Connected to dispatcher.");
    updateDisplay("WS connected", "Awaiting ride...", "");
    wsClient.sendTXT(String("{\"type\":\"REGISTER\",\"pullerId\":\"") + PULLER_ID + "\"}");
    break;

  case WStype_DISCONNECTED:
    Serial.println("[WS] Disconnected. Reconnecting...");
    updateDisplay("Reconnecting", "to dispatcher", "");
    break;

  case WStype_TEXT:
  {
    String msg = String((char *)payload);
    Serial.printf("[WS MESSAGE] %s\n", msg.c_str());
    if (msg.indexOf("ASSIGN_RIDE") >= 0)
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

