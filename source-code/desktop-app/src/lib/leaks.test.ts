import { describe, expect, it } from "vitest";
import { dnsRow, languageRow, localeCountry, offsetMinutes, timezoneRow, webrtcRow } from "./leaks";
import type { LeakResolver } from "./tauri";

const google = (cc: string): LeakResolver => ({ ip: "198.51.100.53", country_code: cc, asn_org: "Google LLC" });

describe("the DNS row", () => {
  it("says it is checking until the test answers", () => {
    expect(dnsRow(null, "DE")).toMatchObject({ tone: "mute", headline: "Checking which resolver the proxy uses…" });
  });

  it("names the resolver and its country, and passes when it matches the exit", () => {
    expect(dnsRow({ state: "seen", resolvers: [google("DE")] }, "DE")).toMatchObject({
      tone: "ok",
      headline: "Looked up by Google LLC in Germany, like your exit",
    });
  });

  it("warns when the resolver sits in another country than the exit", () => {
    const row = dnsRow({ state: "seen", resolvers: [google("DE")] }, "NL");
    expect(row.tone).toBe("warn");
    expect(row.headline).toBe("Looked up by Google LLC in Germany; your exit is in the Netherlands");
  });

  it("names two networks and counts the rest", () => {
    const resolvers: LeakResolver[] = [
      { ip: "192.0.2.1", country_code: "US", asn_org: "Google LLC" },
      { ip: "192.0.2.2", country_code: "US", asn_org: "Google LLC" },
      { ip: "192.0.2.3", country_code: "US", asn_org: "Cloudflare, Inc." },
      { ip: "192.0.2.4", country_code: "US", asn_org: "Quad9" },
      { ip: "192.0.2.5", country_code: "US", asn_org: null },
    ];
    expect(dnsRow({ state: "seen", resolvers }, "US").headline).toBe("Looked up by Google LLC, Cloudflare, Inc. and 2 more in the United States, like your exit");
  });

  it("never claims a resolver it did not see, and says why", () => {
    const off = dnsRow({ state: "unavailable", why: "the leak test is not switched on" }, "DE");
    expect(off).toMatchObject({ tone: "ok", headline: "Site names go to the proxy" });
    expect(off.detail).toContain("could not be measured: the leak test is not switched on.");
    const quiet = dnsRow({ state: "not_seen" }, "DE");
    expect(quiet.headline).toBe("Site names go to the proxy");
    expect(quiet.detail).toContain("did not look up our test name");
  });
});

describe("the WebRTC row", () => {
  it("warns everywhere, and names the fix only where there is one", () => {
    expect(webrtcRow(false)).toMatchObject({ tone: "warn", headline: "Browsers can show your real address" });
    expect(webrtcRow(false).detail).toContain("HProxy extension");
    expect(webrtcRow(false).actions).toEqual([{ id: "extension", label: "Get the extension" }]);
    expect(webrtcRow(true).detail).not.toContain("extension");
    expect(webrtcRow(true).actions).toBeUndefined();
  });
});

describe("the time zone row", () => {
  const summer = new Date("2026-07-01T12:00:00Z");

  it("reads a zone's offset from UTC", () => {
    expect(offsetMinutes("Europe/Berlin", summer)).toBe(120);
    expect(offsetMinutes("America/Chicago", summer)).toBe(-300);
    expect(offsetMinutes("UTC", summer)).toBe(0);
    expect(offsetMinutes("Asia/Kolkata", summer)).toBe(330);
    expect(offsetMinutes("Not/AZone", summer)).toBeNull();
  });

  it("passes the same zone, and the same time under another name", () => {
    expect(timezoneRow("Europe/Berlin", "Europe/Berlin", summer)).toMatchObject({ tone: "ok", headline: "Europe/Berlin, like your exit" });
    expect(timezoneRow("Europe/Berlin", "Europe/Paris", summer)).toMatchObject({
      tone: "ok",
      headline: "Europe/Berlin, the same time as your exit (Europe/Paris)",
    });
  });

  it("warns when the clock shows another time than the exit's place", () => {
    const row = timezoneRow("Europe/Berlin", "America/Chicago", summer);
    expect(row).toMatchObject({ tone: "warn", headline: "Your clock: Europe/Berlin · your exit: America/Chicago" });
  });

  it("says so when the exit's zone is not known", () => {
    expect(timezoneRow("Europe/Berlin", null, summer)).toMatchObject({ tone: "mute", headline: "Europe/Berlin" });
  });

  const off = { supported: true, matching: false, automatic: false };
  const on = { ...off, matching: true };
  const set = (agoMs: number) => ({ ...on, matched: "Central Standard Time", matched_at_ms: summer.getTime() - agoMs });

  it("offers the match where this computer can make it, and only there", () => {
    const row = timezoneRow("Europe/Berlin", "America/Chicago", summer, off);
    expect(row.tone).toBe("warn");
    expect(row.detail).toContain("put yours back after");
    expect(row.actions).toEqual([{ id: "match_zone", label: "Match it while connected" }]);
    // A phone, a Mac, Linux: the advice, no button.
    expect(timezoneRow("Europe/Berlin", "America/Chicago", summer, { ...off, supported: false }).actions).toBeUndefined();
  });

  it("waits while the zone is set and browsers catch up", () => {
    expect(timezoneRow("Europe/Berlin", "America/Chicago", summer, on)).toMatchObject({ tone: "mute" });
    expect(timezoneRow("Europe/Berlin", "America/Chicago", summer, set(3_000))).toMatchObject({ tone: "mute" });
  });

  it("says the clock shows the exit's time until the disconnect", () => {
    expect(timezoneRow("America/Chicago", "America/Chicago", summer, set(3_000))).toMatchObject({
      tone: "ok",
      headline: "America/Chicago, set to your exit's until you disconnect",
    });
  });

  it("names Windows' automatic time zone when it put its own back", () => {
    const row = timezoneRow("Europe/Berlin", "America/Chicago", summer, { ...set(60_000), automatic: true });
    expect(row.tone).toBe("warn");
    expect(row.detail).toContain('"Set time zone automatically" is on');
    expect(row.actions?.map((a) => a.id)).toEqual(["match_zone_again", "date_time_settings"]);
    const byHand = timezoneRow("Europe/Berlin", "America/Chicago", summer, set(60_000));
    expect(byHand.detail).toBe("The time zone was changed again after it was matched.");
    expect(byHand.actions?.map((a) => a.id)).toEqual(["match_zone_again"]);
  });

  it("says why a match failed, and offers another try", () => {
    const row = timezoneRow("Europe/Berlin", "America/Chicago", summer, { ...on, problem: "Windows refused the time zone change (access denied)" });
    expect(row).toMatchObject({ tone: "warn", detail: "The time zone could not be matched: Windows refused the time zone change (access denied)." });
    expect(row.actions).toEqual([{ id: "match_zone_again", label: "Try again" }]);
  });
});

describe("the language row", () => {
  it("reads the country of a language tag", () => {
    expect(localeCountry("de-DE")).toBe("DE");
    expect(localeCountry("en_us")).toBe("US");
    expect(localeCountry("en")).toBeNull();
  });

  it("passes a first language of the exit's country, warns about another", () => {
    expect(languageRow(["en-US", "en"], "US")).toMatchObject({ tone: "ok", headline: "en-US, en, like your exit" });
    const row = languageRow(["de-DE", "de", "en"], "US");
    expect(row).toMatchObject({ tone: "warn", headline: "de-DE, de, en · your exit is in the United States" });
    expect(row.detail).toBe(
      "Browsers ask sites for de-DE pages first, and sites can compare that with your address. Putting your exit's language first in your browser's language settings hides it.",
    );
  });

  it("judges by the first language: the exit's further down does not pass", () => {
    expect(languageRow(["de-DE", "de", "en-US"], "US").tone).toBe("warn");
  });

  it("has nothing to say when the first language names no country", () => {
    expect(languageRow(["en", "de"], "US").tone).toBe("mute");
    expect(languageRow(["en", "de-DE"], "US").tone).toBe("mute");
    expect(languageRow([], "US").headline).toBe("none");
  });
});
