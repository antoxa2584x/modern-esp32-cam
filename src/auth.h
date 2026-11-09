// Login: one user (name + password, stored as a salted PBKDF2 hash) and up to
// 8 remembered browser sessions (cookie "sid"), kept across reboots and
// expiring after 30 days. Each session remembers the device and address it
// is used from, and the last 16 login attempts are kept as a history.
// Only a hash of each session token is stored, so a copy of the flash can't
// be used to log in.
#pragma once
#include <Arduino.h>
#include <ArduinoJson.h>

namespace auth {
// Who is asking: the address, its rough location (from the relay, URL-encoded
// "City, Region, CC"), the browser's User-Agent, and whether it came through the relay
struct Client {
    String ip, place, ua;
    bool remote = false;
};

void begin();
bool configured();  // a user has been created
String user();
void setCredentials(const String& user, const String& pass);
// nullptr when the password is acceptable, else the reason (Ukrainian)
const char* passwordProblem(const String& pass);

// Wrong passwords lock that address out for a while (30 s after 5, then
// longer, up to 10 min), so a stranger can't lock the owner out. Many wrong
// passwords from many addresses within an hour stop new addresses from
// trying; ones that have logged in before still may. Through the relay
// (`remote`) and at home count separately. Returns "" on failure; every
// attempt goes into the history.
String login(const String& user, const String& pass, const Client& c, bool& lockedOut);
// The password again, for something that needs it (changing it, risky
// settings); a wrong one counts like a wrong login
bool checkPassword(const String& pass, const Client& c, bool& lockedOut);
uint32_t lockoutSeconds(const Client& c);

// A session for someone who has just proved who they are (setup, new password)
String newSession(const Client& c);
// `c`, when given, updates where the session was last used from
bool valid(const String& token, const Client* c = nullptr);
void logout(const String& token);
void logoutAll();
bool endSession(uint32_t id);  // false if there is no such session

// Risky changes (firmware, Wi-Fi, remote access, deleting every recording)
// need the password typed again: a stolen session alone can't make them.
// The confirmation lasts 10 minutes.
void confirm(const String& token);
bool confirmed(const String& token);
uint32_t confirmedSeconds(const String& token);  // left of the confirmation, 0 = none

// Recovery: every session and the login history go
void wipe();

// {sessions: [...], history: [...]}; `token` marks the asking device
void toJson(JsonObject o, const String& token);
uint32_t historySeq();  // changes with every login attempt
}  // namespace auth
