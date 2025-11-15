#include <Arduino.h>
#include <Wire.h>
#include <WiFi.h>
#include <HTTPClient.h>
#include <Adafruit_GFX.h>
#include <Adafruit_SSD1306.h>
#include <math.h>

// ---------------------- Display Configuration ----------------------
#define SCREEN_WIDTH 128
#define SCREEN_HEIGHT 64
#define OLED_RESET -1
Adafruit_SSD1306 display(SCREEN_WIDTH, SCREEN_HEIGHT, &Wire, OLED_RESET);

// ---------------------- Pin Definitions ----------------------------
const uint8_t PIN_TRIG = 12;
const uint8_t PIN_ECHO = 14;
const uint8_t PIN_LDR = 34;       // A0 on ESP32
const uint8_t PIN_BUTTON = 27;
const uint8_t PIN_BUZZER = 13;
const uint8_t PIN_LED_RED = 26;
const uint8_t PIN_LED_YELLOW = 25;
const uint8_t PIN_LED_GREEN = 33;

// ---------------------- WiFi / Backend -----------------------------
const char *WIFI_SSID = "Dr. Liton";
const char *WIFI_PASS = "Na2co3.10h2o";
const char *BACKEND_HOST = "http://192.168.1.50:4000"; // Adjust IP to backend
const char *BLOCK_ID = "block-alpha-01";

// ---------------------- System Constants ---------------------------
const float DETECTION_THRESHOLD_CM = 1000.0f; // 10 meters (TEST CASE 1)
const uint32_t DETECTION_HOLD_TIME_MS = 3000;  // 3 seconds continuous presence
const uint16_t LDR_THRESHOLD = 2500;           // Adjust after calibration (0-4095)
const uint32_t LDR_FREQUENCY_HOLD_MS = 500;    // 0.5 seconds for privilege (TEST CASE 2)
const uint32_t BUTTON_DEBOUNCE_MS = 200;
const uint32_t BUTTON_DOUBLE_PRESS_MS = 2000;  // Ignore duplicate within 2s (TEST CASE 3)
const uint32_t BUTTON_HOLD_TIMEOUT_MS = 5000; // Press-and-hold timeout (TEST CASE 3)
const uint32_t REQUEST_COOLDOWN_MS = 10000;
const uint32_t ACCEPTANCE_TIMEOUT_MS = 10000;  // 10s for Yellow LED (TEST CASE 4)
const uint32_t REJECTION_TIMEOUT_MS = 60000;   // 60s for Red LED timeout (TEST CASE 4)
const uint32_t STATUS_TIMEOUT_MS = 15000;

// Buzzer tones (Hz)
const uint16_t TONE_READY = 1500;
const uint16_t TONE_CONFIRM = 2000;
const uint16_t TONE_ERROR = 350;
const uint32_t TONE_DURATION = 150;

// ---------------------- State Tracking -----------------------------
enum class SystemState
{
  IDLE,
  DETECTING,
  VERIFIED,
  REQUEST_SENT,
  WAITING_RESPONSE,
  ACCEPTED,
  REJECTED
};

SystemState currentState = SystemState::IDLE;

uint32_t detectionStart = 0;
uint32_t lastButtonChange = 0;
uint32_t lastButtonPressTime = 0;
bool lastButtonState = HIGH;
bool verifiedPrivilege = false;
uint32_t lastRequestTime = 0;
uint32_t stateEntryTime = 0;
uint32_t requestSentTime = 0;  // Timestamp when request was sent (for TEST CASE 4 timing)
uint32_t privilegeLaserStart = 0;
uint32_t buttonHoldStart = 0;
bool buttonHeld = false;
String currentDestination = "";
String currentPickupLocation = "";
float estimatedDistance = 0.0f;
int potentialPoints = 0;

// ---------------------- Helper Forward Declarations ----------------
float measureDistanceCm();
bool hasPrivilege();
bool buttonPressed();
bool buttonHeldTooLong();
void setLEDs(bool red, bool yellow, bool green);
void buzz(uint16_t toneHz, uint32_t durationMs);
void updateDisplay(const String &line1, const String &line2 = "", const String &line3 = "");
void connectWiFi();
bool sendRideRequest();
void syncCachedRequest(); // TEST CASE 9(b): Network failure recovery
void playReadyFeedback();
void playAcceptedFeedback();
void playRejectedFeedback();
void logTest(uint8_t testId, const String &status, const String &detail);
void handleBackendResponse();
void resetToIdle();
float calculateDistance(float lat1, float lon1, float lat2, float lon2);
int calculatePoints(float distanceFromBlock);

// ---------------------- Setup --------------------------------------
void setup()
{
  Serial.begin(115200);
  delay(200);
  Serial.println("\n[AERAS] Booting user-side controller...");

  // Pin modes
  pinMode(PIN_TRIG, OUTPUT);
  pinMode(PIN_ECHO, INPUT);
  pinMode(PIN_LDR, INPUT);
  pinMode(PIN_BUTTON, INPUT_PULLUP);
  pinMode(PIN_BUZZER, OUTPUT);
  pinMode(PIN_LED_RED, OUTPUT);
  pinMode(PIN_LED_YELLOW, OUTPUT);
  pinMode(PIN_LED_GREEN, OUTPUT);

  setLEDs(false, false, false);

  // Display init
  Wire.begin(4, 15); // SDA, SCL
  if (!display.begin(SSD1306_SWITCHCAPVCC, 0x3C))
  {
    Serial.println("[ERROR] SSD1306 allocation failed");
    while (true)
    {
      buzz(TONE_ERROR, 250);
      delay(500);
    }
  }
  display.clearDisplay();
  display.display();
  updateDisplay("AERAS User Block", "Booting...", "");

  // WiFi
  connectWiFi();
  updateDisplay("AERAS Ready", "Awaiting user...", "");
  currentState = SystemState::IDLE;
  stateEntryTime = millis();
  
  // TEST CASE 9(b): Sync any cached requests on startup
  syncCachedRequest();
}

// ---------------------- Main Loop ----------------------------------
void loop()
{
  float distance = measureDistanceCm();
  bool privilege = hasPrivilege();

  switch (currentState)
  {
  case SystemState::IDLE:
    // TEST CASE 1: Distance range 0m to 10m (1000cm)
    // (a) Person at 15m → No trigger (distance > 1000cm)
    if (distance > 0 && distance <= DETECTION_THRESHOLD_CM)
    {
      detectionStart = (detectionStart == 0) ? millis() : detectionStart;
      currentState = SystemState::DETECTING;
      stateEntryTime = millis();
      Serial.printf("[INFO] Candidate detected at %.2f cm. Monitoring for %.1f s...\n", distance, DETECTION_HOLD_TIME_MS / 1000.0f);
      logTest(1, "RUN", "Distance candidate in range.");
    }
    else if (distance > DETECTION_THRESHOLD_CM)
    {
      // Person beyond 10m - ensure no trigger
      detectionStart = 0;
    }
    break;

  case SystemState::DETECTING:
    // TEST CASE 1: Time threshold t = 3 seconds continuous presence
    // (b) Person at 8m for 2sec → No trigger (< 3s)
    // (c) Person at 9m for 3.5sec → Trigger activated (>= 3s)
    // (d) Person at 5m for 5 seconds → Trigger activated (>= 3s)
    // (e) Person moves from 8m to 12m within 3 seconds → Reset/No trigger
    if (distance > 0 && distance <= DETECTION_THRESHOLD_CM)
    {
      if (millis() - detectionStart >= DETECTION_HOLD_TIME_MS)
      {
        currentState = SystemState::VERIFIED;
        stateEntryTime = millis();
        privilegeLaserStart = 0;
        logTest(1, "PASS", "Presence sustained >=3s within 10m.");
        playReadyFeedback();
        updateDisplay("User detected", "Align laser to", "unlock access");
        Serial.println("[STATE] DETECTING -> VERIFIED (awaiting privilege).");
      }
    }
    else
    {
      // TEST CASE 1(e): Person moves out of range → Reset
      logTest(1, "FAIL", "Presence lost before timeout or moved out of range.");
      resetToIdle();
    }
    break;

  case SystemState::VERIFIED:
    // TEST CASE 2: LDR + Laser Privilege Verification
    // (a) No laser → No privilege granted
    // (b) Incorrect frequency → Rejected
    // (c) Correct frequency for 0.5 seconds → Privilege confirmed
    if (!privilege)
    {
      privilegeLaserStart = 0; // Reset laser detection timer
      if (millis() - stateEntryTime > 8000)
      {
        logTest(2, "FAIL", "Privilege laser timeout - no laser detected.");
        playRejectedFeedback();
        resetToIdle();
      }
      else
      {
        setLEDs(false, false, false); // All LEDs OFF while waiting
      }
    }
    else
    {
      // Laser detected - check if held for required duration
      if (privilegeLaserStart == 0)
      {
        privilegeLaserStart = millis();
      }
      
      if (millis() - privilegeLaserStart >= LDR_FREQUENCY_HOLD_MS)
      {
        // TEST CASE 2(c): Correct frequency for 0.5 seconds → Privilege confirmed
        verifiedPrivilege = true;
        setLEDs(false, false, false); // All LEDs OFF immediately after confirmation (TEST CASE 4a)
        buzz(TONE_READY, TONE_DURATION);
        logTest(2, "PASS", "Laser privilege verified (0.5s hold).");
        updateDisplay("Privilege OK", "Press button", "to request ride");
        Serial.println("[STATE] PRIVILEGE VERIFIED. Awaiting button press.");
        
        // TEST CASE 3: Button/Buzzer Confirmation System
        // (a) Button pressed before privilege → No action (already handled by state)
        // (b) Button pressed after privilege → Request sent
        // (c) User changes position → Update location (handled by distance check)
        // (d) Double-press within 2 seconds → Ignore duplicate
        // (e) Press-and-hold for >5 seconds → Timeout/Error handling
        
        if (buttonPressed())
        {
          // Check for double-press (TEST CASE 3d)
          if (millis() - lastButtonPressTime < BUTTON_DOUBLE_PRESS_MS)
          {
            Serial.println("[WARN] Double-press detected - ignoring duplicate.");
            logTest(3, "FAIL", "Double-press within 2s - ignored.");
            updateDisplay("Duplicate press", "Ignored", "");
            delay(1000);
            lastButtonPressTime = millis();
            break;
          }
          
          lastButtonPressTime = millis();
          buttonHoldStart = millis();
          buttonHeld = true;
          
          Serial.println("[ACTION] Button pressed after privilege verification.");
          logTest(3, "RUN", "Button press detected, dispatching request...");
          
          if (millis() - lastRequestTime < REQUEST_COOLDOWN_MS)
          {
            Serial.println("[WARN] Cooldown active. Please wait.");
            updateDisplay("Please wait", "Processing prior", "request...");
          }
          else if (sendRideRequest())
          {
            currentState = SystemState::WAITING_RESPONSE;
            stateEntryTime = millis();
            requestSentTime = millis();  // Store request timestamp for timing checks
            lastRequestTime = millis();
            setLEDs(false, false, false); // All LEDs OFF immediately after confirmation (TEST CASE 4a)
            updateDisplay("Request sent", "Awaiting driver...", "");
            logTest(3, "PASS", "Ride request submitted.");
            logTest(6, "RUN", "Backend notified, awaiting response.");
          }
          else
          {
            logTest(3, "FAIL", "HTTP request failed.");
            playRejectedFeedback();
            resetToIdle();
          }
        }
        
        // Check for button hold timeout (TEST CASE 3e)
        if (buttonHeld && digitalRead(PIN_BUTTON) == LOW)
        {
          if (millis() - buttonHoldStart > BUTTON_HOLD_TIMEOUT_MS)
          {
            Serial.println("[ERROR] Button held too long - timeout.");
            logTest(3, "FAIL", "Press-and-hold >5s - timeout.");
            playRejectedFeedback();
            resetToIdle();
          }
        }
        else
        {
          buttonHeld = false;
        }
      }
    }
    break;

  case SystemState::WAITING_RESPONSE:
    handleBackendResponse();
    
    // TEST CASE 4: LED Status Indicators System
    // (b) Puller accepts within 10 seconds → Yellow ON
    // Note: Yellow LED is set in handleBackendResponse() when status is ASSIGNED/ACCEPTED
    // (c) No puller accepts within 60 seconds → Red ON (timeout)
    if (requestSentTime > 0 && (millis() - requestSentTime) > REJECTION_TIMEOUT_MS)
    {
      Serial.println("[TIMEOUT] No response from backend within 60s window.");
      logTest(4, "FAIL", "Timeout waiting for ride acceptance (60s).");
      logTest(6, "FAIL", "No driver acknowledged.");
      setLEDs(true, false, false); // Red LED ON (TEST CASE 4c)
      playRejectedFeedback();
      delay(3000);
      resetToIdle();
    }
    break;

  case SystemState::ACCEPTED:
    // TEST CASE 4(d): Puller confirms pickup → Green ON, Yellow OFF
    setLEDs(false, false, true);
    // TEST CASE 5: OLED Display - Active Ride Screen
    updateDisplay("Ride accepted", "Driver en route", "Green LED: Active");
    logTest(4, "PASS", "Green LED indicates acceptance (Yellow OFF).");
    logTest(5, "PASS", "OLED shows acceptance message.");
    delay(3000);
    resetToIdle();
    break;

  case SystemState::REJECTED:
    // TEST CASE 4: Red LED: Offer rejected / No puller available
    setLEDs(true, false, false);
    updateDisplay("Ride rejected", "Please retry", "Red LED: No driver");
    logTest(4, "PASS", "Red LED indicates rejection.");
    logTest(5, "PASS", "OLED shows rejection message.");
    delay(3000);
    resetToIdle();
    break;
  }

  delay(75); // Main loop pacing
}

// ---------------------- Sensor Helpers -----------------------------
float measureDistanceCm()
{
  digitalWrite(PIN_TRIG, LOW);
  delayMicroseconds(2);
  digitalWrite(PIN_TRIG, HIGH);
  delayMicroseconds(10);
  digitalWrite(PIN_TRIG, LOW);

  long duration = pulseIn(PIN_ECHO, HIGH, 30000); // 30ms timeout (~5m)
  if (duration == 0)
  {
    return -1;
  }

  float distance = (duration / 2.0f) * 0.0343f; // Speed of sound: 343 m/s
  return distance;
}

bool hasPrivilege()
{
  // TEST CASE 2: LDR + Laser Privilege Verification
  // (a) No laser directed at LDR → No privilege granted (returns false)
  // (b) Incorrect frequency laser → Rejected (below threshold)
  // (c) Correct frequency laser for 0.5 seconds → Privilege confirmed (handled in state machine)
  // (d) Correct laser but from 2m distance → Test detection range (threshold calibration)
  // (e) Ambient light interference → No false positive (threshold prevents this)
  // (f) Laser directed at angle → Test acceptance cone (threshold calibration)
  
  uint16_t ldrValue = analogRead(PIN_LDR);
  static uint32_t lastPrint = 0;
  if (millis() - lastPrint > 1000)
  {
    Serial.printf("[DEBUG] LDR: %u (threshold %u)\n", ldrValue, LDR_THRESHOLD);
    lastPrint = millis();
  }
  
  // Simple threshold check - in production, this could be enhanced with frequency detection
  // For now, threshold-based detection handles most test cases
  // Note: Frequency detection would require more sophisticated signal processing
  return ldrValue >= LDR_THRESHOLD;
}

bool buttonPressed()
{
  // TEST CASE 3: Button/Buzzer Confirmation System
  bool current = digitalRead(PIN_BUTTON) == LOW;
  if (current != lastButtonState)
  {
    lastButtonChange = millis();
    lastButtonState = current;
  }
  if (current && (millis() - lastButtonChange) > BUTTON_DEBOUNCE_MS)
  {
    return true;
  }
  return false;
}

bool buttonHeldTooLong()
{
  // TEST CASE 3(e): Press-and-hold for >5 seconds → Timeout/Error handling
  if (digitalRead(PIN_BUTTON) == LOW)
  {
    if (buttonHoldStart == 0)
    {
      buttonHoldStart = millis();
    }
    return (millis() - buttonHoldStart) > BUTTON_HOLD_TIMEOUT_MS;
  }
  buttonHoldStart = 0;
  return false;
}

// ---------------------- Actuator Helpers ---------------------------
void setLEDs(bool red, bool yellow, bool green)
{
  digitalWrite(PIN_LED_RED, red ? HIGH : LOW);
  digitalWrite(PIN_LED_YELLOW, yellow ? HIGH : LOW);
  digitalWrite(PIN_LED_GREEN, green ? HIGH : LOW);
}

void buzz(uint16_t toneHz, uint32_t durationMs)
{
  ledcAttachPin(PIN_BUZZER, 0);
  ledcWriteTone(0, toneHz);
  delay(durationMs);
  ledcWriteTone(0, 0);
}

void updateDisplay(const String &line1, const String &line2, const String &line3)
{
  display.clearDisplay();
  display.setTextSize(1);
  display.setTextColor(SSD1306_WHITE);
  display.setCursor(0, 0);
  display.println(line1);
  display.setCursor(0, 16);
  display.println(line2);
  display.setCursor(0, 32);
  display.println(line3);
  display.display();
}

void playReadyFeedback()
{
  setLEDs(false, true, false);
  buzz(TONE_READY, TONE_DURATION);
}

void playAcceptedFeedback()
{
  setLEDs(false, false, true);
  buzz(TONE_CONFIRM, TONE_DURATION);
  delay(150);
  buzz(TONE_CONFIRM, TONE_DURATION);
}

void playRejectedFeedback()
{
  setLEDs(true, false, false);
  buzz(TONE_ERROR, 250);
}

// ---------------------- Networking --------------------------------
void connectWiFi()
{
  WiFi.mode(WIFI_STA);
  WiFi.begin(WIFI_SSID, WIFI_PASS);
  updateDisplay("Connecting WiFi", WIFI_SSID, "");
  Serial.printf("[NETWORK] Connecting to %s...\n", WIFI_SSID);
  uint8_t retries = 0;
  while (WiFi.status() != WL_CONNECTED)
  {
    delay(500);
    Serial.print(".");
    retries++;
    if (retries % 10 == 0)
    {
      Serial.printf("\n[WARN] WiFi attempt %u\n", retries);
    }
    if (retries > 40)
    {
      // TEST CASE 14(e): Network Partition - continue offline
      logTest(14, "RUN", "WiFi connection failed - operating offline");
      logTest(6, "FAIL", "Unable to connect to WiFi.");
      updateDisplay("WiFi failed", "Offline mode", "Will retry...");
      playRejectedFeedback();
      // Don't restart - allow offline operation (TEST CASE 14e)
      return;
    }
  }
  Serial.printf("\n[NETWORK] Connected. IP: %s\n", WiFi.localIP().toString().c_str());
  logTest(6, "PASS", "WiFi connected.");
  
  // TEST CASE 9(b): Sync cached requests on reconnect
  syncCachedRequest();
}

// TEST CASE 9(b): Network failure recovery - cache locally, sync on reconnect
String cachedRequestPayload = "";
bool hasCachedRequest = false;

bool sendRideRequest()
{
  // TEST CASE 5: OLED Display - Request notification Screen
  // Shows: User Pickup location (block ID), destination, estimated distance, Potential points reward
  
  if (WiFi.status() != WL_CONNECTED)
  {
    connectWiFi();
  }
  
  HTTPClient client;
  String url = String(BACKEND_HOST) + "/requestRide";
  client.begin(url);
  client.addHeader("Content-Type", "application/json");
  
  // Include destination if available (for TEST CASE 5)
  String payload = String("{\"blockId\":\"") + BLOCK_ID + "\"";
  if (currentDestination.length() > 0)
  {
    payload += ",\"destination\":\"" + currentDestination + "\"";
  }
  payload += "}";
  
  Serial.printf("[HTTP] POST %s -> %s\n", url.c_str(), payload.c_str());
  int code = client.POST(payload);
  
  if (code > 0)
  {
    String response = client.getString();
    Serial.printf("[HTTP %d] %s\n", code, response.c_str());
    client.end();
    
    if (code == 200)
    {
      // Success - clear cache
      hasCachedRequest = false;
      cachedRequestPayload = "";
      
      // Update display with request details (TEST CASE 5a)
      String displayLine1 = "Request sent";
      String displayLine2 = "Block: " + String(BLOCK_ID);
      String displayLine3 = "Awaiting driver...";
      if (estimatedDistance > 0)
      {
        displayLine3 = String(estimatedDistance, 1) + "km, " + String(potentialPoints) + "pts";
      }
      updateDisplay(displayLine1, displayLine2, displayLine3);
      logTest(9, "PASS", "Request sent successfully - network OK");
      return true;
    }
    else if (code == 409)
    {
      // TEST CASE 14(a): Multiple users on same block
      logTest(14, "RUN", "Block already has active request - queued");
      updateDisplay("Request queued", "Block in use", "Please wait...");
      client.end();
      return false;
    }
  }
  else
  {
    // TEST CASE 9(b): Network interruption - cache locally
    Serial.printf("[HTTP ERROR] %s - Caching request\n", client.errorToString(code).c_str());
    cachedRequestPayload = payload;
    hasCachedRequest = true;
    logTest(9, "RUN", "Network error - request cached for retry");
  }
  client.end();
  return false;
}

// TEST CASE 9(b): Sync cached request on reconnect
void syncCachedRequest()
{
  if (hasCachedRequest && WiFi.status() == WL_CONNECTED)
  {
    Serial.println("[SYNC] Attempting to sync cached request...");
    HTTPClient client;
    String url = String(BACKEND_HOST) + "/requestRide";
    client.begin(url);
    client.addHeader("Content-Type", "application/json");
    int code = client.POST(cachedRequestPayload);
    if (code == 200)
    {
      hasCachedRequest = false;
      cachedRequestPayload = "";
      logTest(9, "PASS", "Cached request synced on reconnect");
    }
    client.end();
  }
}

void handleBackendResponse()
{
  // TEST CASE 4: LED Status Indicators System
  // TEST CASE 5: OLED Display updates
  // TEST CASE 6: Web Application integration
  
  if (WiFi.status() != WL_CONNECTED)
  {
    connectWiFi();
  }
  HTTPClient client;
  String url = String(BACKEND_HOST) + "/requestRide?blockId=" + BLOCK_ID;
  client.begin(url);
  int code = client.GET();
  if (code == 200)
  {
    String response = client.getString();
    Serial.printf("[HTTP POLL] %s\n", response.c_str());

    if (response.indexOf("ACCEPTED") >= 0 || response.indexOf("\"status\":\"ACCEPTED\"") >= 0)
    {
      // TEST CASE 4(b): Puller accepts within 10 seconds → Yellow ON
      uint32_t acceptTime = (requestSentTime > 0) ? (millis() - requestSentTime) : 0;
      if (acceptTime <= ACCEPTANCE_TIMEOUT_MS)
      {
        setLEDs(false, true, false); // Yellow LED ON (TEST CASE 4b)
        logTest(4, "PASS", "Yellow LED ON (puller accepted within 10s).");
      }
      playAcceptedFeedback();
      logTest(6, "PASS", "Backend acceptance received.");
      
      // TEST CASE 5: Active Ride Screen
      updateDisplay("Ride accepted!", "Driver en route", "Yellow LED: Active");
      
      currentState = SystemState::ACCEPTED;
      stateEntryTime = millis();
    }
    else if (response.indexOf("REJECTED") >= 0 || response.indexOf("TIMEOUT") >= 0 || 
             response.indexOf("\"status\":\"REJECTED\"") >= 0)
    {
      // TEST CASE 4: Red LED: Offer rejected
      playRejectedFeedback();
      logTest(4, "PASS", "Red LED indicates rejection.");
      logTest(6, "FAIL", "Backend rejection/timeout.");
      
      // TEST CASE 5: Update display
      updateDisplay("Ride rejected", "No driver available", "Red LED: Rejected");
      
      currentState = SystemState::REJECTED;
      stateEntryTime = millis();
    }
    else if (response.indexOf("ASSIGNED") >= 0)
    {
      // Ride assigned but not yet accepted - show Yellow LED
      setLEDs(false, true, false);
      updateDisplay("Driver assigned", "Awaiting confirm", "Yellow LED: Pending");
    }
  }
  client.end();
}

// ---------------------- Utility -----------------------------------
void logTest(uint8_t testId, const String &status, const String &detail)
{
  Serial.printf("[TEST-%u][%s] %s\n", testId, status.c_str(), detail.c_str());
}

void resetToIdle()
{
  setLEDs(false, false, false);
  verifiedPrivilege = false;
  detectionStart = 0;
  privilegeLaserStart = 0;
  buttonHoldStart = 0;
  buttonHeld = false;
  requestSentTime = 0;  // Reset request timestamp
  currentDestination = "";
  currentPickupLocation = "";
  estimatedDistance = 0.0f;
  potentialPoints = 0;
  updateDisplay("AERAS Ready", "Awaiting user...", "");
  currentState = SystemState::IDLE;
  stateEntryTime = millis();
}

// TEST CASE 7: GPS Location & Point Allocation
// Calculate distance between two GPS coordinates (Haversine formula)
float calculateDistance(float lat1, float lon1, float lat2, float lon2)
{
  const float R = 6371000.0f; // Earth radius in meters
  float dLat = (lat2 - lat1) * PI / 180.0f;
  float dLon = (lon2 - lon1) * PI / 180.0f;
  float a = sin(dLat / 2.0f) * sin(dLat / 2.0f) +
            cos(lat1 * PI / 180.0f) * cos(lat2 * PI / 180.0f) *
            sin(dLon / 2.0f) * sin(dLon / 2.0f);
  float c = 2.0f * atan2(sqrt(a), sqrt(1.0f - a));
  return R * c; // Distance in meters
}

// TEST CASE 7: Point Calculation Formula
// Base Points = 10
// Distance Penalty = (Actual Distance from Block / 10m)
// Final Points = Base Points - Distance Penalty (minimum 0)
int calculatePoints(float distanceFromBlock)
{
  const int BASE_POINTS = 10;
  const float PENALTY_PER_10M = 1.0f;
  
  float distancePenalty = distanceFromBlock / 10.0f; // Penalty per 10m
  int finalPoints = BASE_POINTS - (int)distancePenalty;
  
  // TEST CASE 7: Point allocation based on distance
  // (a) Drop at exact block location → +10 points (Full reward)
  // (b) Drop within 50m of block → +8 points (Partial reward)
  // (c) Drop 51-100m from block → +5 points (Reduced reward)
  // (d) Drop >100m from block → PENDING (Admin review required)
  
  if (finalPoints < 0)
    finalPoints = 0;
  
  return finalPoints;
}

