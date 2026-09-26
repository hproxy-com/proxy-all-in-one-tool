/* ============================================================
   The app's UI library.

   The language is LOOK D (2026-09-23, chosen on the design
   page): filled surfaces with no borders, and every control you can
   press carrying the H's corners (round where the crossbar is
   round, square where it meets the stems). White by default, dark
   one click away; colour only on judgements; every control presses
   and springs back (lib/press.ts). It replaced the pass that copied
   unfx's pills and tinted rows. The rules live in
   src/styles/globals.css as `ux-*` classes; these components are
   the only things that apply them.

   THE LAW
     The author supplies VALUES. The component owns every visual
     decision. No component accepts a `className`.

   Everything is exported from here so a screen imports one path.
   ============================================================ */

export { Card, type CardProps, type CardTone, type CardPad } from "./Card";
export { Button, ButtonGroup, type ButtonProps, type ButtonVariant, type ButtonSize } from "./Button";
export { Dropdown, type DropdownItem, type DropdownProps } from "./Dropdown";
export { Tag, Counter, Pair, Status, type TagProps, type Tone } from "./Badge";
export { Tile, Dot, Flag, type TileProps } from "./Tile";
export { Icon } from "./Icon";
export { Chip, type ChipProps } from "./Chip";
export { PageHead, type PageHeadProps } from "./PageHead";
export { Switch, type SwitchProps } from "./Switch";
export {
  Block,
  BlockTitle,
  Check,
  Input,
  Range,
  TextArea,
  type BlockProps,
  type CheckProps,
  type InputProps,
  type RangeProps,
} from "./Controls";
export { cx } from "./tokens";
