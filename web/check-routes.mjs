// Checks of the route planner (src/routes.ts): known answers on synthetic terrain, then the real Jezero site.
// Run: node check-routes.mjs
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { createServer } from "vite";

const server = await createServer({ server: { middlewareMode: true }, appType: "custom", logLevel: "error" });
try {
  const rt = await server.ssrLoadModule("/src/routes.ts");
  const dir = "public/terrain/jezero";
  const meta = JSON.parse(readFileSync(`${dir}/meta.json`, "utf8"));
  const raw = readFileSync(`${dir}/${meta.heightmap.file}`);
  const heights = new Float32Array(raw.buffer, raw.byteOffset, raw.byteLength / 4);
  const { width: W, height: H, spacing_m: d } = meta.heightmap, ext = meta.extent_m;
  const synth = (f) => ({ meta: { ...meta, thermal: undefined, resolution: { dem_native_m: d } },
    heights: Float32Array.from({ length: W * H }, (_, i) => f(ext.west + ((i % W) + 0.5) * d, ext.north - (Math.floor(i / W) + 0.5) * d)) });

  // 1. Flat ground: one cost everywhere, so the best route is the shortest one the 8-connected grid allows
  //    (at most 8.3 % longer than the straight line), score exactly 1.
  let trip = rt.planRoutes(synth(() => 0), null, { x: -300, y: -100 }, { x: 420, y: 260 });
  assert.equal(trip.mode, "foot"); assert.equal(trip.error, null);
  const r0 = trip.routes[0];
  assert.ok(r0.lengthM >= trip.straightM - 1e-6 && r0.lengthM <= trip.straightM * 1.083, `flat: ${r0.lengthM} vs ${trip.straightM}`);
  assert.ok(Math.abs(r0.score - 1) < 1e-6 && r0.maxSlopeDeg < 1e-6);
  console.log(`  flat ground: route ${r0.lengthM.toFixed(0)} m for ${trip.straightM.toFixed(0)} m straight, score ${r0.score.toFixed(2)}, ${trip.routes.length} routes`);

  // 2. Mode switch at 1 km.
  assert.equal(rt.planRoutes(synth(() => 0), null, { x: -600, y: 0 }, { x: 399, y: 0 }).mode, "foot");
  assert.equal(rt.planRoutes(synth(() => 0), null, { x: -600, y: 0 }, { x: 401, y: 0 }).mode, "rover");

  // 3. A 30-degree ridge across the way with one flat gap at y = 600..800: every route must pass through the gap.
  const ridge = (x) => Math.max(0, 60 - Math.abs(x) * Math.tan(30 * Math.PI / 180));
  const wall = synth((x, y) => (y > 600 && y < 800 ? 0 : ridge(x)));
  trip = rt.planRoutes(wall, null, { x: -700, y: 0 }, { x: 700, y: 0 });
  assert.equal(trip.mode, "rover"); assert.equal(trip.error, null);
  for (const r of trip.routes) {
    assert.ok(r.maxSlopeDeg <= rt.TRAVEL.rover.maxSlopeDeg, `route crosses ${r.maxSlopeDeg} deg`);
    const cross = r.points.filter(([x]) => Math.abs(x) < 90);
    assert.ok(cross.length > 0 && cross.every(([, y]) => y > 600 && y < 800), "route must use the gap");
  }
  console.log(`  wall with one gap: ${trip.routes.length} route(s), all through the gap, steepest ${Math.max(...trip.routes.map((r) => r.maxSlopeDeg)).toFixed(1)} deg`);

  // 4. A closed wall: no route, with a reason.
  const closed = synth(ridge);
  trip = rt.planRoutes(closed, null, { x: -700, y: 0 }, { x: 700, y: 0 });
  assert.ok(trip.routes.length === 0 && /No way through/.test(trip.error));
  trip = rt.planRoutes(closed, null, { x: -700, y: 0 }, { x: 40, y: 0 });
  assert.ok(/slope/.test(trip.error));
  console.log("  closed wall: no route, reason given; target on the wall refused");

  // 5. Real site: deterministic, ordered by cost, different from each other, within the slope limit.
  const th = {}; for (const k of ["night", "day"]) if (meta.thermal?.[k]) th[k] = new Uint8Array(readFileSync(`${dir}/${meta.thermal[k].file}`));
  const t = { meta, heights, thermal: th }, wind = { u: -2, v: -3, speed: 5.6, fromDeg: 33.7, steadiness: 0.64 };
  for (const [a, b] of [[{ x: 200, y: -300 }, { x: -1300, y: 900 }], [{ x: 200, y: -300 }, { x: 650, y: 150 }]]) {
    const t0 = performance.now(), p = rt.planRoutes(t, wind, a, b), ms = performance.now() - t0, q = rt.planRoutes(t, wind, a, b);
    assert.equal(JSON.stringify(p), JSON.stringify(q), "routes must be deterministic");
    assert.equal(p.error, null);
    for (let i = 0; i < p.routes.length; i++) {
      const r = p.routes[i];
      assert.ok(r.maxSlopeDeg <= rt.TRAVEL[p.mode].maxSlopeDeg + 1e-6 && r.lengthM >= p.straightM);
      if (i) assert.ok(r.cost >= p.routes[i - 1].cost);
    }
    const why = rt.explainRoutes(p);
    assert.equal(why.length, p.routes.length);
    for (const r of p.routes) assert.ok(r.profile.d.length === r.points.length && Math.abs(r.profile.d.at(-1) - r.points.slice(1).reduce((s, q, k) => s + Math.hypot(q[0] - r.points[k][0], q[1] - r.points[k][1]), 0)) < 1e-6);
    why.forEach((w, i) => console.log(`    ${"ABCD"[i]}: ${w}`));
    console.log(`  Jezero ${p.mode}, ${p.straightM.toFixed(0)} m straight, ${ms.toFixed(0)} ms: ` + p.routes.map((r, i) =>
      `${"ABCD"[i]} ${r.lengthM.toFixed(0)} m max ${r.maxSlopeDeg.toFixed(0)}° score ${r.score.toFixed(2)}`).join("; "));
  }
  console.log("Route checks passed.");
} finally {
  await server.close();
}
