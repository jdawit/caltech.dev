#!/usr/bin/env node
// Regenerates src/data/IndexedTotal<TERM>.json from the registrar's schedule page.
//
//   node scripts/scrape-schedule.mjs FA2026-27            # fetch from schedules.caltech.edu
//   node scripts/scrape-schedule.mjs FA2026-27 page.html  # parse a saved copy instead
//
// Schedule fields (sections, times, locations, instructors, units, notes) come
// from the registrar page. Fields the page doesn't have (description, TQFR
// rating/link, ...) and course ids are carried over from the existing JSON so
// saved workspaces and enrichment data survive a refresh.

import { readFileSync, writeFileSync, existsSync } from "node:fs";

const [term, localFile] = process.argv.slice(2);
if (!/^(FA|WI|SP)\d{4}-\d{2}$/.test(term ?? "")) {
  console.error(
    "usage: scrape-schedule.mjs <TERM e.g. FA2026-27> [saved.html]",
  );
  process.exit(1);
}
const outPath = new URL(
  `../src/data/IndexedTotal${term}.json`,
  import.meta.url,
);

const html = localFile
  ? readFileSync(localFile, "latin1")
  : await (async () => {
      const res = await fetch(`https://schedules.caltech.edu/${term}.html`);
      if (!res.ok) throw new Error(`fetch failed: ${res.status}`);
      return res.text();
    })();

// ---------------------------------------------------------------------------
// 1. Layout -> lines of positioned text.
// The page is an Oracle Reports export: hundreds of small fixed-width tables
// whose first row declares column widths. A cell's meaning is given by its
// x offset, so rebuild each table's grid (honouring colspan/rowspan) and emit
// every row that has text as [{ x, text }].

const decode = (s) =>
  s
    .replace(/<br\s*\/?>/gi, " ")
    .replace(/<[^>]+>/g, "")
    .replace(/&nbsp;/g, " ")
    .replace(/&amp;/g, "&")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/\s+/g, " ")
    .trim();

function layoutLines(html) {
  const lines = [];
  for (const table of html.split(/<table/i).slice(1)) {
    const [widthRow, ...rows] = table.split(/<tr/i).slice(1);
    if (!widthRow) continue;
    const xs = [0];
    for (const m of widthRow.matchAll(/<td[^>]*width=(\d+)/gi)) {
      xs.push(xs[xs.length - 1] + Number(m[1]));
    }
    const occupied = new Set(); // "row,col" cells covered by an earlier rowspan
    rows.forEach((row, r) => {
      let col = 0;
      const line = [];
      for (const m of row.matchAll(/<td([^>]*)>([\s\S]*?)<\/td>/gi)) {
        while (occupied.has(`${r},${col}`)) col++;
        const cs = Number(m[1].match(/colspan=(\d+)/i)?.[1] ?? 1);
        const rs = Number(m[1].match(/rowspan=(\d+)/i)?.[1] ?? 1);
        for (let a = 0; a < rs; a++)
          for (let b = 0; b < cs; b++) occupied.add(`${r + a},${col + b}`);
        const text = decode(m[2]);
        if (text) line.push({ x: xs[col], text });
        col += cs;
      }
      if (line.length) lines.push(line);
    });
  }
  return lines;
}

// ---------------------------------------------------------------------------
// 2. Lines -> courses.
// Column offsets (px) measured from the page.

const COURSE_NUMBER = /^[A-Za-z/]+ ?\d+ ?[A-Za-z]*$/;
const UNITS = /^(\d+(\.\d+)?-\d+(\.\d+)?-\d+(\.\d+)?|\+)$/;

const COL = {
  dept: 12,
  number: 98, // course number on header rows, 2-digit section on section rows
  units: 228, // units on header rows, instructor on section rows
  title: 314, // title on header rows, then free-text notes
  time: 483,
  location: 627,
  grade: 754,
};

// "Ma 001 A" -> "Ma 1 a", "ACM080A" -> "ACM 80 a", "BEM113" -> "BEM 113"
function normalizeNumber(raw) {
  const m = raw.match(/^([A-Za-z/]+?)\s*0*(\d+)\s*([A-Za-z]*)$/);
  if (!m) return raw;
  const [, dept, num, suffix] = m;
  return suffix ? `${dept} ${num} ${suffix.toLowerCase()}` : `${dept} ${num}`;
}

// "4-0-5" -> [4, 0, 5]; "+" (variable units) -> [0, 0, 0] as the app expects
function parseUnits(raw) {
  const parts = raw.split("-").map(Number);
  return parts.length === 3 && parts.every((n) => !Number.isNaN(n))
    ? parts
    : [0, 0, 0];
}

function parseCourses(lines) {
  const courses = [];
  let course = null;
  let section = null;

  const at = (line, x) => line.find((c) => c.x === x)?.text;

  for (const line of lines) {
    const first = line[0];

    // Department banner ("AEROSPACE | [Go to top]") or column headings: reset.
    if (first.x <= COL.dept + 20 || at(line, COL.time) === "Days/Time") {
      course = section = null;
      continue;
    }

    const num = at(line, COL.number);

    // Course header: number + units + title. Requiring both to look right
    // skips the repeated "Course Offering | Units" headings and registrar
    // notes typed into the number column ("Do not create more sections").
    if (
      num &&
      COURSE_NUMBER.test(num) &&
      UNITS.test(at(line, COL.units) ?? "")
    ) {
      course = {
        number: normalizeNumber(num),
        name: at(line, COL.title) ?? "",
        units: parseUnits(at(line, COL.units)),
        notes: [],
        sections: [],
      };
      courses.push(course);
      section = null;
      continue;
    }
    if (!course) continue;

    // Section row: "01 | instructor | time | location | grade".
    if (num && /^\d\d$/.test(num)) {
      section = {
        number: Number(num),
        instructor: at(line, COL.units) ?? "",
        times: [],
        locations: [],
        grades: at(line, COL.grade) ?? "",
      };
      course.sections.push(section);
      addMeeting(section, line);
      continue;
    }

    // Any other text in the number column is a note, not data.
    if (num) continue;

    // Free text under the title before any section: course notes.
    if (!section && first.x === COL.title) {
      course.notes.push(line.map((c) => c.text).join(" "));
      continue;
    }

    // Anything else after a section is a continuation of that section:
    // another meeting, or a fragment of a wrapped cell.
    if (section) {
      const more = at(line, COL.units);
      if (more) section.instructor += ` ${more}`; // wrapped instructor list
      addMeeting(section, line);
      if (!section.grades) section.grades = at(line, COL.grade) ?? "";
    }
  }
  return courses;

  function addMeeting(section, line) {
    const time = at(line, COL.time);
    const loc = at(line, COL.location);
    const lastTime = section.times.at(-1);
    if (time && lastTime?.endsWith("-")) {
      // "OM,M 13:00 -" + "13:55": second half of a wrapped time
      section.times[section.times.length - 1] = `${lastTime} ${time}`;
      if (loc) section.locations[section.locations.length - 1] += ` ${loc}`;
    } else if (time) {
      section.times.push(time);
      section.locations.push(loc ?? "");
    } else if (loc && section.locations.length) {
      // "Lecture Hall" + "BAX": second half of a wrapped location
      section.locations[section.locations.length - 1] += ` ${loc}`;
    }
  }
}

// ---------------------------------------------------------------------------
// 3. Merge with the existing JSON and write it out.

const existing = existsSync(outPath)
  ? JSON.parse(readFileSync(outPath, "utf8"))
  : {};
const byNumber = new Map(Object.values(existing).map((c) => [c.number, c]));

// Deterministic id for courses we haven't seen before (FNV-1a, 31-bit).
function newId(number) {
  let h = 0x811c9dc5;
  for (const ch of number) h = Math.imul(h ^ ch.charCodeAt(0), 0x01000193);
  return h >>> 1 || 1;
}

const parsed = parseCourses(layoutLines(html));

// Guard for unattended runs: if the page layout changes, the parser finds few
// or no courses. Refuse to overwrite good data with that.
const oldCount = Object.keys(existing).length;
if (parsed.length === 0 || parsed.length < oldCount * 0.7) {
  console.error(
    `parsed only ${parsed.length} course rows (existing file has ${oldCount}); ` +
      "page layout may have changed, not writing",
  );
  process.exit(1);
}

const out = {};
const counts = { updated: 0, added: 0 };
for (const c of parsed) {
  // Cross-listed courses appear under every department; keep the first.
  if (Object.values(out).some((o) => o.number === c.number)) continue;

  const old = byNumber.get(c.number);
  const comment = c.notes.join(" ");
  const id = old?.id ?? newId(c.number);
  counts[old ? "updated" : "added"]++;
  out[id] = {
    id,
    name: c.name,
    number: c.number,
    sections: c.sections.map((s) => ({
      grades: s.grades,
      instructor: s.instructor,
      // "A" = to be arranged; the app shows a blank location for those
      locations: s.locations.filter((l) => l && l !== "A").join("\n"),
      number: s.number,
      times: s.times.join("\n"),
    })),
    comment,
    units: c.units,
    description: old?.description ?? "",
    prerequisites:
      old?.prerequisites ?? comment.match(/Prerequisites?:\s*(.*)/i)?.[1] ?? "",
    rating: old?.rating ?? "",
    true_units: old?.true_units ?? "",
    link: old?.link ?? "",
  };
}

const dropped = [...byNumber.keys()].filter(
  (n) => !Object.values(out).some((o) => o.number === n),
);
writeFileSync(outPath, JSON.stringify(out, null, 2) + "\n");
console.log(
  `${term}: ${Object.keys(out).length} courses ` +
    `(${counts.updated} updated, ${counts.added} new, ${dropped.length} dropped)`,
);
if (dropped.length) console.log(`dropped: ${dropped.join(", ")}`);
