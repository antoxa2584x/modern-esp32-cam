#pragma once
// Board pin maps. The PlatformIO environment picks one with -DBOARD_...;
// without one it is the AI-Thinker ESP32-CAM. A pin of -1 means "not on this board".

#if defined(BOARD_ESP32S3_CAM)
// ESP32-S3-CAM N16R8 (HW-679, ESP32-CAM shape), same map as Freenove's
// ESP32-S3-WROOM CAM. Camera and SD verified on the board.
#define PWDN_GPIO_NUM -1
#define RESET_GPIO_NUM -1
#define XCLK_GPIO_NUM 15
#define SIOD_GPIO_NUM 4
#define SIOC_GPIO_NUM 5
#define Y9_GPIO_NUM 16
#define Y8_GPIO_NUM 17
#define Y7_GPIO_NUM 18
#define Y6_GPIO_NUM 12
#define Y5_GPIO_NUM 10
#define Y4_GPIO_NUM 8
#define Y3_GPIO_NUM 9
#define Y2_GPIO_NUM 11
#define VSYNC_GPIO_NUM 6
#define HREF_GPIO_NUM 7
#define PCLK_GPIO_NUM 13

#define SD_CLK_PIN 39
#define SD_CMD_PIN 38
#define SD_D0_PIN 40

// The flash LED isn't wired to any GPIO on this board (every free pin, and
// 43/44, tested), so no lamp. The status LED next to the red power LED is GPIO2.
#define LAMP_PIN -1
#define STATUS_LED_PIN 2
#define STATUS_LED_ON HIGH

// The S3 runs Espressif's face detection and recognition (esp-dl) fast enough
#define HAS_FACES 1

#else
// AI-Thinker ESP32-CAM
#define PWDN_GPIO_NUM 32
#define RESET_GPIO_NUM -1
#define XCLK_GPIO_NUM 0
#define SIOD_GPIO_NUM 26
#define SIOC_GPIO_NUM 27
#define Y9_GPIO_NUM 35
#define Y8_GPIO_NUM 34
#define Y7_GPIO_NUM 39
#define Y6_GPIO_NUM 36
#define Y5_GPIO_NUM 21
#define Y4_GPIO_NUM 19
#define Y3_GPIO_NUM 18
#define Y2_GPIO_NUM 5
#define VSYNC_GPIO_NUM 25
#define HREF_GPIO_NUM 23
#define PCLK_GPIO_NUM 22

// Fixed SDMMC pins on the ESP32 (1-bit mode)
#define SD_CLK_PIN 14
#define SD_CMD_PIN 15
#define SD_D0_PIN 2

#define LAMP_PIN 4  // also SD D1 in 4-bit mode, so the card runs 1-bit
#define STATUS_LED_PIN 33
#define STATUS_LED_ON LOW

#define HAS_FACES 0  // recognition takes seconds per frame on the plain ESP32
#endif

#define HAS_LAMP (LAMP_PIN >= 0)

// Allocations from this size up go to PSRAM (see main.cpp)
#define PSRAM_ALLOC_MIN 512
