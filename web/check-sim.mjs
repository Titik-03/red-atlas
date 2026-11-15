// Checks of the trip timeline (src/sim.ts). Run: node check-sim.mjs
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { createServer } from "vite";

const server = await createServer({ server: { middlewareMode: true }, appType: "custom", logLevel: "error" });
try {
  const rt = await server.ssrLoadModule("/src/routes.ts"), sm = await server.ssrLoadModule("/src/sim.ts"), bd = await server.ssrLoadModule("/src/body.ts");
  // Pandolf by hand: W = 75 x 0.3782 = 28.36, L = 60 x 0.3782 = 22.69, V = 0.5 m/s, G = 5 %, eta = 1.1
  const hand = 1.5 * 28.3639 + 2 * (28.3639 + 22.6911) * (22.6911 / 28.3639) ** 2 + 1.1 * (28.3639 + 22.6911) * (1.5 * 0.25 + 0.35 * 0.5 * 5);
  assert.ok(Math.abs(bd.walkingWatts(0.5, 5, 0) - hand) < 0.01, `Pandolf ${bd.walkingWatts(0.5, 5, 0)} vs ${hand}`);
  assert.ok(bd.walkingWatts(0.5, -8, 0) === bd.walkingWatts(0.5, 0, 0) && Math.abs(bd.HR_MAX - 183.5) < 1e-9);
  console.log(`  Pandolf walking power at 0.5 m/s, 5 % grade, firm ground on Mars: ${hand.toFixed(0)} W (hand value matches)`);
  const dir = "public/terrain/jezero", meta = JSON.parse(readFileSync(`${dir}/meta.json`, "utf8"));
  const raw = readFileSync(`${dir}/${meta.heightmap.file}`);
  const t = { meta, heights: new Float32Array(raw.buffer, raw.byteOffset, raw.byteLength / 4), thermal: {} };
  assert.ok(Math.abs(rt.speedAt("foot", 0) - rt.TRAVEL.foot.speedKmh / 3.6) < 1e-12);
  assert.ok(Math.abs(rt.speedAt("rover", rt.TRAVEL.rover.maxSlopeDeg) - rt.TRAVEL.rover.speedKmh / 7.2) < 1e-12);
  for (const [a, b] of [[{ x: 200, y: -300 }, { x: -1300, y: 900 }], [{ x: 200, y: -300 }, { x: 650, y: 150 }]]) {
    const trip = rt.planRoutes(t, null, a, b), r = trip.routes[0], tl = sm.buildTimeline(r, trip.mode), p = r.points;
    assert.ok(Math.abs(tl.outS - r.minutes * 60) < 1e-6, "outbound time = route time");
    assert.ok(Math.abs(tl.totalS - (2 * tl.outS + sm.WORK_MIN[trip.mode] * 60)) < 1e-9);
    const s0 = sm.stateAt(tl, 0), s1 = sm.stateAt(tl, tl.outS + 1), s2 = sm.stateAt(tl, tl.totalS);
    assert.ok(Math.hypot(s0.x - a.x, s0.y - a.y) < 1e-6 && s0.phase === "out");
    assert.ok(Math.hypot(s1.x - b.x, s1.y - b.y) < 1e-6 && s1.phase === "work" && s1.speed === 0);
    assert.ok(Math.hypot(s2.x - a.x, s2.y - a.y) < 1e-6 && s2.phase === "done");
    let last = -1, worst = 0, maxV = 0;
    for (let i = 0; i <= 2000; i++) {
      const s = sm.stateAt(tl, (i / 2000) * tl.totalS);
      assert.ok(s.travelled >= last - 1e-6, "distance never goes back"); last = s.travelled;
      assert.ok(Math.abs(Math.hypot(s.hx, s.hy) - 1) < 1e-9);
      let dmin = Infinity;                     // distance to the route polyline
      for (let k = 1; k < p.length; k++) {
        const ux = p[k][0] - p[k - 1][0], uy = p[k][1] - p[k - 1][1], f = Math.min(1, Math.max(0, ((s.x - p[k - 1][0]) * ux + (s.y - p[k - 1][1]) * uy) / (ux * ux + uy * uy || 1)));
        dmin = Math.min(dmin, Math.hypot(s.x - p[k - 1][0] - f * ux, s.y - p[k - 1][1] - f * uy));
      }
      worst = Math.max(worst, dmin); maxV = Math.max(maxV, s.speed);
    }
    assert.ok(worst < 1e-6, `crew leaves the route by ${worst} m`);
    assert.ok(maxV <= rt.TRAVEL[trip.mode].speedKmh / 3.6 + 1e-9);
    assert.ok(Math.abs(last - 2 * r.profile.d.at(-1)) < 1e-6);
    // Body monitor: deterministic, bounded, and consistent with its own formulas.
    const log = bd.buildVitals(tl), log2 = bd.buildVitals(tl), end = log.rows.at(-1);
    assert.equal(JSON.stringify(log.rows.map((v) => [v.bpm, v.kcal, v.dustLoad])), JSON.stringify(log2.rows.map((v) => [v.bpm, v.kcal, v.dustLoad])));
    let e = 0;
    for (let i = 1; i < log.rows.length; i++) {
      const v = log.rows[i], q = log.rows[i - 1];
      assert.ok(v.bpm >= bd.CREW.restBpm - 1e-9 && v.bpm <= bd.HR_MAX + 1e-9 && v.kcal >= q.kcal && v.dustLoad >= q.dustLoad && v.doseMsv >= q.doseMsv);
      assert.ok(v.stress >= 0 && v.stress <= 1 && v.fatigue >= 0 && v.fatigue <= 1);
      e += v.watts * (v.t - q.t);
    }
    assert.ok(Math.abs(e / 4184 - end.kcal) < 1e-6 * e, "energy = integral of power");
    assert.ok(Math.abs(end.o2Litres - (end.kcal * 4184) / 20900) < 1e-6);
    const outsideS = log.rows.filter((v, i) => i && v.outside).reduce((a, v, i, arr) => a + log.dt, 0);
    assert.ok(Math.abs(end.doseMsv - 0.67 * outsideS / 86400) < 0.67 * 2 * log.dt / 86400);
    console.log(`    body: mean ${(e / tl.totalS).toFixed(0)} W, peak ${log.peakBpm.toFixed(0)} bpm, ${end.kcal.toFixed(0)} kcal, ${end.o2Litres.toFixed(0)} L O2, dose ${(end.doseMsv * 1000).toFixed(1)} microSv, dust load ${(end.dustLoad * 100).toFixed(0)}%, fatigue ${(end.fatigue * 100).toFixed(0)}%`);
    console.log(`  ${trip.mode}: out ${(tl.outS / 60).toFixed(1)} min, work ${sm.WORK_MIN[trip.mode]} min, total ${(tl.totalS / 60).toFixed(1)} min; always on the route, ${last.toFixed(0)} m covered`);
  }
  console.log("Trip timeline checks passed.");
} finally {
  await server.close();
}
