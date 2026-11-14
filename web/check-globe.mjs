import assert from "node:assert/strict";
import React from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { createServer } from "vite";

const server = await createServer({ server: { middlewareMode: true, hmr: false, ws: false }, appType: "custom" });
try {
  const { default: App } = await server.ssrLoadModule("/src/App.tsx");
  for (const reducedMotion of [false, true]) {
    globalThis.window = { matchMedia: () => ({ matches: reducedMotion }) };
    const html = renderToStaticMarkup(React.createElement(App));
    assert.match(html, /<h1>Mars<\/h1>/);
    assert.match(html, /Explore terrain/);
    assert.match(html, /Loading NASA Mars data layers/);
    assert.match(html, /aria-label="Zoom in"/);
    assert.match(html, reducedMotion ? /Resume rotation/ : /Pause rotation/);
    assert.doesNotMatch(html, /Loading real HiRISE terrain/);
  }
  console.log("Globe initial view, controls, and reduced-motion checks passed.");
} finally {
  delete globalThis.window;
  await server.close();
}
