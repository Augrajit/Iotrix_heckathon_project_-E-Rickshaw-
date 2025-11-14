#include <Arduino.h>
#include <Wire.h>
#include <WiFi.h>
#include <HTTPClient.h>
#include <Adafruit_GFX.h>
#include <Adafruit_SSD1306.h>

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
const float DETECTION_THRESHOLD_CM = 1000.0f; // 10 meters
const uint32_t DETECTION_HOLD_TIME_MS = 3000;
const uint16_t LDR_THRESHOLD = 2500;          // Adjust after calibration (0-4095)
const uint32_t BUTTON_DEBOUNCE_MS = 200;
const uint32_t REQUEST_COOLDOWN_MS = 10000;
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
bool lastButtonState = HIGH;
bool verifiedPrivilege = false;
uint32_t lastRequestTime = 0;
uint32_t stateEntryTime = 0;

// ---------------------- Helper Forward Declarations ----------------
float measureDistanceCm();
bool hasPrivilege();
bool buttonPressed();
void setLEDs(bool red, bool yellow, bool green);
void buzz(uint16_t toneHz, uint32_t durationMs);
void updateDisplay(const String &line1, const String &line2 = "", const String &line3 = "");
void connectWiFi();
bool sendRideRequest();
void playReadyFeedback();
void playAcceptedFeedback();
void playRejectedFeedback();
void logTest(uint8_t testId, const String &status, const String &detail);
void handleBackendResponse();
void resetToIdle();

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
}

// ---------------------- Main Loop ----------------------------------
void loop()
{
  float distance = measureDistanceCm();
  bool privilege = hasPrivilege();

  switch (currentState)
  {
  case SystemState::IDLE:
    if (distance > 0 && distance <= DETECTION_THRESHOLD_CM)
    {
      detectionStart = (detectionStart == 0) ? millis() : detectionStart;
      currentState = SystemState::DETECTING;
      stateEntryTime = millis();
      Serial.printf("[INFO] Candidate detected at %.2f cm. Monitoring for %.1f s...\n", distance, DETECTION_HOLD_TIME_MS / 1000.0f);
      logTest(1, "RUN", "Distance candidate in range.");
    }
    break;

  case SystemState::DETECTING:
    if (distance > 0 && distance <= DETECTION_THRESHOLD_CM)
    {
      if (millis() - detectionStart >= DETECTION_HOLD_TIME_MS)
      {
        currentState = SystemState::VERIFIED;
        stateEntryTime = millis();
        logTest(1, "PASS", "Presence sustained >=3s within 10m.");
        playReadyFeedback();
        updateDisplay("User detected", "Align laser to", "unlock access");
        Serial.println("[STATE] DETECTING -> VERIFIED (awaiting privilege).");
      }
    }
    else
    {
      logTest(1, "FAIL", "Presence lost before timeout.");
      resetToIdle();
    }
    break;

  case SystemState::VERIFIED:
    if (!privilege)
    {
      if (millis() - stateEntryTime > 8000)
      {
        logTest(2, "FAIL", "Privilege laser timeout.");
        playRejectedFeedback();
        resetToIdle();
      }
      else
      {
        setLEDs(false, true, false); // Yellow LED on while waiting for privilege
      }
    }
    else
    {
      verifiedPrivilege = true;
      setLEDs(false, true, false);
      buzz(TONE_READY, TONE_DURATION);
      logTest(2, "PASS", "Laser privilege verified.");
      updateDisplay("Privilege OK", "Press button", "to request ride");
      Serial.println("[STATE] PRIVILEGE VERIFIED. Awaiting button press.");
      if (buttonPressed())
      {
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
          lastRequestTime = millis();
          setLEDs(false, true, false);
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
    }
    break;

  case SystemState::WAITING_RESPONSE:
    handleBackendResponse();
    if (millis() - stateEntryTime > STATUS_TIMEOUT_MS)
    {
      Serial.println("[TIMEOUT] No response from backend within window.");
      logTest(4, "FAIL", "Timeout waiting for ride acceptance.");
      logTest(6, "FAIL", "No driver acknowledged.");
      playRejectedFeedback();
      resetToIdle();
    }
    break;

  case SystemState::ACCEPTED:
    setLEDs(false, false, true);
    updateDisplay("Ride accepted", "Driver en route", "");
    logTest(4, "PASS", "Green LED indicates acceptance.");
    logTest(5, "PASS", "OLED shows acceptance message.");
    delay(3000);
    resetToIdle();
    break;

  case SystemState::REJECTED:
    setLEDs(true, false, false);
    updateDisplay("Ride rejected", "Please retry", "");
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
  uint16_t ldrValue = analogRead(PIN_LDR);
  static uint32_t lastPrint = 0;
  if (millis() - lastPrint > 1000)
  {
    Serial.printf("[DEBUG] LDR: %u (threshold %u)\n", ldrValue, LDR_THRESHOLD);
    lastPrint = millis();
  }
  return ldrValue >= LDR_THRESHOLD;
}

bool buttonPressed()
{
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
      logTest(6, "FAIL", "Unable to connect to WiFi.");
      updateDisplay("WiFi failed", "Check network", "");
      playRejectedFeedback();
      delay(5000);
      ESP.restart();
    }
  }
  Serial.printf("\n[NETWORK] Connected. IP: %s\n", WiFi.localIP().toString().c_str());
  logTest(6, "PASS", "WiFi connected.");
}

bool sendRideRequest()
{
  if (WiFi.status() != WL_CONNECTED)
  {
    connectWiFi();
  }
  HTTPClient client;
  String url = String(BACKEND_HOST) + "/requestRide";
  client.begin(url);
  client.addHeader("Content-Type", "application/json");
  String payload = String("{\"blockId\":\"") + BLOCK_ID + "\"}";
  Serial.printf("[HTTP] POST %s -> %s\n", url.c_str(), payload.c_str());
  int code = client.POST(payload);
  if (code > 0)
  {
    String response = client.getString();
    Serial.printf("[HTTP %d] %s\n", code, response.c_str());
    client.end();
    if (code == 200)
    {
      return true;
    }
  }
  else
  {
    Serial.printf("[HTTP ERROR] %s\n", client.errorToString(code).c_str());
  }
  client.end();
  return false;
}

void handleBackendResponse()
{
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

    if (response.indexOf("ACCEPTED") >= 0)
    {
      playAcceptedFeedback();
      logTest(6, "PASS", "Backend acceptance received.");
      currentState = SystemState::ACCEPTED;
      stateEntryTime = millis();
    }
    else if (response.indexOf("REJECTED") >= 0 || response.indexOf("TIMEOUT") >= 0)
    {
      playRejectedFeedback();
      logTest(6, "FAIL", "Backend rejection/timeout.");
      currentState = SystemState::REJECTED;
      stateEntryTime = millis();
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
  updateDisplay("Idle", "Awaiting next", "user...");
  currentState = SystemState::IDLE;
  stateEntryTime = millis();
}

