/* ============================================================
   The press: every control gives way under the finger and springs
   back, with a light from exactly where it was pressed.

   Every control answers a press with a short animation.
   One listener on the document serves the whole app. It only sets
   three things on the pressed control; the look is the "Pressing"
   block in styles/globals.css:

     --px / --py    where the pointer went down, for the light
     data-press     "down" while held, "up" for the spring back
     data-ripple    present while the light spreads

   Attributes, not classes: React rewrites the class list of a
   control whose click changes state (a tab, a tick box), which cut
   the spring and the light off in the design lab. React leaves
   attributes it did not render alone.
   ============================================================ */

const PRESSABLE = ".ux-btn, .ux-seg-btn, .ux-iconbtn, .ux-tab, .ux-chip, .ux-menuitem, .ux-check, .ux-row, .ux-switch, .ux-dest, .bg-choice, .ux-hface, .ux-hswitch";

let started = false;

export function startPress(root: Document = document): void {
  if (started) return;
  started = true;

  root.addEventListener("pointerdown", (e: PointerEvent) => {
    if (e.button !== 0) return;
    const target = (e.target as Element | null)?.closest<HTMLElement>(PRESSABLE);
    if (!target || (target as HTMLButtonElement).disabled) return;

    const box = target.getBoundingClientRect();
    target.style.setProperty("--px", `${e.clientX - box.left}px`);
    target.style.setProperty("--py", `${e.clientY - box.top}px`);
    delete target.dataset.ripple;
    void target.offsetWidth; // restart the light when pressed again mid-way
    target.dataset.press = "down";
    target.dataset.ripple = "";
    window.setTimeout(() => delete target.dataset.ripple, 700);

    const up = () => {
      target.dataset.press = "up";
      window.setTimeout(() => {
        if (target.dataset.press === "up") delete target.dataset.press;
      }, 620);
      window.removeEventListener("pointerup", up);
      window.removeEventListener("pointercancel", up);
    };
    window.addEventListener("pointerup", up);
    window.addEventListener("pointercancel", up);
  });
}
