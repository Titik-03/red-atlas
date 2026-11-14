// Runs the real browser readout code on the published assets for the points in ../data/audit/points.json.
import fs from "node:fs";
import { createServer } from "vite";
const server = await createServer({ server: { middlewareMode: true, hmr: false, ws: false }, appType: "custom", logLevel: "silent" });
try {
  const g = await server.ssrLoadModule("/src/globeData.ts");
  const geo = await server.ssrLoadModule("/src/geo.ts");
  const pts = JSON.parse(fs.readFileSync("../data/audit/points.json", "utf8"));
  const meta = JSON.parse(fs.readFileSync("public/globe/globe.json", "utf8"));
  const out = { globe: {}, terrain: [] };
  for (const def of meta.scalars) {
    const buf = fs.readFileSync(`public/globe/${def.file}`);
    const arr = new Int16Array(buf.length / 2);
    for (let i = 0; i < arr.length; i++) arr[i] = buf.readInt16LE(i * 2);
    const grid = new g.ScalarGrid(def, arr, meta.grid.width, meta.grid.height, meta.grid.nodata);
    out.globe[def.id] = pts.globe.map(([la, lo]) => grid.at(la, lo));
  }
  const tm = JSON.parse(fs.readFileSync("public/terrain/jezero/meta.json", "utf8"));
  const hb = fs.readFileSync("public/terrain/jezero/heightmap.bin");
  const heights = new Float32Array(hb.buffer, hb.byteOffset, hb.length / 4);
  const t = { meta: tm, heights }, R = tm.body.radius_m, D = Math.PI / 180;
  for (const [la, lo] of pts.terrain) {
    const x = R * Math.cos(tm.center.lat * D) * (lo - tm.center.lon) * D, y = R * (la - tm.center.lat) * D;
    const back = geo.localToLatLon(tm, x, y);
    out.terrain.push({ elev: geo.sampleElevation(t, x, y), dlat: back.lat - la, dlon: back.lon - lo });
  }
  fs.writeFileSync("../data/audit/readouts.json", JSON.stringify(out));
} finally { await server.close(); }
