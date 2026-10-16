// Unit checks for facts with validity windows (src/facts.ts, src/memory.ts): no server, no vault. Run after `npm run build`.
import { deriveFacts, endOf, factKey, parseWhen, showEnd, statusAt } from "../dist/facts.js";
import { blockFields, parseMemoryBlocks } from "../dist/memory.js";

let failures = 0;
const check = (label, ok, detail = "") => {
  console.log(`${ok ? "PASS" : "FAIL"}  ${label}${detail ? "  — " + detail : ""}`);
  if (!ok) failures++;
};
const derive = (md) => deriveFacts(parseMemoryBlocks(md));
const byId = (facts) => Object.fromEntries(facts.map((f) => [f.id, f]));

// ---------------------------------------------------------------- dates
check("bare date is the start of the day", parseWhen("2026-10-20") === "2026-10-20T00:00:00Z");
check("bare end date holds through the day", parseWhen("2026-10-20", true) === "2026-10-21T00:00:00Z");
check("date and time is UTC", parseWhen("2026-10-20 09:05") === "2026-10-20T09:05:00Z");
check("offset is converted to UTC", parseWhen("2026-10-20T10:00+05:30") === "2026-10-20T04:30:00Z");
check("impossible date refused", parseWhen("2026-02-30") === null && parseWhen("2026-13-01") === null && parseWhen("2026-10-20 24:00") === null);
check("free text refused", parseWhen("next tuesday") === null && parseWhen("") === null);
check("end of month rolls over", parseWhen("2026-01-31", true) === "2026-02-01T00:00:00Z");
check("midnight end reads as through the day before", showEnd("2026-02-01T00:00:00Z") === "through 2026-01-31");
check("other end times read as until", showEnd("2026-02-01T09:30:00Z") === "until 2026-02-01 09:30");
check("keys ignore case and spacing", factKey("JobMail ", "Database") === factKey("jobmail", "  database") && factKey("x", null) === null);

// ---------------------------------------------------------------- block fields
const fields = blockFields(
  ["The app uses Postgres.", "", "**Why:** SQLite locked.", "", "**Key:** the app / database", "", "**Valid from:** 2026-10-01", "", "**Replaces:** 2026-09-22 18:21, 2026-09-22 18:21 #2", "", "*via mcp:stdio:test*"].join("\n"),
);
check("fact text excludes labelled lines", fields.fact === "The app uses Postgres.", JSON.stringify(fields.fact));
check("key splits into subject and attribute", fields.subject === "the app" && fields.attribute === "database");
check("replaces reads every id, numbered ones too", fields.replaces.join("|") === "2026-09-22 18:21|2026-09-22 18:21 #2");
check("via is read", fields.via === "mcp:stdio:test");
check("legacy Supersedes counts as Replaces", blockFields("New.\n\n**Supersedes:** 2026-09-22 18:21 · project").replaces[0] === "2026-09-22 18:21");
check("subject may contain a slash", blockFields("x\n\n**Key:** a / b / c").subject === "a / b" && blockFields("x\n\n**Key:** a / b / c").attribute === "c");

// ---------------------------------------------------------------- ids
const dupes = parseMemoryBlocks("## 2026-09-22 18:21 · project\n\nOne.\n\n## 2026-09-22 18:21 · project\n\nTwo.\n\n## 2026-09-22 18:21 · user\n\nThree.");
check("repeated stamps get numbered ids", dupes.map((b) => b.id).join("|") === "2026-09-22 18:21|2026-09-22 18:21 #2|2026-09-22 18:21 #3");

// ---------------------------------------------------------------- windows
const md = [
  "# Memory",
  "",
  "## 2026-09-01 10:00 · project",
  "",
  "The app uses SQLite.",
  "",
  "## 2026-10-16 09:00 · project",
  "",
  "The app uses Postgres.",
  "",
  "**Valid from:** 2026-10-01",
  "",
  "**Replaces:** 2026-09-01 10:00",
  "",
  "## 2026-10-16 09:05 · user",
  "",
  "Travelling, answers slowly.",
  "",
  "**Valid until:** 2026-10-20",
  "",
  "## 2026-10-16 09:10 · project",
  "",
  "From November the app moves to Neon.",
  "",
  "**Valid from:** 2026-11-01",
  "",
  "**Replaces:** 2026-10-16 09:00",
].join("\n");
const { facts, warnings } = derive(md);
const f = byId(facts);
check("no warnings for a clean file", warnings.length === 0, warnings.join("; "));
check("replaced fact ends when the replacement starts", f["2026-09-01 10:00"].replacedAt === "2026-10-01T00:00:00Z" && f["2026-09-01 10:00"].replacedBy === "2026-10-16 09:00");
check("backdated start is honoured", f["2026-10-16 09:00"].validFrom === "2026-10-01T00:00:00Z");
check("status before the switch", statusAt(f["2026-09-01 10:00"], "2026-09-15T00:00:00Z") === "current" && statusAt(f["2026-10-16 09:00"], "2026-09-15T00:00:00Z") === "upcoming");
check("status after the switch", statusAt(f["2026-09-01 10:00"], "2026-10-05T00:00:00Z") === "replaced" && statusAt(f["2026-10-16 09:00"], "2026-10-05T00:00:00Z") === "current");
check("temporary fact holds through its last day", statusAt(f["2026-10-16 09:05"], "2026-10-20T23:59:59Z") === "current" && statusAt(f["2026-10-16 09:05"], "2026-10-21T00:00:00Z") === "expired");
check("a scheduled replacement keeps the current fact until it starts", statusAt(f["2026-10-16 09:00"], "2026-10-31T12:00:00Z") === "current" && statusAt(f["2026-10-16 09:00"], "2026-11-01T00:00:00Z") === "replaced");
check("endOf picks the scheduled replacement", endOf(f["2026-10-16 09:00"]) === "2026-11-01T00:00:00Z");
const trueOn = (at) => facts.filter((x) => statusAt(x, at) === "current").map((x) => x.id).join("|");
check("as of mid-September", trueOn("2026-09-15T00:00:00Z") === "2026-09-01 10:00");
check("as of mid-October", trueOn("2026-10-18T00:00:00Z") === "2026-10-16 09:00|2026-10-16 09:05");
check("as of December", trueOn("2026-12-01T00:00:00Z") === "2026-10-16 09:10");

// expired then replaced: whichever ended first decides the status
const both = byId(derive("## 2026-01-01 00:00 · user\n\nA.\n\n**Valid until:** 2026-01-10\n\n## 2026-02-01 00:00 · user\n\nB.\n\n**Replaces:** 2026-01-01 00:00").facts);
check("an earlier expiry wins over a later replacement", statusAt(both["2026-01-01 00:00"], "2026-03-01T00:00:00Z") === "expired");

// ---------------------------------------------------------------- bad references
const bad = derive(
  [
    "## 2026-01-01 00:00 · project",
    "",
    "First.",
    "",
    "**Replaces:** 2026-01-02 00:00",
    "",
    "## 2026-01-02 00:00 · project",
    "",
    "Second.",
    "",
    "**Replaces:** 1999-01-01 00:00",
    "",
    "## 2026-01-03 00:00 · project",
    "",
    "Third.",
    "",
    "**Replaces:** 2026-01-01 00:00",
    "",
    "## 2026-01-04 00:00 · project",
    "",
    "Fourth.",
    "",
    "**Replaces:** 2026-01-01 00:00",
    "",
    "**Valid until:** someday",
  ].join("\n"),
);
const b = byId(bad.facts);
check("a later fact cannot be replaced", b["2026-01-02 00:00"].replacedBy === null && bad.warnings.some((w) => w.includes("not an earlier fact")));
check("an unknown id is reported", bad.warnings.some((w) => w.includes("1999-01-01 00:00") && w.includes("no fact has that id")));
check("the first replacement wins", b["2026-01-01 00:00"].replacedBy === "2026-01-03 00:00" && bad.warnings.some((w) => w.includes("already replaced")));
check("an unreadable date is reported and ignored", b["2026-01-04 00:00"].validUntil === null && bad.warnings.some((w) => w.includes("someday")));

// ---------------------------------------------------------------- old files
const legacy = derive("## 2026-09-12 19:40 · feedback\n\nUse uv.\n\n**Why:** reasons.\n\n*via mcp:stdio:ines*");
check("a fact with no new lines is current from its stamp", legacy.facts[0].validFrom === "2026-09-12T19:40:00Z" && statusAt(legacy.facts[0], "2030-01-01T00:00:00Z") === "current");

console.log(failures ? `\n${failures} check(s) failed` : "\nall checks passed");
process.exit(failures ? 1 : 0);
