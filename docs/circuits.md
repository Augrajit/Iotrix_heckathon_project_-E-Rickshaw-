# AERAS Circuit Diagrams

## 1. User Block Wiring (ESP32 + Sensors)

```
             +5V (USB)
                |
                |----> ESP32 Vin
                |
               [Buck/Reg if needed]

          ┌───────────────────────────────────────┐
          │               ESP32                   │
          │                                       │
    SDA D4│◄───────────── OLED SDA                │
    SCL D15│◄──────────── OLED SCL                │
    TRIG D5│────────────► HC-SR04 TRIG            │
    ECHO D18│◄─────────── HC-SR04 ECHO (via 1k/2k)│
     LDR A0│◄───┬─ LDR ──┬──► 3.3V                │
             GND│    │    └─10kΩ─► GND            │
 BUTTON D19│◄───┬──── Push Button ───► GND        │
 BUZZER D21│───► Buzzer +                        │
 REDLED D22│───► 220Ω ─► Red LED ─► GND          │
 YELLED D23│───► 220Ω ─► Yellow LED ─► GND       │
 GRNLED D25│───► 220Ω ─► Green LED ─► GND        │
          │                                       │
          └───────────────────────────────────────┘
```

> Note: Level shift HC-SR04 ECHO to 3.3 V using resistor divider (1 kΩ/2 kΩ).

## 2. Rickshaw Module (ESP32 + GPS + OLED)

```
          ┌─────────────────────────┐
          │          ESP32          │
          │                         │
   SDA D4 │◄──────── OLED SDA       │
   SCL D15│◄──────── OLED SCL       │
   RX2 D16│◄──────── GPS TX         │
   TX2 D17│────────► GPS RX         │
          │                         │
          └─────────────────────────┘

              ┌───────────┐
              │  GPS Neo  │
              │           │
      VCC ────┴─5V        │
      GND ────┴─GND       │
```

Ensure GPS GND and ESP32 GND are common. Supply GPS with 3.3 V or 5 V per module specs.

## 3. Power Distribution

```
 [12V Rickshaw Battery]
          |
      DC-DC Buck (12V → 5V @ 3A)
          |
     +----+----+
     |         |
  ESP32        GPS
  (5V Vin)     (5V)
     |
  Onboard LDO → 3.3 V rail → OLED, LDR divider, LEDs (via resistors)
```

Add a 1000 µF electrolytic capacitor across 5 V/GND near ESP32 to buffer ride vibrations and motor noise. Place 0.1 µF ceramic decoupling capacitors near sensors.

