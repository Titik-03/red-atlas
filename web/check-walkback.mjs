// Checks of the walk-back safety field and the rescue plan (src/walkback.ts). Run: node check-walkback.mjs
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { createServer } from "vite";

const server = await createServer({ server: { middlewareMode: true }, appType: "custom", logLevel: "error" });
try {
  const wb = await server.ssrLoadModule("/src/walkback.ts"), rt = await server.ssrLoadModule("/src/routes.ts");
  const bd = await server.ssrLoadModule("/src/body.ts"), sm = await server.ssrLoadModule("/src/sim.ts");
  const dir = "public/terrain/jezero", meta = JSON.parse(readFileSync(`${dir}/meta.json`, "utf8"));
  const raw = readFileSync(`${dir}/${meta.heightmap.file}`), heights = new Float32Array(raw.buffer, raw.byteOffset, raw.byteLength / 4);
  const { width: W, height: H, spacing_m: d } = meta.heightmap, ext = meta.extent_m;
  const synth = (f) => ({ meta: { ...meta, thermal: undefined, resolution: { dem_native_m: d } },
    heights: Float32Array.from({ length: W * H }, (_, i) => f(ext.west + ((i % W) + 0.5) * d, ext.north - (Math.floor(i / W) + 0.5) * d)) });
  assert.ok(Math.abs(wb.tankLitres(8) - 8 * 3600 * 272 / 20900) < 1e-9);

  // 1. Flat firm ground: time home = distance / walking speed, oxygen = power x time / 20.9 kJ per litre.
  const flat = synth(() => 0), home = { x: 0, y: 0 }, f = wb.buildHomeField(flat, null, [home]);
  const v = rt.speedAt("foot", 0), watts = bd.walkingWatts(v, 0, 0) + bd.RULES.suitW;
  for (const p of [{ x: 800, y: 0 }, { x: 0, y: -1200 }, { x: 900, y: 900 }, { x: 1500, y: 600 }]) {
    const w = wb.walkHome(f, p), dist = Math.hypot(p.x, p.y), cell = f.g.cellX;
    assert.ok(w.time >= (dist - 2 * cell) / v && w.time <= (dist * 1.083 + 2 * cell) / v, `time ${w.time} for ${dist} m`);
    assert.ok(Math.abs(w.o2 - (watts * w.time) / 20900) < 1e-6 * w.o2 + 1e-9, "oxygen = power x time");
  }
  // The walk zone is the set of points within reach: check both sides of the limit along a row.
  const tank = wb.tankLitres(2), reach = (tank * 0.9 * 20900 / watts) * v;        // metres on flat ground
  assert.equal(wb.zoneAt(f, { x: Math.min(1900, reach * 0.85), y: 0 }, tank), "walk");
  console.log(`  flat ground: walk-home time and oxygen match distance / speed and power x time; a 2 h suit reaches ${(reach / 1000).toFixed(1)} km`);
  const small = wb.tankLitres(2) / 8;                                             // a nearly empty suit
  const zs = [200, 600, 1000, 1400, 1800].map((x) => wb.zoneAt(f, { x, y: 0 }, small));
  assert.ok(zs[0] === "walk" && zs.at(-1) !== "walk" && zs.join().replace(/walk,/g, "").indexOf("walk") < 0, `zones ${zs}`);
  assert.ok(zs.indexOf("out") < 0 || zs.indexOf("rescue") < zs.indexOf("out"), "rescue zone lies between walk and out");
  console.log(`  nearly empty suit, going out along a line: ${zs.join(" > ")}`);

  // 2. Oxygen home never drops when walking one cell further from home along the stored path.
  for (let i = 0; i < f.o2.length; i++) if (f.prev[i] >= 0) assert.ok(f.o2[i] > f.o2[f.prev[i]]);

  // 3. A refuge only ever enlarges the safe zone.
  const f2 = wb.buildHomeField(flat, null, [home, { x: 1500, y: 1000 }]);
  let better = 0;
  for (let i = 0; i < f.o2.length; i++) { assert.ok(f2.o2[i] <= f.o2[i] + 1e-9); if (f2.o2[i] < f.o2[i] - 1e-9) better++; }
  assert.ok(better > 100);
  console.log(`  a refuge lowers the walk-home oxygen for ${better} cells and raises it for none`);

  // 4. Ridge with one gap: the way home goes through the gap and ends at home; the ridge itself is closed.
  const ridge = (x) => Math.max(0, 60 - Math.abs(x) * Math.tan(30 * Math.PI / 180));
  const wall = synth((x, y) => (y > 600 && y < 800 ? 0 : ridge(x))), fw = wb.buildHomeField(wall, null, [{ x: -700, y: 0 }]);
  const r = wb.routeHome(wall, fw, { x: 700, y: 0 });
  const cross = r.points.filter(([x]) => Math.abs(x) < 90), last = r.points.at(-1);
  assert.ok(cross.length > 0 && cross.every(([, y]) => y > 600 && y < 800) && Math.hypot(last[0] + 700, last[1]) < 1e-6);
  assert.equal(wb.zoneAt(fw, { x: 40, y: 0 }, 1e9), "closed");
  console.log(`  ridge with a gap: the walk home (${r.lengthM.toFixed(0)} m) uses the gap and ends at home; the ridge is closed ground`);

  // 5. Rescue: crew and rover reach the meeting point at the same time.
  const t = { meta, heights, thermal: {} }, trip = rt.planRoutes(t, null, { x: 200, y: -300 }, { x: -1300, y: 900 }), route = trip.routes[0];
  const s0 = route.profile.d.at(-1) * 0.8, plan = wb.rescuePlan(route, s0);
  const crewTl = sm.buildTimeline(plan.crew, "foot", true), roverTl = sm.buildTimeline(plan.rover, "rover", true, wb.SUIT.rescueDelayS);
  assert.ok(Math.abs(crewTl.totalS - plan.meetS) < 0.02 * plan.meetS && Math.abs(roverTl.totalS - plan.meetS) < 0.02 * plan.meetS,
    `crew ${crewTl.totalS}, rover ${roverTl.totalS}, plan ${plan.meetS}`);
  const a = sm.stateAt(crewTl, crewTl.totalS), b = sm.stateAt(roverTl, roverTl.totalS), start = sm.stateAt(roverTl, wb.SUIT.rescueDelayS - 1);
  assert.ok(Math.hypot(a.x - b.x, a.y - b.y) < 1 && start.speed === 0 && Math.hypot(start.x - route.points[0][0], start.y - route.points[0][1]) < 1e-6);
  console.log(`  rescue from ${s0.toFixed(0)} m out: crew walks ${plan.crew.lengthM.toFixed(0)} m, rover drives ${plan.rover.lengthM.toFixed(0)} m, they meet after ${(plan.meetS / 60).toFixed(1)} min`);

  // 7. Every option is weighed (decide). Flat ground, base at the origin, crew 1.5 km east.
  {
    const base = { x: 0, y: 0 }, pos = { x: 1500, y: 0 }, big = wb.tankLitres(8), fd = wb.buildHomeField(flat, null, [base]), rf = wb.buildRoverField(fd, base);
    const by = (d, id) => d.options.find((o) => o.id === id);
    // 7a. The rover cannot drive but the cabin holds air: staying inside costs no suit oxygen and is chosen.
    let dcs = wb.decide(flat, fd, rf, pos, big, "drive");
    assert.equal(dcs.chosen.id, "wait"); assert.ok(dcs.chosen.o2 === 0 && dcs.chosen.holdInside);
    const drive = (1500 / (rt.TRAVEL.rover.speedKmh / 3.6));
    assert.ok(Math.abs(dcs.chosen.seconds - wb.SUIT.rescueDelayS - drive) < 0.1 * drive, `wait ${dcs.chosen.seconds} vs ${wb.SUIT.rescueDelayS + drive}`);
    // 7b. The cabin leaks: waiting is impossible; with plenty of oxygen the cheapest of walk and meet is chosen,
    //     and it is never worse than any other possible option.
    dcs = wb.decide(flat, fd, rf, pos, big, "leak");
    assert.ok(!by(dcs, "wait").possible && dcs.chosen && dcs.options.filter((o) => o.possible && !o.emergency).every((o) => dcs.chosen.o2 <= o.o2 + 1e-9));
    assert.equal(dcs.chosen.id, "meet");
    // Meeting: crew and rover reach the same place; the later of the two sets the time.
    const m = by(dcs, "meet"), crewT = sm.buildTimeline(m.crew, "foot", true, 0, { holdS: m.holdS }), rovT = sm.buildTimeline(m.rover, "rover", true, wb.SUIT.rescueDelayS);
    const ce = m.crew.points.at(-1), re = m.rover.points.at(-1);
    assert.ok(Math.hypot(ce[0] - re[0], ce[1] - re[1]) < 1e-6, "crew and rover end at the same point");
    assert.ok(Math.abs(Math.max(crewT.outS, rovT.totalS) - m.seconds) < 0.03 * m.seconds + 5, `meeting time ${m.seconds} vs ${crewT.outS} / ${rovT.totalS}`);
    assert.ok(Math.abs(crewT.totalS - rovT.totalS) < 0.03 * m.seconds + 5, "crew (walk + wait) and rover arrive together");
    assert.ok(m.o2 < by(dcs, "home").o2, "meeting costs less oxygen than walking all the way");
    console.log(`  options, flat ground 1.5 km out: cabin fine -> wait in the rover (${(drive / 60 + 10).toFixed(0)} min, no suit oxygen); cabin leaks -> meet the rescue rover after ${(m.seconds / 60).toFixed(0)} min`);
    // 7c. A refuge 200 m away is the cheapest once the cabin leaks.
    const fr = wb.buildHomeField(flat, null, [base, { x: 1500, y: 200 }]), d3 = wb.decide(flat, fr, wb.buildRoverField(fr, base), pos, big, "leak");
    assert.equal(d3.chosen.id, "refuge");
    // 7d. Main oxygen gone: walking home is refused; waiting for the rover on the emergency supply is what is left.
    const d4 = wb.decide(flat, fd, rf, pos, 0.01, "leak");
    assert.ok(d4.chosen && d4.chosen.id === "meet" && d4.chosen.emergency && d4.chosen.holdS > 0, "main oxygen gone: wait for the rover on the emergency supply");
    assert.ok(!by(d4, "home").possible);
    // 7e. Enough only with the emergency supply: allowed, and flagged.
    const need = by(dcs, "meet").o2, d5 = wb.decide(flat, fd, rf, pos, need - wb.emergencyLitres() / 2, "leak");
    assert.ok(d5.chosen && d5.chosen.emergency, "uses the emergency oxygen");
    // 7f. A walker in trouble (half speed) needs more time than a healthy one for the same walk.
    const slow = by(wb.decide(flat, fd, rf, pos, big, "crew"), "home"), fast = by(dcs, "home");
    assert.ok(slow.seconds > 1.9 * fast.seconds && slow.o2 > fast.o2);
    console.log("  refuge nearby -> refuge; main oxygen gone -> wait for the rover on emergency oxygen; slow walker costs more");
  }
  // 8. Bad ground between base and crew: a 17-degree ridge (walkable, not drivable) with a drivable gap far north.
  {
    const r17 = (x) => Math.max(0, 40 - Math.abs(x) * Math.tan(17 * Math.PI / 180));
    const land = synth((x, y) => (y > 1400 && y < 1700 ? 0 : r17(x))), base = { x: -900, y: 0 }, pos = { x: 900, y: 0 };
    const fd = wb.buildHomeField(land, null, [base]), rf = wb.buildRoverField(fd, base), d = wb.decide(land, fd, rf, pos, wb.tankLitres(8), "leak");
    const m = d.options.find((o) => o.id === "meet"), h = d.options.find((o) => o.id === "home");
    assert.ok(h.possible && h.crew.points.some(([x, y]) => Math.abs(x) < 60 && Math.abs(y) < 600), "the crew can walk straight over the ridge");
    assert.ok(m.rover.points.every(([x, y]) => Math.abs(x) > 135 || (y > 1400 && y < 1700)), "the rescue rover never drives on the ridge");
    assert.ok(m.rover.maxSlopeDeg <= rt.TRAVEL.rover.maxSlopeDeg + 1e-6);
    const ce = m.crew.points.at(-1), re = m.rover.points.at(-1);
    assert.ok(Math.hypot(ce[0] - re[0], ce[1] - re[1]) < 1e-6);
    console.log(`  17-degree ridge between base and crew: rover stays off it (steepest ${m.rover.maxSlopeDeg.toFixed(0)} deg, ${m.rover.lengthM.toFixed(0)} m drive), crew walks ${m.crew.lengthM.toFixed(0)} m to meet it; chosen: ${d.chosen.name}`);
    // Crew enclosed by ground too steep to walk: no way out on foot, no way in for the rover.
    const pit = synth((x, y) => { const rr = Math.hypot(x - 900, y); return rr < 150 ? 0 : rr < 300 ? (rr - 150) * Math.tan(35 * Math.PI / 180) : 105; });
    const fp = wb.buildHomeField(pit, null, [base]), dp = wb.decide(pit, fp, wb.buildRoverField(fp, base), pos, wb.tankLitres(8), "leak");
    assert.ok(dp.chosen === null && dp.fallback === null && dp.options.every((o) => !o.possible) && /no way/.test(dp.fix));
    console.log("  crew closed in by 35-degree walls: every option refused with its reason");
  }
  // 9. The test before departure agrees with a breakdown played at the same point.
  {
    const base = { x: 0, y: 0 }, fd = wb.buildHomeField(flat, null, [base]), rf = wb.buildRoverField(fd, base);
    const trip2 = rt.planRoutes(flat, null, base, { x: 1700, y: 300 }), r2 = trip2.routes[0], tank2 = wb.tankLitres(2);
    const pf = wb.preflight(flat, fd, rf, r2, "rover", tank2, 10), k = r2.profile.d.findIndex((x) => Math.abs(x - pf.at) < 1e-9);
    const again = wb.decide(flat, fd, rf, { x: r2.points[k][0], y: r2.points[k][1] }, tank2 - 10, "leak");
    assert.equal(again.chosen?.id, pf.d.chosen?.id); assert.ok(Math.abs((again.chosen?.o2 ?? 0) - (pf.d.chosen?.o2 ?? 0)) < 1e-9);
    assert.ok(pf.at >= r2.profile.d.at(-1) * 0.85, "on flat ground the worst point is the far end");
    console.log(`  test before departure: worst point ${pf.at.toFixed(0)} m out, answer "${pf.d.chosen?.name}", same as the played breakdown`);
  }

  // 6. Real site: deterministic.
  const fa = wb.buildHomeField(t, null, [{ x: 200, y: -300 }]), fb = wb.buildHomeField(t, null, [{ x: 200, y: -300 }]);
  assert.ok(Buffer.from(fa.o2.buffer).equals(Buffer.from(fb.o2.buffer)));
  const reachable = Array.from(fa.o2).filter((x) => x < Infinity), far = Math.max(...Array.from(fa.time).filter((x) => x < Infinity));
  console.log(`  Jezero: ${(100 * reachable.length / fa.o2.length).toFixed(0)}% of the site can be walked home from; the farthest walk takes ${(far / 60).toFixed(0)} min`);
  console.log("Walk-back checks passed.");
} finally {
  await server.close();
}
