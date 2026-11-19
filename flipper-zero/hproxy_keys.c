/* hproxy_keys: see hproxy_keys.h. */
#include "hproxy_keys.h"

#include <stddef.h>

#define C(c, s) {HproxyKeyChar, (c), (s), 1}

static const HproxyKey DIGITS[] = {
    C('1', 0),
    C('2', 1),
    C('3', 2),
    C('4', 3),
    C('5', 4),
    C('6', 5),
    C('7', 6),
    C('8', 7),
    C('9', 8),
    C('0', 9),
    C('-', 10),
    C('_', 11),
    C('.', 12),
};

static const HproxyKey LETTERS_1[] = {
    C('q', 0),
    C('w', 1),
    C('e', 2),
    C('r', 3),
    C('t', 4),
    C('y', 5),
    C('u', 6),
    C('i', 7),
    C('o', 8),
    C('p', 9),
    C(':', 10),
    C('/', 11),
    C('@', 12),
};

static const HproxyKey LETTERS_2[] = {
    C('a', 0),
    C('s', 1),
    C('d', 2),
    C('f', 3),
    C('g', 4),
    C('h', 5),
    C('j', 6),
    C('k', 7),
    C('l', 8),
    C('?', 9),
    C('=', 10),
    {HproxyKeyDelete, 0, 11, 2},
};

static const HproxyKey LETTERS_3[] = {
    {HproxyKeyShift, 0, 0, 1},
    C('z', 1),
    C('x', 2),
    C('c', 3),
    C('v', 4),
    C('b', 5),
    C('n', 6),
    C('m', 7),
    {HproxyKeyPage, 0, 8, 2},
    {HproxyKeyDone, 0, 10, 3},
};

static const HproxyKey SYMBOLS_1[] = {
    C(':', 0),
    C('/', 1),
    C('@', 2),
    C('?', 3),
    C('=', 4),
    C('&', 5),
    C('%', 6),
    C('#', 7),
    C('!', 8),
    C('$', 9),
    C('*', 10),
    C('+', 11),
    C(',', 12),
};

static const HproxyKey SYMBOLS_2[] = {
    C('(', 0),
    C(')', 1),
    C('[', 2),
    C(']', 3),
    C('{', 4),
    C('}', 5),
    C('<', 6),
    C('>', 7),
    C(';', 8),
    C('\'', 9),
    C('"', 10),
    {HproxyKeyDelete, 0, 11, 2},
};

static const HproxyKey SYMBOLS_3[] = {
    {HproxyKeySpace, ' ', 0, 3},
    C('`', 3),
    C('~', 4),
    C('^', 5),
    C('|', 6),
    C('\\', 7),
    {HproxyKeyPage, 0, 8, 2},
    {HproxyKeyDone, 0, 10, 3},
};

#undef C

typedef struct {
    const HproxyKey* keys;
    uint8_t count;
} Row;

#define ROW(keys) {(keys), (uint8_t)(sizeof(keys) / sizeof((keys)[0]))}

static const Row PAGES[2][HPROXY_KEY_ROWS] = {
    {ROW(DIGITS), ROW(LETTERS_1), ROW(LETTERS_2), ROW(LETTERS_3)},
    {ROW(DIGITS), ROW(SYMBOLS_1), ROW(SYMBOLS_2), ROW(SYMBOLS_3)},
};

static const Row* row_of(HproxyKeysPage page, uint8_t row) {
    return &PAGES[page == HproxyKeysSymbols ? 1 : 0][row % HPROXY_KEY_ROWS];
}

uint8_t hproxy_keys_count(HproxyKeysPage page, uint8_t row) {
    return row_of(page, row)->count;
}

const HproxyKey* hproxy_keys_get(HproxyKeysPage page, uint8_t row, uint8_t index) {
    const Row* r = row_of(page, row);
    return &r->keys[index < r->count ? index : r->count - 1];
}

/* The key of a row that covers `slot`. Every row covers all of its slots. */
static uint8_t key_at_slot(const Row* r, uint8_t slot) {
    for(uint8_t i = 0; i < r->count; i++) {
        if(slot >= r->keys[i].slot && slot < r->keys[i].slot + r->keys[i].slots) return i;
    }
    return (uint8_t)(r->count - 1);
}

static uint8_t middle(const HproxyKey* key) {
    return (uint8_t)(key->slot + (key->slots - 1) / 2);
}

void hproxy_keys_move(HproxyKeysPage page, uint8_t* row, uint8_t* index, int dx, int dy) {
    const Row* r = row_of(page, *row);
    if(*index >= r->count) *index = (uint8_t)(r->count - 1);
    if(dx) {
        *index = (uint8_t)((*index + r->count + (dx > 0 ? 1 : -1)) % r->count);
    }
    if(dy) {
        uint8_t slot = middle(&r->keys[*index]);
        *row = (uint8_t)((*row + HPROXY_KEY_ROWS + (dy > 0 ? 1 : -1)) % HPROXY_KEY_ROWS);
        *index = key_at_slot(row_of(page, *row), slot);
    }
}

uint8_t hproxy_keys_same_place(HproxyKeysPage from, HproxyKeysPage to, uint8_t row, uint8_t index) {
    return key_at_slot(row_of(to, row), middle(hproxy_keys_get(from, row, index)));
}

char hproxy_keys_char(const HproxyKey* key, bool caps) {
    if(!key) return '\0';
    if(key->kind == HproxyKeySpace) return ' ';
    if(key->kind != HproxyKeyChar) return '\0';
    if(caps && key->ch >= 'a' && key->ch <= 'z') return (char)(key->ch - 'a' + 'A');
    return key->ch;
}
