// Login: one user (name + password, stored as a salted PBKDF2 hash) and up to
// 8 remembered browser sessions (cookie "sid"), kept across reboots and
// expiring after 30 days. Each session remembers the device and address it
// is used from, and the last 16 login attempts are kept as a history.
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
bool checkPassword(const String& pass);
// nullptr when the password is acceptable, else the reason (Ukrainian)
const char* passwordProblem(const String& pass);

// Wrong passwords lock logins for a while. Requests through the relay
// (`remote`) and from the home network count separately, so an attacker on
// the internet can't lock the owner out at home. Returns "" on failure.
// Every attempt goes into the history.
String login(const String& user, const String& pass, const Client& c, bool& lockedOut);
// A session for someone who has just proved who they are (setup, new password)
String newSession(const Client& c);
// `c`, when given, updates where the session was last used from
bool valid(const String& token, const Client* c = nullptr);
void logout(const String& token);
void logoutAll();
bool endSession(uint32_t id);  // false if there is no such session
uint32_t lockoutSeconds(bool remote);

// {sessions: [...], history: [...]}; `token` marks the asking device
void toJson(JsonObject o, const String& token);
uint32_t historySeq();  // changes with every login attempt
}  // namespace auth
