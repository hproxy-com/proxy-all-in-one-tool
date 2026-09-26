import { memo } from "react";
import { COUNTRY_CELLS, GRID, LABELS, OTHER_LAND } from "./worldDots";

/* The Map look's picture (lib/look.ts): every land cell of the world as a dot,
   the country you appear in drawn again on top in bigger dots (globals.css
   lights it once the connection is up), and a ring where that country's name
   sits, so a country too small for a dot of its own (Singapore, Malta) still
   shows. It has a strip of its own in the card, between the address and the
   route: under the words it read as noise, and its ring landed on them.

   One path per layer instead of 1,858 circles, and memo on the country: the
   card re-renders every second for the uptime, and this never needs to. */

/** A dot's radius, in cells: the land, and the lit country. */
const R_LAND = 0.32;
const R_HERE = 0.4;
/** The rows shown: the far Arctic (above 78° north) is left out. */
const FIRST_ROW = 2;

function cellsOf(list: string): number[] {
  return list ? list.split(",").map((c) => parseInt(c, 36)) : [];
}

/** Every cell as a small circle, all in one path. */
function dotsPath(cells: number[], r: number): string {
  let d = "";
  for (const cell of cells) {
    const x = (cell % GRID.cols) + 0.5 - r;
    const y = Math.floor(cell / GRID.cols) + 0.5;
    d += `M${x.toFixed(2)} ${y}a${r} ${r} 0 1 0 ${2 * r} 0a${r} ${r} 0 1 0 ${-2 * r} 0`;
  }
  return d;
}

let land: string | null = null;
function landPath(): string {
  land ??= dotsPath([...Object.values(COUNTRY_CELLS).flatMap(cellsOf), ...cellsOf(OTHER_LAND)], R_LAND);
  return land;
}

const countries = new Map<string, string>();
function countryPath(cc: string): string {
  let d = countries.get(cc);
  if (d === undefined) {
    d = dotsPath(cellsOf(COUNTRY_CELLS[cc] ?? ""), R_HERE);
    countries.set(cc, d);
  }
  return d;
}

function DotMap({ cc }: { cc?: string }) {
  const code = cc?.toLowerCase();
  const label = code ? LABELS[code] : undefined;
  return (
    <svg
      className="ux-map"
      viewBox={`0 ${FIRST_ROW} ${GRID.cols} ${GRID.rows - FIRST_ROW}`}
      preserveAspectRatio="xMidYMid meet"
      aria-hidden="true"
    >
      <path className="land" d={landPath()} />
      {code && <path className="here" d={countryPath(code)} />}
      {label && (
        <g className="pin" transform={`translate(${label[0]} ${label[1]})`}>
          <circle className="ring" r="1.7" />
          <circle className="dot" r="0.6" />
        </g>
      )}
    </svg>
  );
}

export default memo(DotMap);
