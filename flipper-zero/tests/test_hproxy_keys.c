/* Tests for hproxy_keys.c, built and run on any computer:
 *
 *   cc -std=c11 -Wall -Wextra -Werror -I. tests/test_hproxy_keys.c hproxy_keys.c -o test_hproxy_keys
 *   ./test_hproxy_keys
 */
#include "hproxy_keys.h"

#include <stdio.h>
#include <string.h>

static int failures = 0;
static int checks = 0;

#define CHECK(cond)                                                       \
    do {                                                                  \
        checks++;                                                         \
        if(!(cond)) {                                                     \
            printf("FAIL %s:%d: %s\n", __FILE__, __LINE__, #cond);        \
            failures++;                                                   \
        }                                                                 \
    } while(0)

static const HproxyKeysPage PAGES[] = {HproxyKeysLetters, HproxyKeysSymbols};

/* Every row covers its 13 slots, each exactly once, in order. */
static void rows_cover_every_slot(void) {
    for(size_t p = 0; p < 2; p++) {
        for(uint8_t row = 0; row < HPROXY_KEY_ROWS; row++) {
            uint8_t next = 0;
            for(uint8_t i = 0; i < hproxy_keys_count(PAGES[p], row); i++) {
                const HproxyKey* key = hproxy_keys_get(PAGES[p], row, i);
                CHECK(key->slot == next);
                CHECK(key->slots >= 1);
                next = (uint8_t)(next + key->slots);
            }
            CHECK(next == HPROXY_KEY_SLOTS);
        }
    }
}

/* Every printable character can be typed, and each page has one OK, one delete, one page key. */
static void every_character_types(void) {
    bool typed[128] = {false};
    for(size_t p = 0; p < 2; p++) {
        int done = 0;
        int del = 0;
        int page = 0;
        for(uint8_t row = 0; row < HPROXY_KEY_ROWS; row++) {
            for(uint8_t i = 0; i < hproxy_keys_count(PAGES[p], row); i++) {
                const HproxyKey* key = hproxy_keys_get(PAGES[p], row, i);
                for(int caps = 0; caps < 2; caps++) {
                    char c = hproxy_keys_char(key, caps != 0);
                    if(c) typed[(unsigned char)c] = true;
                }
                if(key->kind == HproxyKeyDone) done++;
                if(key->kind == HproxyKeyDelete) del++;
                if(key->kind == HproxyKeyPage) page++;
            }
        }
        CHECK(done == 1 && del == 1 && page == 1);
    }
    for(int c = 0x20; c < 0x7f; c++) {
        if(!typed[c]) printf("FAIL: '%c' cannot be typed\n", c);
        CHECK(typed[c]);
    }
}

static void moves(void) {
    uint8_t row = 0;
    uint8_t index = 0;
    hproxy_keys_move(HproxyKeysLetters, &row, &index, -1, 0);
    CHECK(row == 0 && index == 12); /* left from '1' wraps to the last key, '_' */
    CHECK(hproxy_keys_char(hproxy_keys_get(HproxyKeysLetters, row, index), false) == '_');
    hproxy_keys_move(HproxyKeysLetters, &row, &index, 1, 0);
    CHECK(row == 0 && index == 0);
    hproxy_keys_move(HproxyKeysLetters, &row, &index, 0, -1);
    CHECK(row == 3 && hproxy_keys_get(HproxyKeysLetters, row, index)->kind == HproxyKeyShift);

    row = 1; /* 'p' */
    index = 9;
    hproxy_keys_move(HproxyKeysLetters, &row, &index, 0, 1);
    CHECK(row == 2 && hproxy_keys_char(hproxy_keys_get(HproxyKeysLetters, row, index), false) == '?');
    hproxy_keys_move(HproxyKeysLetters, &row, &index, 0, 1);
    CHECK(row == 3 && hproxy_keys_get(HproxyKeysLetters, row, index)->kind == HproxyKeyPage);

    row = 2; /* delete, slots 11 and 12 */
    index = 11;
    hproxy_keys_move(HproxyKeysLetters, &row, &index, 0, 1);
    CHECK(row == 3 && hproxy_keys_get(HproxyKeysLetters, row, index)->kind == HproxyKeyDone);
    hproxy_keys_move(HproxyKeysLetters, &row, &index, 0, -1);
    CHECK(row == 2 && hproxy_keys_get(HproxyKeysLetters, row, index)->kind == HproxyKeyDelete);
    hproxy_keys_move(HproxyKeysLetters, &row, &index, 0, 1);
    hproxy_keys_move(HproxyKeysLetters, &row, &index, 0, 1);
    CHECK(row == 0); /* down from the last row wraps to the first */

    /* A selection past the end of a row (after a page change) lands on its last key. */
    row = 3;
    index = 200;
    hproxy_keys_move(HproxyKeysSymbols, &row, &index, 0, 0);
    CHECK(index == hproxy_keys_count(HproxyKeysSymbols, 3) - 1);

    /* The other page keeps the place. */
    CHECK(
        hproxy_keys_get(HproxyKeysSymbols, 3, hproxy_keys_same_place(HproxyKeysLetters, HproxyKeysSymbols, 3, 8))
            ->kind == HproxyKeyPage);
    CHECK(
        hproxy_keys_get(HproxyKeysSymbols, 3, hproxy_keys_same_place(HproxyKeysLetters, HproxyKeysSymbols, 3, 1))
            ->kind == HproxyKeySpace);
    CHECK(hproxy_keys_same_place(HproxyKeysSymbols, HproxyKeysLetters, 1, 5) == 5);
}

static void characters(void) {
    const HproxyKey* q = hproxy_keys_get(HproxyKeysLetters, 1, 0);
    CHECK(hproxy_keys_char(q, false) == 'q');
    CHECK(hproxy_keys_char(q, true) == 'Q');
    CHECK(hproxy_keys_char(hproxy_keys_get(HproxyKeysLetters, 0, 0), true) == '1');
    CHECK(hproxy_keys_char(hproxy_keys_get(HproxyKeysLetters, 1, 10), true) == ':');
    CHECK(hproxy_keys_char(hproxy_keys_get(HproxyKeysLetters, 3, 0), false) == '\0');
    CHECK(hproxy_keys_char(hproxy_keys_get(HproxyKeysSymbols, 3, 0), false) == ' ');
    CHECK(hproxy_keys_char(NULL, false) == '\0');
}

int main(void) {
    rows_cover_every_slot();
    every_character_types();
    moves();
    characters();
    if(failures) {
        printf("%d of %d checks failed\n", failures, checks);
        return 1;
    }
    printf("all %d checks passed\n", checks);
    return 0;
}
