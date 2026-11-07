// Login: one user (name + password, stored as a salted PBKDF2 hash) and up to
// 8 remembered browser sessions (cookie "sid"), kept across reboots and
// expiring after 30 days.
#pragma once
#include <Arduino.h>

namespace auth {
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
String login(const String& user, const String& pass, bool remote, bool& lockedOut);
bool valid(const String& token);
void logout(const String& token);
void logoutAll();
uint32_t lockoutSeconds(bool remote);
}  // namespace auth
