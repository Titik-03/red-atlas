// Numerical checks of the globe/terrain geodesy used by the browser.
import assert from "node:assert/strict";
import { createServer } from "vite";
const server = await createServer({ server: { middlewareMode: true, hmr: false, ws: false }, appType: "custom" });
try {
  const g = await server.ssrLoadModule("/src/globeData.ts");
  let worst = 0;
  for (let i = 0; i < 20000; i++) {
    const lat = -89 + Math.random() * 178, lon = -180 + Math.random() * 360;
    const [x, y, z] = g.latLonToUnit(lat, lon);
    const r = g.unitToLatLon(x, y, z);
    worst = Math.max(worst, Math.abs(r.lat - lat), Math.abs(((r.lon - lon + 540) % 360) - 180));
  }
  assert.ok(worst < 1e-9, `lat/lon round-trip error ${worst}`);
  // Texture convention: lon -180 is the left edge (u=0), lon 0 at u=0.5; +Y is north; east is counter-clockwise seen from north.
  const [ex] = g.latLonToUnit(0, 0); assert.ok(Math.abs(ex - 1) < 1e-12);
  const [, ny] = g.latLonToUnit(90, 0); assert.ok(Math.abs(ny - 1) < 1e-12);
  const [, , z90] = g.latLonToUnit(0, 90); assert.ok(Math.abs(z90 + 1) < 1e-12, "90E must be -Z");
  console.log(`Geodesy checks passed (max round-trip error ${worst.toExponential(1)} deg).`);
} finally { await server.close(); }
