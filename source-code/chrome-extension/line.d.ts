/* Types for line.js, the one proxy-line parser in JavaScript. The desktop app
   imports line.js from here (desktop-app/src/lib/checker.ts), so the app, the
   extension and the engine read a list the same way. Not shipped in the
   extension's zip: it is for the app's TypeScript only. */

export type ParsedLine = {
  host: string;
  port: number;
  /** "" when the line carries no login. */
  username: string;
  password: string;
  /** What a scheme prefix or a protocol word said, when there was one. */
  scheme: null | "http" | "socks4" | "socks5";
};

/** Read one proxy line, or say in plain words why it is not one. */
export function parseLine(raw: string): ParsedLine | { error: string };
export function isIPv4(s: string): boolean;
export function isIPv6(s: string): boolean;
export function isHostname(s: string): boolean;
