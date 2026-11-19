/* keyboard: see keyboard.h. */
#include "keyboard.h"

#include <furi.h>
#include <gui/canvas.h>
#include <gui/elements.h>
#include <input/input.h>

#include <stdio.h>
#include <string.h>

#include "hproxy_keys.h"

/* Where things are, in pixels: a header line, the text field, and four rows of keys. */
#define HEADER_Y 7
#define FIELD_Y 9
#define FIELD_H 13
#define TEXT_Y 18
#define KEYS_X 5
#define KEYS_Y 23
#define KEY_W 9
#define KEY_H 10

struct Keyboard {
    View* view;
    KeyboardCheck check;
    KeyboardDone done;
    void* context;
};

typedef struct {
    char header[32];
    char text[KEYBOARD_TEXT_MAX];
    size_t max;
    HproxyKeysPage page;
    uint8_t row;
    uint8_t index;
    bool caps;
    char message[48]; /* why OK did not take the text, shown until the next key */
} KeyboardModel;

/* The end of the text, as much as fits, with "..." in front when not all of it does, and the
 * cursor after it. */
static void draw_text(Canvas* canvas, const char* text) {
    const int32_t left = 3;
    const int32_t room = 128 - left - 6; /* the cursor and the frame stay clear */
    size_t len = strlen(text);
    size_t start = len;
    int32_t width = 0;
    while(start > 0) {
        int32_t w = (int32_t)canvas_glyph_width(canvas, (uint8_t)text[start - 1]);
        if(width + w > room) break;
        width += w;
        start--;
    }
    int32_t x = left;
    if(start > 0) {
        int32_t dots = (int32_t)canvas_string_width(canvas, "...") + 2;
        while(start < len && width > room - dots) {
            width -= (int32_t)canvas_glyph_width(canvas, (uint8_t)text[start]);
            start++;
        }
        canvas_draw_str(canvas, left, TEXT_Y, "...");
        x += dots;
    }
    canvas_draw_str(canvas, x, TEXT_Y, text + start);
    canvas_draw_box(canvas, x + width + 1, FIELD_Y + 2, 1, FIELD_H - 4);
}

/* The keys that are pictures: shift (an arrow up), delete (an arrow left), space (a bracket). */
static void draw_shift(Canvas* canvas, int32_t x, int32_t top, bool caps) {
    int32_t cx = x + 4;
    canvas_draw_box(canvas, cx, top + 2, 1, 1);
    canvas_draw_box(canvas, cx - 1, top + 3, 3, 1);
    canvas_draw_box(canvas, cx - 2, top + 4, 5, 1);
    canvas_draw_box(canvas, cx - 1, top + 5, 3, 2);
    if(caps) canvas_draw_box(canvas, cx - 2, top + 8, 5, 1);
}

static void draw_delete(Canvas* canvas, int32_t x, int32_t top, int32_t w) {
    int32_t cx = x + w / 2;
    int32_t cy = top + 5;
    canvas_draw_box(canvas, cx - 4, cy, 1, 1);
    canvas_draw_box(canvas, cx - 3, cy - 1, 1, 3);
    canvas_draw_box(canvas, cx - 2, cy - 2, 1, 5);
    canvas_draw_box(canvas, cx - 1, cy - 1, 6, 3);
}

static void draw_space(Canvas* canvas, int32_t x, int32_t top, int32_t w) {
    canvas_draw_box(canvas, x + 4, top + 7, w - 8, 1);
    canvas_draw_box(canvas, x + 4, top + 5, 1, 2);
    canvas_draw_box(canvas, x + w - 5, top + 5, 1, 2);
}

static void draw_word(Canvas* canvas, int32_t x, int32_t top, int32_t w, const char* word) {
    canvas_set_font(canvas, FontSecondary);
    canvas_draw_str_aligned(canvas, x + w / 2 + 1, top + 8, AlignCenter, AlignBottom, word);
    canvas_set_font(canvas, FontKeyboard);
}

static void keyboard_draw(Canvas* canvas, void* data) {
    KeyboardModel* model = data;
    canvas_clear(canvas);
    canvas_set_color(canvas, ColorBlack);
    canvas_set_font(canvas, FontSecondary);
    canvas_draw_str(canvas, 2, HEADER_Y, model->header);
    canvas_draw_rframe(canvas, 0, FIELD_Y, 128, FIELD_H, 1);
    if(model->message[0]) {
        canvas_draw_box(canvas, 1, FIELD_Y + 1, 126, FIELD_H - 2);
        canvas_set_color(canvas, ColorWhite);
        canvas_draw_str(canvas, 3, TEXT_Y, model->message);
        canvas_set_color(canvas, ColorBlack);
    } else {
        draw_text(canvas, model->text);
    }

    canvas_set_font(canvas, FontKeyboard);
    for(uint8_t row = 0; row < HPROXY_KEY_ROWS; row++) {
        int32_t top = KEYS_Y + row * KEY_H;
        for(uint8_t i = 0; i < hproxy_keys_count(model->page, row); i++) {
            const HproxyKey* key = hproxy_keys_get(model->page, row, i);
            int32_t x = KEYS_X + key->slot * KEY_W;
            int32_t w = key->slots * KEY_W - 1;
            bool selected = row == model->row && i == model->index;
            canvas_set_color(canvas, ColorBlack);
            if(selected) {
                canvas_draw_box(canvas, x, top, (size_t)w, KEY_H);
                canvas_set_color(canvas, ColorWhite);
            }
            switch(key->kind) {
            case HproxyKeyChar:
                canvas_draw_glyph(canvas, x + 2, top + 7, (uint16_t)hproxy_keys_char(key, model->caps));
                break;
            case HproxyKeySpace:
                draw_space(canvas, x, top, w);
                break;
            case HproxyKeyShift:
                draw_shift(canvas, x, top, model->caps);
                break;
            case HproxyKeyPage:
                draw_word(canvas, x, top, w, model->page == HproxyKeysLetters ? "#+" : "abc");
                break;
            case HproxyKeyDelete:
                draw_delete(canvas, x, top, w);
                break;
            case HproxyKeyDone:
                draw_word(canvas, x, top, w, "OK");
                break;
            }
        }
    }
    canvas_set_color(canvas, ColorBlack);
}

static bool keyboard_input(InputEvent* event, void* context) {
    Keyboard* keyboard = context;
    if(event->key == InputKeyBack) return false; /* the app leaves the keyboard */
    bool shortish = event->type == InputTypeShort;
    bool held = event->type == InputTypeLong;
    bool again = event->type == InputTypeRepeat;
    if(!shortish && !held && !again) return true;

    bool submit = false;
    char text[KEYBOARD_TEXT_MAX];
    with_view_model(
        keyboard->view,
        KeyboardModel * model,
        {
            model->message[0] = '\0';
            switch(event->key) {
            case InputKeyUp:
                hproxy_keys_move(model->page, &model->row, &model->index, 0, -1);
                break;
            case InputKeyDown:
                hproxy_keys_move(model->page, &model->row, &model->index, 0, 1);
                break;
            case InputKeyLeft:
                hproxy_keys_move(model->page, &model->row, &model->index, -1, 0);
                break;
            case InputKeyRight:
                hproxy_keys_move(model->page, &model->row, &model->index, 1, 0);
                break;
            case InputKeyOk: {
                const HproxyKey* key = hproxy_keys_get(model->page, model->row, model->index);
                size_t len = strlen(model->text);
                switch(key->kind) {
                case HproxyKeyChar:
                case HproxyKeySpace: {
                    if(again) break;
                    /* Held: the other case, once. */
                    char c = hproxy_keys_char(key, model->caps != held);
                    if(c && len < model->max) {
                        model->text[len] = c;
                        model->text[len + 1] = '\0';
                    }
                    break;
                }
                case HproxyKeyShift:
                    if(shortish) model->caps = !model->caps;
                    break;
                case HproxyKeyPage:
                    if(shortish) {
                        HproxyKeysPage to = model->page == HproxyKeysLetters ? HproxyKeysSymbols :
                                                                               HproxyKeysLetters;
                        model->index = hproxy_keys_same_place(model->page, to, model->row, model->index);
                        model->page = to;
                    }
                    break;
                case HproxyKeyDelete:
                    /* Held, it keeps deleting. */
                    if(len) model->text[len - 1] = '\0';
                    break;
                case HproxyKeyDone:
                    if(shortish) {
                        submit = true;
                        memcpy(text, model->text, sizeof(text));
                    }
                    break;
                }
                break;
            }
            default:
                break;
            }
        },
        true);

    if(submit) {
        /* Outside the model's lock: the callbacks switch screens. */
        const char* problem = keyboard->check ? keyboard->check(keyboard->context, text) : NULL;
        if(problem) {
            with_view_model(
                keyboard->view,
                KeyboardModel * model,
                { snprintf(model->message, sizeof(model->message), "%s", problem); },
                true);
        } else if(keyboard->done) {
            keyboard->done(keyboard->context, text);
        }
    }
    return true;
}

Keyboard* keyboard_alloc(void) {
    Keyboard* keyboard = malloc(sizeof(Keyboard));
    memset(keyboard, 0, sizeof(Keyboard));
    keyboard->view = view_alloc();
    view_set_context(keyboard->view, keyboard);
    view_allocate_model(keyboard->view, ViewModelTypeLocking, sizeof(KeyboardModel));
    view_set_draw_callback(keyboard->view, keyboard_draw);
    view_set_input_callback(keyboard->view, keyboard_input);
    with_view_model(
        keyboard->view, KeyboardModel * model, { memset(model, 0, sizeof(*model)); }, false);
    return keyboard;
}

void keyboard_free(Keyboard* keyboard) {
    view_free(keyboard->view);
    free(keyboard);
}

View* keyboard_get_view(Keyboard* keyboard) {
    return keyboard->view;
}

void keyboard_setup(
    Keyboard* keyboard,
    const char* header,
    const char* text,
    size_t max,
    KeyboardCheck check,
    KeyboardDone done,
    void* context) {
    keyboard->check = check;
    keyboard->done = done;
    keyboard->context = context;
    with_view_model(
        keyboard->view,
        KeyboardModel * model,
        {
            snprintf(model->header, sizeof(model->header), "%s", header ? header : "");
            model->max = max < KEYBOARD_TEXT_MAX ? max : KEYBOARD_TEXT_MAX - 1;
            snprintf(model->text, model->max + 1, "%s", text ? text : "");
            model->page = HproxyKeysLetters;
            model->row = 0;
            model->index = 0;
            model->caps = false;
            model->message[0] = '\0';
        },
        true);
}

void keyboard_text(Keyboard* keyboard, char* out, size_t size) {
    if(!out || size == 0) return;
    with_view_model(
        keyboard->view, KeyboardModel * model, { snprintf(out, size, "%s", model->text); }, false);
}
