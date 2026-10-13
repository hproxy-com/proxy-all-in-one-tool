/* How a computer's page gives way to the next (a phone moves its pages with
   lib/phone.ts): the new one comes in from the side of the tab you pressed,
   on the Glide curve, while the blue pill above it slides there. The page
   moves, nothing fades. The quiet setting of Windows keeps it still.

   Used for the pages (App.tsx), Proxies' own parts (ProxiesPage.tsx) and
   Settings' sections, which come in from above or below as their list runs
   (Settings.tsx). */

const GLIDE = "cubic-bezier(0.2, 0.9, 0.1, 1)";

export type From = "left" | "right" | "up" | "down";

export function slideIn(page: HTMLElement | null, from: From): void {
  if (!page || typeof page.animate !== "function") return;
  if (typeof matchMedia === "function" && matchMedia("(prefers-reduced-motion: reduce)").matches) return;
  const shift =
    from === "right" ? "translateX(44px)" : from === "left" ? "translateX(-44px)" : from === "down" ? "translateY(28px)" : "translateY(-28px)";
  page.animate([{ transform: shift }, { transform: "none" }], { duration: 520, easing: GLIDE });
}
