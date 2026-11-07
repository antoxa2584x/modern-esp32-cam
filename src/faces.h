// Face recognition (ESP32-S3 only, HAS_FACES): finds faces in the live
// frames, tells known people from strangers, keeps a short log of who was
// seen. People are remembered in the "faces" flash partition. On boards
// without it every call is a harmless no-op.
#pragma once
#include <Arduino.h>
#include <ArduinoJson.h>

#include <memory>
#include <vector>

namespace faces {
static const int MAX_PEOPLE = 16;  // photos remembered (a person may have several)

void begin();
bool available();  // compiled in and the flash partition exists
bool running();    // switched on and looking at frames right now

void applySettings();  // after config::s.faces changed

// Remembers the next single face the camera sees, under `name`.
// Progress shows in info() ("enroll").
void startEnroll(const String& name);
void cancelEnroll();
bool forget(uint32_t uid);  // removes one remembered photo

// People, enrolment progress and the recent sightings
void info(JsonObject out);
uint32_t eventSeq();  // changes with every new sighting
// Faces in the newest analysed frame, coordinates in 0..1000 of the picture
void live(JsonObject out);

// JPEGs: a remembered face, or the whole frame of a sighting
std::shared_ptr<std::vector<uint8_t>> photo(uint32_t uid);
std::shared_ptr<std::vector<uint8_t>> eventFrame(uint32_t seq);
}  // namespace faces
