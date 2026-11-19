/* keyboard: a screen to type any printable text, for proxies, links and addresses.
 *
 * The layout and the moves are in hproxy_keys.c. Arrows move, OK types (held: the other case),
 * the arrow key turns capitals on and off, #+ and abc switch pages, OK on the OK key hands the
 * text over. Back leaves; the text typed so far can be read back as a draft. */
#pragma once

#include <gui/view.h>
#include <stddef.h>

#define KEYBOARD_TEXT_MAX 256

typedef struct Keyboard Keyboard;

/* NULL when the text may go, or a few words saying why not; they show in the field. */
typedef const char* (*KeyboardCheck)(void* context, const char* text);

/* The text, once the check took it. */
typedef void (*KeyboardDone)(void* context, const char* text);

Keyboard* keyboard_alloc(void);
void keyboard_free(Keyboard* keyboard);
View* keyboard_get_view(Keyboard* keyboard);

/* Starts on `text` (copied), at most `max` characters (below KEYBOARD_TEXT_MAX). */
void keyboard_setup(
    Keyboard* keyboard,
    const char* header,
    const char* text,
    size_t max,
    KeyboardCheck check,
    KeyboardDone done,
    void* context);

/* What has been typed so far. */
void keyboard_text(Keyboard* keyboard, char* out, size_t size);
