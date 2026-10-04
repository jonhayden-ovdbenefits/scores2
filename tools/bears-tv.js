#!/usr/bin/env node
/*
 * Bears TV check for the Grand Rapids market.
 *
 * Reads 506sports.com's NFL coverage page for the current week, finds the Bears
 * game and works out whether Grand Rapids gets it. Regional (CBS/FOX Sunday
 * afternoon) games are read off 506's coverage map: the map's colour at Grand
 * Rapids is matched to the colour swatch beside each game. National games
 * (prime time, streaming, London) need no map.
 *
 * Usage: node tools/bears-tv.js [--out bears-tv.json] [--year 2026 --week 4] [--today YYYY-MM-DD]
 * Runs on a schedule from .github/workflows/bears-tv.yml.
 * Needs Playwright with Chromium: 506sports sits behind a Cloudflare check
 * that plain HTTP clients fail, and it sends automated browsers elsewhere.
 */
"use strict";

const fs = require("fs");
const { chromium } = require("playwright");

const SITE = "https://506sports.com";
const TEAM = "Chicago"; // 506 lists teams by city; Chicago is only the Bears
const MARKET = {
  name: "Grand Rapids",
  // "GR" label on 506's 1280x720 base map. Sampled as a box around the label,
  // kept west of the Lansing market and north of South Bend.
  box: { x0: 842, x1: 866, y0: 224, y1: 256 },
  // Lake Michigan just west of Grand Rapids: must read as water, or the base
  // map has moved and the sample can't be trusted.
  water: [[828, 225], [832, 250]],
  stations: { CBS: "WWMT (CBS 3)", FOX: "FOX 17 (WXMI)", NBC: "WOOD TV8", ABC: "WZZM 13" },
  callSigns: /\b(WWMT|WXMI|WOOD|WZZM|WOTV)\b/i,
  updates: /grand rapids/i
};
const STREAMING = /prime video|netflix|youtube|peacock|paramount|amazon/i;

function arg(name) {
  const i = process.argv.indexOf("--" + name);
  return i > 0 ? process.argv[i + 1] : null;
}

function todayET() {
  const p = new Intl.DateTimeFormat("en-CA", { timeZone: "America/Detroit", year: "numeric", month: "2-digit", day: "2-digit" }).format(new Date());
  return p; // YYYY-MM-DD
}

const MONTHS = { jan: 1, feb: 2, mar: 3, apr: 4, may: 5, jun: 6, jul: 7, aug: 8, sep: 9, sept: 9, oct: 10, nov: 11, dec: 12 };

// Pick the week whose Sunday is today or later, counting Monday as part of the
// weekend before (so a Monday night game still finds its week).
function pickWeek(weeks, today) {
  const t = new Date(today + "T12:00:00Z");
  t.setUTCDate(t.getUTCDate() - 1);
  const floor = t.toISOString().slice(0, 10);
  return weeks.find(w => w.date >= floor) || null;
}

async function main() {
  const out = arg("out") || "bears-tv.json";
  const today = arg("today") || todayET();
  const browser = await chromium.launch({ headless: true, args: ["--disable-blink-features=AutomationControlled"] });
  const ctx = await browser.newContext({
    userAgent: "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/140.0.0.0 Safari/537.36",
    viewport: { width: 1280, height: 900 }
  });
  const page = await ctx.newPage();
  await page.addInitScript(() => { Object.defineProperty(navigator, "webdriver", { get: () => undefined }); });

  async function open(url) {
    const resp = await page.goto(url, { waitUntil: "networkidle", timeout: 90000 });
    for (let i = 0; i < 12 && /just a moment/i.test(await page.title()); i++) await page.waitForTimeout(2500);
    if (/just a moment/i.test(await page.title())) throw new Error("Cloudflare check did not clear at " + url);
    if (!resp || resp.status() >= 400) throw new Error("HTTP " + (resp && resp.status()) + " at " + url);
  }

  let result;
  try {
    let year = Number(arg("year")), week = arg("week"), weekDate = null;
    if (!week) {
      const y = Number(today.slice(0, 4)), m = Number(today.slice(5, 7));
      const season = m >= 3 ? y : y - 1;
      await open(`${SITE}/nfl/index-m.php?yr=${season}`);
      const rows = await page.$$eval("a[href*='nfl.php']", as => as.map(a => ({ href: a.getAttribute("href"), text: a.parentElement ? a.parentElement.textContent : "" })));
      const weeks = [];
      rows.forEach(r => {
        const wk = (r.href.match(/wk=(\d+)/) || [])[1];
        const d = r.text.match(/\(([A-Za-z]+)\.?\s+(\d+)\)/);
        if (!wk || !d) return;
        const mo = MONTHS[d[1].toLowerCase().slice(0, 4)] || MONTHS[d[1].toLowerCase().slice(0, 3)];
        if (!mo) return;
        const yr = mo < 3 ? season + 1 : season;
        weeks.push({ week: wk, date: `${yr}-${String(mo).padStart(2, "0")}-${String(d[2]).padStart(2, "0")}` });
      });
      const w = pickWeek(weeks, today);
      if (!w) throw Object.assign(new Error("No upcoming regular-season week listed (offseason or playoffs)."), { status: "no_week" });
      year = season; week = w.week; weekDate = w.date;
    }
    const url = `${SITE}/nfl.php?yr=${year}&wk=${week}`;
    await open(url);

    // Read the page into sections: national games, then one block per map.
    const data = await page.evaluate(async () => {
      const text = el => (el ? el.textContent.replace(/\s+/g, " ").trim() : "");
      const national = Array.from(document.querySelectorAll("[id=cgame]")).map(g => ({
        matchup: text(g.querySelector("[id=cmatchup]")),
        time: text(g.querySelector("[id=ctime]")),
        network: text(g.querySelector("[id=cntwk]")),
        extra: text(g.querySelector("[id=canncrs] font"))
      }));
      const sections = [];
      let cur = null;
      const walker = document.createTreeWalker(document.querySelector("article") || document.body, NodeFilter.SHOW_ELEMENT);
      for (let n = walker.currentNode; n; n = walker.nextNode()) {
        if (n.tagName === "FONT" && n.getAttribute("size") === "5" && !/NATIONAL/i.test(n.textContent)) {
          cur = { title: text(n), map: null, games: [], updates: [] };
          sections.push(cur);
        } else if (cur && n.id === "map") {
          const img = n.querySelector("img");
          if (img) cur.map = img;
        } else if (cur && n.id === "game") {
          const sw = n.querySelector("[id=square] img");
          cur.games.push({ matchup: text(n.querySelector("[id=matchup]")), swatch: sw });
        } else if (cur && n.tagName === "LI" && n.closest("[id=updates]")) {
          cur.updates.push(text(n));
        }
      }
      // Pixels: draw each image onto a canvas (same origin, so readable).
      async function pixels(img) {
        if (!img) return null;
        if (!img.complete) await new Promise(r => { img.onload = img.onerror = r; });
        if (!img.naturalWidth) return null;
        const c = document.createElement("canvas");
        c.width = img.naturalWidth; c.height = img.naturalHeight;
        const g = c.getContext("2d");
        g.drawImage(img, 0, 0);
        return { w: c.width, h: c.height, d: Array.from(g.getImageData(0, 0, c.width, c.height).data), src: img.src };
      }
      function mode(px) {
        const counts = {};
        for (let i = 0; i < px.d.length; i += 4) { const k = px.d[i] + "," + px.d[i + 1] + "," + px.d[i + 2]; counts[k] = (counts[k] || 0) + 1; }
        return Object.keys(counts).sort((a, b) => counts[b] - counts[a])[0].split(",").map(Number);
      }
      for (const s of sections) {
        s.mapPx = await pixels(s.map);
        s.mapSrc = s.map ? s.map.src : null;
        delete s.map;
        for (const g of s.games) {
          const px = await pixels(g.swatch);
          g.color = px ? mode(px) : null;
          delete g.swatch;
        }
      }
      return { national, sections, heading: text(document.querySelector("article h3")), body: text(document.querySelector("article")).slice(0, 8000) };
    });

    result = decide(data, { year, week: Number(week), weekDate, url });
  } catch (e) {
    result = { status: e.status || "error", headline: "Couldn't check Grand Rapids coverage this week.", error: String(e.message || e) };
  } finally {
    await browser.close();
  }

  result = Object.assign({ market: MARKET.name, team: "Chicago Bears", checkedAt: new Date().toISOString() }, result);
  console.log(JSON.stringify(result, null, 2));
  // A failed run leaves the last good result in place.
  if (result.status === "error") process.exitCode = 1;
  else fs.writeFileSync(out, JSON.stringify(result, null, 2) + "\n");
}

function decide(data, meta) {
  const base = { season: meta.year, week: meta.week, weekDate: meta.weekDate || isoFromHeading(data.heading), source: meta.url };

  let nat = data.national.find(g => g.matchup.includes(TEAM));
  if (!nat) {
    // Older page format: "Monday Night: Chicago @ Detroit (ESPN/ABC)".
    const head = data.body.split(/\b(?:CBS|FOX) (?:EARLY|LATE|SINGLE|DOUBLEHEADER)\b/)[0];
    const m = head.match(new RegExp("([A-Z][A-Za-z ]{2,30}?(?:Night|morning[^:]*|afternoon[^:]*)):\\s*([^()]*?" + TEAM + "[^()]*?)\\s*(?:\\(in [^)]*\\)\\s*)?\\(([^);]+)"));
    if (m) nat = { matchup: m[2].trim(), time: m[1].trim(), network: m[3].trim(), extra: "" };
  }
  const byes = (data.body.match(/Byes:\s*([^.]*?)(?=\s+(?:CBS|FOX) (?:EARLY|LATE|SINGLE|DOUBLEHEADER)|$)/) || [])[1] || "";
  if (nat) {
    const streaming = STREAMING.test(nat.network);
    const local = MARKET.callSigns.test(nat.extra);
    const net = nat.network;
    const station = Object.keys(MARKET.stations).find(k => new RegExp("\\b" + k + "\\b").test(net));
    let inMarket = true, headline;
    if (streaming && !local) {
      headline = `National game, streaming only on ${net}. Not on local TV in Grand Rapids.`;
    } else if (station) {
      headline = `National game: on ${MARKET.stations[station]} in Grand Rapids (${net}).`;
    } else {
      headline = `National game on ${net}: on everywhere${/espn|nfln|nfl network/i.test(net) ? " with cable or a live-TV streaming service" : ""}.`;
    }
    return Object.assign(base, { status: "national", game: nat.matchup, network: net, time: nat.time, inMarket, streamingOnly: streaming && !local, headline });
  }

  for (const s of data.sections) {
    const idx = s.games.findIndex(g => g.matchup.includes(TEAM));
    if (idx === -1) continue;
    const bears = s.games[idx];
    const network = (s.title.match(/\b(CBS|FOX)\b/) || [])[1] || s.title;
    const window = /\(LATE\)/i.test(bears.matchup) || /LATE/i.test(s.title) ? "late" : "early";
    const station = MARKET.stations[network] || network;
    const common = { status: "regional", game: bears.matchup.replace(/\s*\(LATE\)\s*/i, ""), network, window, slot: s.title, station, map: s.mapSrc };
    const notes = s.updates.filter(u => MARKET.updates.test(u));
    if (notes.length) common.updates = notes;

    if (!s.mapPx) return Object.assign(base, common, { status: "pending", inMarket: null, headline: `On ${network}, but 506's coverage map isn't posted yet (usually Wednesday).` });

    const read = sample(s.mapPx, s.games);
    if (!read.ok) return Object.assign(base, common, { inMarket: null, confidence: read.share, reason: read.reason, headline: `On ${network}. Couldn't read Grand Rapids on 506's map; check the map.` });

    const gets = s.games[read.index];
    const inMarket = read.index === idx;
    const getsName = gets.matchup.replace(/\s*\(LATE\)\s*/i, "");
    return Object.assign(base, common, {
      inMarket, confidence: read.share, marketGame: getsName,
      headline: inMarket ? `On ${station} in Grand Rapids.` : `Not on in Grand Rapids. ${station} has ${getsName} instead.`
    });
  }

  if (byes.includes(TEAM)) return Object.assign(base, { status: "bye", inMarket: null, headline: "Bears bye week." });
  const posted = data.sections.length > 0;
  if (!posted && /will be posted/i.test(data.body)) return Object.assign(base, { status: "pending", inMarket: null, headline: "506 hasn't posted this week's games yet (usually Wednesday)." });
  return Object.assign(base, { status: "bye", inMarket: null, headline: "No Bears game listed this week (bye week?)." });
}

function sample(px, games) {
  const sx = px.w / 1280, sy = px.h / 720;
  const at = (x, y) => { const i = (Math.round(y * sy) * px.w + Math.round(x * sx)) * 4; return [px.d[i], px.d[i + 1], px.d[i + 2]]; };
  const dist = (a, b) => Math.hypot(a[0] - b[0], a[1] - b[1], a[2] - b[2]);
  const WATER = [209, 240, 255];
  if (!MARKET.water.every(([x, y]) => dist(at(x, y), WATER) < 20)) return { ok: false, reason: "map layout changed (Lake Michigan isn't where expected)", share: 0 };
  const votes = games.map(() => 0);
  let counted = 0;
  const b = MARKET.box;
  for (let x = b.x0; x <= b.x1; x++) for (let y = b.y0; y <= b.y1; y++) {
    const p = at(x, y);
    let best = -1, bd = 1e9;
    games.forEach((g, i) => { if (g.color) { const d = dist(p, g.color); if (d < bd) { bd = d; best = i; } } });
    if (best >= 0 && bd < 30) { votes[best]++; counted++; }
  }
  if (counted < 60) return { ok: false, reason: `too few coloured pixels at Grand Rapids (${counted})`, share: 0 };
  const top = votes.indexOf(Math.max(...votes));
  const share = Math.round((votes[top] / counted) * 100) / 100;
  if (share < 0.85) return { ok: false, reason: `Grand Rapids area is split between games (${share * 100}% for the leader)`, share };
  return { ok: true, index: top, share };
}

function isoFromHeading(h) {
  const d = new Date(h);
  return isNaN(d) ? null : d.toISOString().slice(0, 10);
}

main();
