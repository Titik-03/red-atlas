// Site filters check: the colours painted on a 3D site must be the values the data really holds.
//  1. Elevation and slope textures vs values recomputed here, independently, from the raw heightmap.bin.
//  2. Regional values (ice, dust, temperature, wind) on the site == the globe grid cell at the same lat/lon.
// Usage: node check-site-filters.mjs
import assert from "node:assert/strict";
import { readFileSync, existsSync } from "node:fs";
import { createServer } from "vite";

const server = await createServer({ server: { middlewareMode: true }, appType: "custom", logLevel: "error" });
try {
  const sf = await server.ssrLoadModule("/src/siteFilters.ts");
  const gd = await server.ssrLoadModule("/src/globeData.ts");
  const dir = "public/terrain/jezero";
  const meta = JSON.parse(readFileSync(`${dir}/meta.json`, "utf8"));
  const raw = readFileSync(`${dir}/${meta.heightmap.file}`);
  const heights = new Float32Array(raw.buffer, raw.byteOffset, raw.byteLength / 4);
  const t = { meta, heights };
  const { width: W, height: H, spacing_m: d } = meta.heightmap, ext = meta.extent_m;
  assert.equal(heights.length, W * H);

  // Independent bilinear sampler written from the file layout (row 0 = north, values at cell centres).
  const elevAt = (x, y) => {
    const c = (x - ext.west) / d - 0.5, r = (ext.north - y) / d - 0.5;
    const c0 = Math.floor(c), r0 = Math.floor(r), fc = c - c0, fr = r - r0;
    const g = (rr, cc) => heights[rr * W + cc];
    return g(r0, c0) * (1 - fc) * (1 - fr) + g(r0, c0 + 1) * fc * (1 - fr) + g(r0 + 1, c0) * (1 - fc) * fr + g(r0 + 1, c0 + 1) * fc * fr;
  };
  const hex = (c) => [1, 3, 5].map((i) => parseInt(c.slice(i, i + 2), 16));
  const colourAt = (legend, f) => {
    const p = Math.min(1, Math.max(0, f)) * (legend.length - 1), i = Math.min(legend.length - 2, Math.floor(p)), k = p - i;
    const a = hex(legend[i]), b = hex(legend[i + 1]);
    return a.map((v, j) => v * (1 - k) + b[j] * k);
  };
  for (const id of ["elev", "slope"]) {
    const { layer, rgba, size } = sf.buildSiteLayer(t, id, null);
    assert.ok(layer.local && layer.max > layer.min);
    let worst = 0, n = 0;
    for (let k = 0; k < 4000; k++) {
      const r = 8 + Math.floor(((k * 7919) % 1000) / 1000 * (size - 16)), c = 8 + Math.floor(((k * 104729) % 1000) / 1000 * (size - 16));
      const x = ext.west + ((c + 0.5) / size) * (ext.east - ext.west), y = ext.south + ((r + 0.5) / size) * (ext.north - ext.south);
      let v;
      if (id === "elev") v = elevAt(x, y);
      else {
        const b = Math.max(meta.resolution.dem_native_m, d);
        v = Math.atan(Math.hypot((elevAt(x + b / 2, y) - elevAt(x - b / 2, y)) / b, (elevAt(x, y + b / 2) - elevAt(x, y - b / 2)) / b)) * 180 / Math.PI;
      }
      const want = colourAt(layer.legend, (v - layer.min) / (layer.max - layer.min)), o = (r * size + c) * 4;
      assert.equal(rgba[o + 3], 255);
      worst = Math.max(worst, ...want.map((w, j) => Math.abs(w - rgba[o + j]))); n++;
    }
    assert.ok(worst <= 1.01, `${id}: colour differs from the independently computed value by ${worst} DN`);
    console.log(`  ${id}: ${n} texels match values recomputed from heightmap.bin (max colour difference ${worst.toFixed(2)} DN); range ${layer.min}..${layer.max} ${layer.units}`);
  }
  // Slope sanity on a synthetic plane tilted 10 degrees to the east.
  const flat = { meta: { ...meta, resolution: { dem_native_m: d } }, heights: Float32Array.from({ length: W * H }, (_, i) => (i % W) * d * Math.tan(10 * Math.PI / 180)) };
  assert.ok(Math.abs(sf.siteSlope(flat, 0, 0) - 10) < 1e-3);
  console.log("  slope of a synthetic 10-degree plane = 10.000 degrees");

  // Regional values: same numbers as the globe readout at the same latitude and longitude.
  const gmeta = JSON.parse(readFileSync("public/globe/globe.json", "utf8"));
  if (existsSync("public/globe/climate.json")) gmeta.scalars.push(...JSON.parse(readFileSync("public/globe/climate.json", "utf8")).scalars);
  const R = meta.body.radius_m, rad = Math.PI / 180;
  for (const def of gmeta.scalars.filter((s) => s.id !== "elev" && s.id !== "slope")) {
    const w = def.width ?? gmeta.grid.width, h = def.height ?? gmeta.grid.height;
    const b = readFileSync(`public/globe/${def.file}`), data = new Int16Array(b.buffer, b.byteOffset, w * h);
    const grid = new gd.ScalarGrid(def, data, w, h, gmeta.grid.nodata);
    for (const [x, y] of [[0, 0], [ext.west + 50, ext.north - 50], [ext.east - 50, ext.south + 50]]) {
      const lat = meta.center.lat + (y / R) / rad, lon = meta.center.lon + (x / (R * Math.cos(meta.center.lat * rad))) / rad;
      const got = sf.regional(t, grid, x, y);
      if (def.id.startsWith("ice")) {      // cell value read straight from the file
        const rr = Math.floor((90 - lat) / 180 * h), cc = Math.floor((lon + 180) / 360 * w), v = data[rr * w + cc];
        assert.equal(got, v === gmeta.grid.nodata ? null : v / def.scale);
      } else {                             // bilinear value must lie within the spread of the surrounding cells
        const near = [-1, 0, 1].flatMap((i) => [-1, 0, 1].map((j) => grid.at(lat + i * 180 / h, lon + j * 360 / w)));
        assert.ok(got >= Math.min(...near) - 1e-6 && got <= Math.max(...near) + 1e-6, `${def.id}: ${got} outside ${Math.min(...near)}..${Math.max(...near)}`);
      }
    }
  }
  console.log(`  regional values on the site equal the globe grids (${gmeta.scalars.length - 2} grids, 3 points each)`);

  // Local infrared layers: texels equal values computed independently from the .u8 files.
  if (meta.thermal) {
    const n = meta.thermal.size, th = {};
    for (const k of ["night", "day"]) if (meta.thermal[k]) th[k] = new Uint8Array(readFileSync(`${dir}/${meta.thermal[k].file}`));
    const tt = { meta, heights, thermal: th };
    const irAt = (k, x, y) => {
      const b = meta.thermal[k], c = (x - ext.west) / (ext.east - ext.west) * n - 0.5, r = (ext.north - y) / (ext.north - ext.south) * n - 0.5;
      const c0 = Math.min(n - 2, Math.max(0, Math.floor(c))), r0 = Math.min(n - 2, Math.max(0, Math.floor(r)));
      const fc = Math.min(1, Math.max(0, c - c0)), fr = Math.min(1, Math.max(0, r - r0)), g = (rr, cc) => th[k][rr * n + cc];
      if ([g(r0, c0), g(r0, c0 + 1), g(r0 + 1, c0), g(r0 + 1, c0 + 1)].includes(0)) return null;
      const dn = g(r0, c0) * (1 - fc) * (1 - fr) + g(r0, c0 + 1) * fc * (1 - fr) + g(r0 + 1, c0) * (1 - fc) * fr + g(r0 + 1, c0 + 1) * fc * fr;
      return Math.min(1, Math.max(0, (dn - b.dn_p2) / Math.max(1, b.dn_p98 - b.dn_p2)));
    };
    for (const [id, k, inv] of [["dust", "night", true], ["temp", "night", false], ["temp", "day", false]]) {
      if (!th[k]) continue;
      const { layer, rgba, size } = sf.buildSiteLayer(tt, id, null, { tempMode: k });
      assert.ok(layer.local && layer.kind.includes("relative"));
      let worst = 0, seen = 0; const vals = [];
      for (let i = 0; i < 3000; i++) {
        const r = (i * 7919) % size, c = (i * 104729) % size, o = (r * size + c) * 4;
        const x = ext.west + (c + 0.5) / size * (ext.east - ext.west), y = ext.south + (r + 0.5) / size * (ext.north - ext.south);
        const v0 = irAt(k, x, y);
        if (v0 === null) { assert.equal(rgba[o + 3], 0); continue; }
        const v = inv ? 1 - v0 : v0, exp = colourAt(layer.legend, v); vals.push(v); seen++;
        for (let j = 0; j < 3; j++) worst = Math.max(worst, Math.abs(rgba[o + j] - exp[j]));
      }
      assert.ok(worst <= 1.01 && seen > 2000, `${id}/${k}: colour off by ${worst}`);
      vals.sort((a, b) => a - b);
      const spread = vals[Math.floor(vals.length * 0.9)] - vals[Math.floor(vals.length * 0.1)];
      assert.ok(spread > 0.2, `${id}/${k}: layer is nearly uniform (10-90% spread ${spread})`);
      console.log(`  ${id} (${k} infrared): ${seen} texels match the .u8 file; 10-90% spread ${spread.toFixed(2)} of the scale`);
    }
  }

  // Wind exposure on synthetic terrain with a known answer. Wind blowing toward the east (u > 0) comes FROM the west.
  const fake = (v) => ({ smooth: () => v });
  const gl = (u, v) => ({ meta: { layers: [] }, scalars: { wind_u: fake(u), wind_v: fake(v), wind: fake(Math.hypot(u, v) * 2) } });
  const w1 = sf.regionalWind(flat, gl(3, 0));
  assert.ok(Math.abs(w1.fromDeg - 270) < 1e-9 && Math.abs(w1.steadiness - 0.5) < 1e-9);
  assert.ok(Math.abs(sf.regionalWind(flat, gl(0, -2)).fromDeg - 0) < 1e-9);       // blowing south = from the north
  // `flat` rises 10 degrees toward the east: wind from the east meets rising ground upwind (sheltered, -10),
  // wind from the west has the ground falling away upwind (exposed, +10).
  const eFromE = sf.windExposure(flat, sf.regionalWind(flat, gl(-3, 0)), 0, 0), eFromW = sf.windExposure(flat, w1, 0, 0);
  const sign = Math.sign(flat.heights[1] - flat.heights[0]);                      // +1 when the plane rises eastward
  assert.ok(Math.abs(eFromE + sign * 10) < 0.01 && Math.abs(eFromW - sign * 10) < 0.01, `exposure ${eFromE}, ${eFromW}`);
  console.log(`  wind exposure on a 10-degree plane: ${eFromE.toFixed(2)} and ${eFromW.toFixed(2)} degrees (upwind rise = shelter)`);
  // Real site with the real wind grids: deterministic and varying.
  if (existsSync("public/globe/wind_u.i16")) {
    const scal = {};
    for (const id of ["wind", "wind_u", "wind_v"]) {
      const def = gmeta.scalars.find((s) => s.id === id), b = readFileSync(`public/globe/${def.file}`);
      scal[id] = new gd.ScalarGrid(def, new Int16Array(b.buffer, b.byteOffset, def.width * def.height), def.width, def.height, gmeta.grid.nodata);
    }
    const g = { meta: { layers: [] }, scalars: scal };
    const a = sf.buildSiteLayer(t, "wind", g), b2 = sf.buildSiteLayer(t, "wind", g);
    assert.ok(a.layer.local && Buffer.from(a.rgba).equals(Buffer.from(b2.rgba)), "wind layer must be deterministic");
    const w = sf.regionalWind(t, g);
    console.log(`  wind at the site: from ${w.fromDeg.toFixed(0)} deg, mean speed ${w.speed.toFixed(1)} m/s, steadiness ${w.steadiness.toFixed(2)}; exposure scale ±${a.layer.max} deg`);
  }
  console.log("Site filter checks passed.");
} finally {
  await server.close();
}
