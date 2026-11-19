/* hproxy_keys: the keyboard's layout and moves, in plain C (tested on any computer).
 *
 * The Flipper's own keyboard has letters, digits and '_' only: no '.', ':', '@' or '/', so a
 * proxy or a link cannot be typed with it. This one has every printable character on two pages.
 * Each row is 13 slots wide; a key takes one slot or more.
 *
 *   letters:  1 2 3 4 5 6 7 8 9 0 - . _        symbols:  1 2 3 4 5 6 7 8 9 0 - . _
 *             q w e r t y u i o p : / @                  : / @ ? = & % # ! $ * + ,
 *             a s d f g h j k l ? = [del]                ( ) [ ] { } < > ; ' " [del]
 *             [^] z x c v b n m [#+] [ OK ]              [space] ` ~ ^ | \ [abc] [ OK ]
 */
#pragma once

#include <stdbool.h>
#include <stdint.h>

#define HPROXY_KEY_ROWS 4
#define HPROXY_KEY_SLOTS 13

typedef enum {
    HproxyKeysLetters,
    HproxyKeysSymbols,
} HproxyKeysPage;

typedef enum {
    HproxyKeyChar, /* types `ch` */
    HproxyKeySpace, /* types ' ' */
    HproxyKeyShift, /* capitals on and off */
    HproxyKeyPage, /* the other page */
    HproxyKeyDelete, /* the last character */
    HproxyKeyDone, /* OK: the text is ready */
} HproxyKeyKind;

typedef struct {
    HproxyKeyKind kind;
    char ch;
    uint8_t slot; /* the first slot it covers */
    uint8_t slots; /* how many */
} HproxyKey;

/* How many keys a row has, and one of them. */
uint8_t hproxy_keys_count(HproxyKeysPage page, uint8_t row);
const HproxyKey* hproxy_keys_get(HproxyKeysPage page, uint8_t row, uint8_t index);

/* Moves the selection: dx left (-1) or right (+1) along the row, dy up (-1) or down (+1) to
 * the key above or below the middle of this one. Both wrap around. */
void hproxy_keys_move(HproxyKeysPage page, uint8_t* row, uint8_t* index, int dx, int dy);

/* The key at the same place on another page. */
uint8_t hproxy_keys_same_place(HproxyKeysPage from, HproxyKeysPage to, uint8_t row, uint8_t index);

/* The character a key types: capitals when `caps`, NUL for a key that types nothing. */
char hproxy_keys_char(const HproxyKey* key, bool caps);
