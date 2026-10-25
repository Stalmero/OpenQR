#include <WiFi.h>
#include <WiFiClientSecure.h>
#include <HTTPClient.h>
#include <ArduinoJson.h>

// -------------------------------------
const char* WIFI_SSID = "Totalplay-9CB0";
const char* WIFI_PASSWORD = "9CB05370wfF5Fdep";
const char* SERVIDOR_HOST = "openqr.duckdns.org"; 
const char* DEVICE_SECRET = "openqr-esp32-8f3k2m9x7q";
// -------------------------------------

const int PIN_RELE = 26;
const int PIN_LED_VERDE = 5;
const int PIN_LED_ROJO = 2;

const unsigned long INTERVALO_POLL = 1500;
const unsigned long DURACION_PULSO = 3000;

unsigned long ultimoPoll A= 0;
unsigned long inicioPulso = 0;
bool pulsoActivo = false;

void setup() {
  Serial.begin(115200);

  digitalWrite(PIN_RELE, HIGH);
  pinMode(PIN_RELE, OUTPUT);
  digitalWrite(PIN_RELE, HIGH);

  pinMode(PIN_LED_VERDE, OUTPUT);
  pinMode(PIN_LED_ROJO, OUTPUT);
  digitalWrite(PIN_LED_VERDE, LOW);
  digitalWrite(PIN_LED_ROJO, LOW);

  conectarWiFi();
}

void loop() {
  if (pulsoActivo && (millis() - inicioPulso >= DURACION_PULSO)) {
    cerrarPuerta();
  }

  if (!pulsoActivo && millis() - ultimoPoll >= INTERVALO_POLL) {
    ultimoPoll = millis();
    consultarServidor();
  }

  if (WiFi.status() != WL_CONNECTED) {
    conectarWiFi();
  }
}

void conectarWiFi() {
  Serial.print("Conectando a WiFi");
  WiFi.begin(WIFI_SSID, WIFI_PASSWORD);
  int intentos = 0;
  while (WiFi.status() != WL_CONNECTED && intentos < 30) {
    delay(500);
    Serial.print(".");
    intentos++;
  }
  if (WiFi.status() == WL_CONNECTED) {
    Serial.println("\nConectado. IP: " + WiFi.localIP().toString());
  } else {
    Serial.println("\nNo se pudo conectar. Reintentando en el próximo ciclo.");
  }
}

void consultarServidor() {
  if (WiFi.status() != WL_CONNECTED) return;

  WiFiClientSecure client;
  client.setInsecure();

  HTTPClient https;
  String url = String("https://") + SERVIDOR_HOST + "/api/device/status?secret=" + DEVICE_SECRET;

  if (https.begin(client, url)) {
    int codigoHttp = https.GET();

    if (codigoHttp == 200) {
      String payload = https.getString();
      StaticJsonDocument<200> doc;
      DeserializationError error = deserializeJson(doc, payload);

      if (!error) {
        bool abrir = doc["abrir"];
        Serial.println(abrir ? "Acceso autorizado. Abriendo puerta." : "Sin cambios.");
        if (abrir) {
          abrirPuerta();
        }
      } else {
        Serial.println("Error al leer JSON del servidor.");
      }
    } else {
      Serial.printf("Error HTTP: %d\n", codigoHttp);
      parpadearError();
    }
    https.end();
  } else {
    Serial.println("No se pudo conectar al servidor.");
    parpadearError();
  }
}

void abrirPuerta() {
  digitalWrite(PIN_RELE, LOW);
  digitalWrite(PIN_LED_VERDE, HIGH);
  digitalWrite(PIN_LED_ROJO, LOW);
  inicioPulso = millis();
  pulsoActivo = true;
}

void cerrarPuerta() {
  digitalWrite(PIN_RELE, HIGH);
  digitalWrite(PIN_LED_VERDE, LOW);
  pulsoActivo = false;
}

void parpadearError() {
  digitalWrite(PIN_LED_ROJO, HIGH);
  delay(150);
  digitalWrite(PIN_LED_ROJO, LOW);
}