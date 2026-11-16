// Checks of the trip report and of the lessons it gives to later trips (src/report.ts). Run: node check-report.mjs
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { createServer } from "vite";

const store = new Map();
globalThis.localStorage = { getItem: (k) => store.get(k) ?? null, setItem: (k, v) => void store.set(k, String(v)), removeItem: (k) => void store.delete(k) };
const server = await createServer({ server: { middlewareMode: true }, appType: "custom", logLevel: "error" });
try {
  const rp = await server.ssrLoadModule("/src/report.ts"), rt = await server.ssrLoadModule("/src/routes.ts");
  const bd = await server.ssrLoadModule("/src/body.ts"), sm = await server.ssrLoadModule("/src/sim.ts"), wb = await server.ssrLoadModule("/src/walkback.ts");
  const dir = "public/terrain/jezero", meta = JSON.parse(readFileSync(`${dir}/meta.json`, "utf8"));
  const raw = readFileSync(`${dir}/${meta.heightmap.file}`), heights = new Float32Array(raw.buffer, raw.byteOffset, raw.byteLength / 4);
  const t = { meta, heights, thermal: {} }, base = { x: 200, y: -300 }, to = { x: -1300, y: 900 }, tank = wb.tankLitres(4);
  const trip = rt.planRoutes(t, null, base, to), route = trip.routes[0];
  assert.ok(route, trip.error ?? "a route exists");
  const tl = sm.buildTimeline(route, trip.mode), log = bd.buildVitals(tl), end = log.rows.at(-1);
  const make = (outcome, when, emergency = null, legs = [{ log, until: tl.totalS }]) => rp.buildReport({ site: "jezero", mode: trip.mode, route: "A", outcome, legs,
    planLog: log, planDistanceM: route.lengthM * 2, tank, target: [to.x, to.y], alternatives: [{ route: "A", kcal: end.kcal }], when, emergency });

  // 1. The report's totals are the body log's totals: nothing is invented on the way.
  const now = new Date("2026-11-15T10:00:00Z"), r = make("safe", now);
  const near = (a, b, what) => assert.ok(Math.abs(a - b) <= 1e-9 * Math.max(1, Math.abs(b)), `${what}: ${a} vs ${b}`);
  near(r.numbers.kcal, end.kcal, "energy"); near(r.numbers.o2Used, end.o2Litres, "oxygen"); near(r.numbers.doseMsv, end.doseMsv, "radiation");
  near(r.numbers.dust, end.dustLoad, "dust"); near(r.numbers.peakBpm, log.peakBpm, "highest heart rate");
  near(r.numbers.suitLeft, Math.max(0, 1 - end.suitO2 / tank), "suit oxygen left");
  assert.ok(Math.abs(r.numbers.minutes * 60 - tl.totalS) <= log.dt, "trip time"); assert.ok(Math.abs(r.numbers.distanceM - 2 * route.lengthM) < 0.02 * route.lengthM, "distance = out and back");
  near(r.plan.kcal, r.numbers.kcal, "an untroubled trip goes as planned");
  assert.ok(r.lessons.length >= 3 && r.lessons.length <= 6 && r.headline.startsWith("Back safe"));
  console.log(`  report totals equal the body log: ${Math.round(r.numbers.kcal)} kcal, ${r.numbers.o2Used.toFixed(0)} L oxygen, ${Math.round(r.numbers.peakBpm)} beats/min, ${r.lessons.length} lessons`);

  // 2. A trip cut short reports only what was really done, and two legs add up.
  const half = make("ended", now, null, [{ log, until: tl.outS / 2 }]), cut = bd.vitalsAt(log, tl.outS / 2);
  assert.ok(half.numbers.kcal <= cut.kcal + 1e-9 && half.numbers.kcal < r.numbers.kcal * 0.6 && half.numbers.distanceM < route.lengthM * 0.6);
  const two = make("walked", now, { title: "x", message: "y", fix: "z", at: [cut.state.x, cut.state.y], options: [] }, [{ log, until: tl.outS / 2 }, { log, until: tl.outS / 2 }]);
  assert.ok(Math.abs(two.numbers.minutes * 60 - tl.outS) <= log.dt, "two legs: time adds up (to one 5 s step)"); near(two.numbers.distanceM, 2 * half.numbers.distanceM, "two legs: distance adds up");

  // 3. Saved and loaded back unchanged; the log keeps the newest 30; clearing empties it.
  rp.saveReport("jezero", r);
  assert.deepEqual(rp.loadReports("jezero"), [JSON.parse(JSON.stringify(r))]);
  assert.deepEqual(rp.loadReports("gale"), []);
  for (let i = 0; i < 40; i++) rp.saveReport("jezero", { ...r, id: `${i}` });
  assert.equal(rp.loadReports("jezero").length, 30); assert.equal(rp.loadReports("jezero").at(-1).id, "39");
  rp.clearReports("jezero"); assert.deepEqual(rp.loadReports("jezero"), []);
  store.set("red-atlas-trips:jezero", "{broken"); assert.deepEqual(rp.loadReports("jezero"), []); store.clear();
  console.log("  a report is saved and read back identical; broken storage gives an empty log, not a crash");

  // 4. Lessons move the next plan in the stated direction, and without them the plan is the old one.
  const les = (reports, at = now, rested = null) => { const l = rp.lessonsFrom(reports, at, rested); return { l, rl: { ...rp.LESSON_RULES, known: l.known, trouble: l.trouble, slopeBoost: l.slopeBoost } }; };
  const plain = rt.planRoutes(t, null, base, to), again = rt.planRoutes(t, null, base, to, undefined, [], undefined);
  assert.deepEqual(again.routes[0].points, plain.routes[0].points);
  const empty = les([]); assert.equal(empty.l.count, 0); assert.equal(empty.l.carry, null);
  assert.deepEqual(rt.planRoutes(t, null, base, to, undefined, [], empty.rl).routes[0].points, plain.routes[0].points, "no reports: same plan");
  // 4a. Known ground: the same route gets cheaper (by at most the stated 15 %), never dearer.
  const safe = les([r]), known = rt.planRoutes(t, null, base, to, undefined, [], safe.rl).routes[0];
  assert.ok(known.cost < plain.routes[0].cost && known.cost >= plain.routes[0].cost * rp.LESSON_RULES.knownFactor - 1e-6, `known ground ${known.cost} vs ${plain.routes[0].cost}`);
  // 4b. Trouble spot in the middle of route A: the new best route keeps away from it.
  const mid = plain.routes[0].points[Math.floor(plain.routes[0].points.length / 2)], spot = [mid[0], mid[1]];
  const bad = { ...r, outcome: "walked", alerts: [], emergency: { title: "Rover cannot drive", message: "", fix: "", at: spot, options: [] } };
  const hurt = les([bad]); assert.deepEqual(hurt.l.trouble, [spot]); assert.equal(hurt.l.known.length, 0, "a failed trip teaches no safe ground");
  const g = rt.buildCostGrid(t, null, base, to), cell = Math.max(g.cellX, g.cellY);
  const gap = (route) => Math.min(...route.points.map((p) => Math.hypot(p[0] - spot[0], p[1] - spot[1])));
  const avoided = rt.planRoutes(t, null, base, to, undefined, [], hurt.rl).routes;
  const best = avoided.reduce((a, b) => (gap(b) > gap(a) ? b : a));
  assert.ok(gap(plain.routes[0]) < cell, "the spot is on the old route");
  assert.ok(avoided[0].cost >= plain.routes[0].cost - 1e-6, "a trouble spot never makes the plan cheaper");
  assert.ok(gap(best) > cell, `a route avoiding the trouble spot is offered (${gap(best).toFixed(0)} m away)`);
  // 4c. Heart ran high: slopes weigh more, so the chosen route is never steeper on average.
  const hot = les([{ ...r, numbers: { ...r.numbers, peakBpm: 0.9 * bd.HR_MAX } }]); assert.equal(hot.l.slopeBoost, rp.LESSON_RULES.slopeBoost);
  const calm = les([{ ...r, numbers: { ...r.numbers, peakBpm: 0.5 * bd.HR_MAX } }]); assert.equal(calm.l.slopeBoost, 0);
  const gentle = rt.planRoutes(t, null, base, to, undefined, [], { ...hot.rl, known: [] }).routes[0];
  assert.ok(gentle.meanSlopeDeg <= plain.routes[0].meanSlopeDeg + 0.05, `slopes ${gentle.meanSlopeDeg} vs ${plain.routes[0].meanSlopeDeg}`);
  console.log(`  lessons: known ground -${((1 - known.cost / plain.routes[0].cost) * 100).toFixed(0)}% risk; trouble spot avoided by ${gap(best).toFixed(0)} m; mean slope ${plain.routes[0].meanSlopeDeg.toFixed(1)}° > ${gentle.meanSlopeDeg.toFixed(1)}° after a hard trip`);

  // 5. Tiredness, dust and radiation carry over the same day only, and stop after a rest.
  const same = les([r], new Date("2026-11-15T15:00:00Z")).l, next = les([r], new Date("2026-11-16T09:00:00Z")).l;
  near(same.carry.kcal, r.numbers.kcal, "carried energy"); near(same.carry.doseMsv, r.numbers.doseMsv, "carried radiation"); assert.equal(next.carry, null);
  assert.equal(les([r], new Date("2026-11-15T15:00:00Z"), "2026-11-15T12:00:00.000Z").l.carry, null, "a rest clears the carry-over");
  const tired = bd.buildVitals(tl, 5, { kcal: same.carry.kcal, dustLoad: same.carry.dustLoad, doseMsv: same.carry.doseMsv }).rows.at(-1);
  near(tired.kcal, 2 * end.kcal, "second trip of the day starts from the first one's energy"); assert.ok(tired.fatigue > end.fatigue && tired.doseMsv > end.doseMsv);
  console.log(`  carry-over: a second trip the same day ends at ${Math.round(tired.fatigue * 100)}% tired instead of ${Math.round(end.fatigue * 100)}%; next day or after a rest it starts fresh`);
  console.log("Report checks passed");
} finally { await server.close(); }
