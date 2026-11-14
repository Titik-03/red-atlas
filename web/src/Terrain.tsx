import { useEffect, useMemo } from "react";
import * as THREE from "three";
import { useFrame } from "@react-three/fiber";
import { useTexture } from "@react-three/drei";
import { sampleElevation, type Terrain as TerrainData } from "./geo";

// ------------------------------------------------------------------------------------------------
// Colour fusion: colour from the Viking colour mosaic (the globe base map, 925 m), brightness detail from
// the full-resolution grayscale image:  rgb = viking * (pan / pan averaged over ~925 m).
// Dark regions get a display lift (gamma 0.7 on luminance, hue kept). The ~925 m average is the pan texture's own mipmap at lod = log2(925 / pixel size). uMix blends
// 0 = original grayscale ... 1 = fused colour, animated when toggled.
const VIKING_M = 925.4;
const FUSION_CHUNK = /* glsl */ `
#ifdef USE_MAP
  vec4 pan = texture2D( map, vMapUv );
  vec3 panLow = textureLod( map, vMapUv, uLod ).rgb;
  vec3 vik = texture2D( uColor, vMapUv ).rgb;
  // Display stretch: lift dark regions (gamma 0.7 on Viking luminance, hue unchanged) so relief detail stays
  // readable where the mosaic is very dark (e.g. Syrtis Major).
  float lv = max( dot( vik, vec3( 0.299, 0.587, 0.114 ) ), 0.004 );
  vik *= pow( lv, 0.7 ) / lv;
  float ratio = clamp( pan.r / max( panLow.r, 0.004 ), 0.15, 4.0 );
  vec3 fused = clamp( vik * ratio, 0.0, 1.0 );
  diffuseColor.rgb *= mix( pan.rgb, fused, uMix );
#endif
`;

function useFusion(pan: THREE.Texture, color: THREE.Texture | null, pixelM: number, width: number, colorOn: boolean,
                   urls: string[]) {
  const uniforms = useMemo(() => ({
    uColor: { value: color },
    uLod: { value: Math.max(0, Math.min(Math.log2(width), Math.log2(VIKING_M / pixelM))) },
    uMix: { value: colorOn ? 1 : 0 },
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }), [color, pixelM, width]);
  useEffect(() => {
    for (const t of [pan, color]) {
      if (!t) continue;
      t.colorSpace = THREE.SRGBColorSpace; t.anisotropy = 8;
      t.generateMipmaps = true; t.minFilter = THREE.LinearMipmapLinearFilter; t.needsUpdate = true;
    }
    // Leaving the site: free the GPU copies (a 4096 px texture + mipmaps is ~90 MB) and drop them from the
    // loader cache so visited sites do not pile up in memory.
    return () => {
      pan.dispose();
      color?.dispose();
      useTexture.clear(urls);
    };
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [pan, color]);
  useFrame((_, dt) => {   // smooth grayscale <-> colour transition
    const target = colorOn && color ? 1 : 0, u = uniforms.uMix;
    if (u.value !== target) u.value = Math.abs(target - u.value) < 0.02 ? target : u.value + (target - u.value) * Math.min(1, dt * 6);
  });
  const onBeforeCompile = useMemo(() => color ? (shader: THREE.WebGLProgramParametersWithUniforms) => {
    Object.assign(shader.uniforms, uniforms);
    shader.fragmentShader = "uniform sampler2D uColor;\nuniform float uLod;\nuniform float uMix;\n"
      + shader.fragmentShader.replace("#include <map_fragment>", FUSION_CHUNK);
  } : undefined, [color, uniforms]);
  return { onBeforeCompile, cacheKey: color ? "viking-fusion" : "plain" };
}

/**
 * Mesh whose vertices sit exactly at heightmap cell centres (true metres).
 * UVs are computed from each vertex's metric position over the texture extent,
 * so the orthoimage and the DTM align by construction (same grid from the pipeline).
 */
export function Terrain({ data, base, stride, exaggeration, relief, colorOn }: {
  data: TerrainData; base: string; stride: number; exaggeration: number; relief: boolean; colorOn: boolean;
}) {
  const { meta, heights } = data;
  const cfile = meta.color?.file;
  const urls = cfile ? [`${base}/${meta.texture.file}`, `${base}/${cfile}`] : [`${base}/${meta.texture.file}`];
  const texs = useTexture(urls);
  const tex = texs[0], ctex = texs[1] ?? null;
  const fusion = useFusion(tex, ctex, meta.texture.pixel_m, meta.texture.width, colorOn, urls);

  const geometry = useMemo(() => {
    const { width: W, height: H, spacing_m: d, min } = meta.heightmap;
    const { west, north, east, south } = meta.extent_m;
    const cols = Math.floor((W - 1) / stride) + 1;
    const rows = Math.floor((H - 1) / stride) + 1;
    const pos = new Float32Array(cols * rows * 3);
    const uv = new Float32Array(cols * rows * 2);
    let p = 0, q = 0;
    for (let rr = 0; rr < rows; rr++) {
      const r = rr * stride;
      const y = north - (r + 0.5) * d;
      for (let cc = 0; cc < cols; cc++) {
        const c = cc * stride;
        const x = west + (c + 0.5) * d;
        pos[p++] = x;
        pos[p++] = heights[r * W + c] - min;
        pos[p++] = -y;
        uv[q++] = (x - west) / (east - west);
        uv[q++] = (y - south) / (north - south);
      }
    }
    const idx = new Uint32Array((cols - 1) * (rows - 1) * 6);
    let k = 0;
    for (let r = 0; r < rows - 1; r++) {
      for (let c = 0; c < cols - 1; c++) {
        const a = r * cols + c, b = a + 1, e = a + cols, f = e + 1;
        idx[k++] = a; idx[k++] = e; idx[k++] = b;
        idx[k++] = b; idx[k++] = e; idx[k++] = f;
      }
    }
    const g = new THREE.BufferGeometry();
    g.setAttribute("position", new THREE.BufferAttribute(pos, 3));
    g.setAttribute("uv", new THREE.BufferAttribute(uv, 2));
    g.setIndex(new THREE.BufferAttribute(idx, 1));
    g.computeVertexNormals();
    g.computeBoundingBox();
    g.computeBoundingSphere();
    return g;
  }, [meta, heights, stride]);

  useEffect(() => () => geometry.dispose(), [geometry]);

  return (
    <mesh
      geometry={geometry}
      scale={[1, exaggeration, 1]}
      raycast={() => null /* picking is done analytically on the heightfield */}
    >
      {relief
        ? <meshStandardMaterial key={"s" + fusion.cacheKey} map={tex} roughness={1} metalness={0}
            onBeforeCompile={fusion.onBeforeCompile} customProgramCacheKey={() => fusion.cacheKey} />
        : <meshBasicMaterial key={"b" + fusion.cacheKey} map={tex}
            onBeforeCompile={fusion.onBeforeCompile} customProgramCacheKey={() => fusion.cacheKey} />}
    </mesh>
  );
}

/**
 * Low-resolution surroundings (meta.context): same local frame and vertical datum as the site tile.
 * Context vertices inside the site tile are tucked 3 m under the site surface (sampled from the site
 * heightmap) and quads fully inside are dropped, so the coarser context never covers the high-res tile
 * (the two DEMs differ by metres at Jezero) and no gaps or walls appear at the tile edge.
 */
export function ContextTerrain({ data, base, exaggeration, relief, colorOn }: {
  data: TerrainData; base: string; exaggeration: number; relief: boolean; colorOn: boolean;
}) {
  const ctx = data.meta.context!;
  const cfile = data.meta.color?.context_file;
  const urls = cfile ? [`${base}/${ctx.texture.file}`, `${base}/${cfile}`] : [`${base}/${ctx.texture.file}`];
  const texs = useTexture(urls);
  const tex = texs[0], ctex = texs[1] ?? null;
  const fusion = useFusion(tex, ctex, ctx.texture.pixel_m, ctx.texture.width, colorOn, urls);

  const geometry = useMemo(() => {
    const heights = data.context!;
    const { width: W, height: H, spacing_m: d } = ctx.heightmap;
    const { west, north, east, south } = ctx.extent_m;
    const min = data.meta.heightmap.min;
    const site = data.meta.extent_m;
    const inside = (x: number, y: number) => x > site.west && x < site.east && y > site.south && y < site.north;
    const pos = new Float32Array(W * H * 3);
    const uv = new Float32Array(W * H * 2);
    const ins = new Uint8Array(W * H);
    let p = 0, q = 0;
    for (let r = 0; r < H; r++) {
      const y = north - (r + 0.5) * d;
      for (let c = 0; c < W; c++) {
        const x = west + (c + 0.5) * d;
        const i = r * W + c;
        ins[i] = inside(x, y) ? 1 : 0;
        pos[p++] = x;
        let h = heights[i];
        if (ins[i]) {
          const hs = sampleElevation(data, x, y);
          h = Math.min(h, (hs ?? h) - 3);
        }
        pos[p++] = h - min;
        pos[p++] = -y;
        uv[q++] = (x - west) / (east - west);
        uv[q++] = (y - south) / (north - south);
      }
    }
    const idx: number[] = [];
    for (let r = 0; r < H - 1; r++) {
      for (let c = 0; c < W - 1; c++) {
        const a = r * W + c, b = a + 1, e = a + W, f = e + 1;
        if (ins[a] && ins[b] && ins[e] && ins[f]) continue;
        idx.push(a, e, b, b, e, f);
      }
    }
    const g = new THREE.BufferGeometry();
    g.setAttribute("position", new THREE.BufferAttribute(pos, 3));
    g.setAttribute("uv", new THREE.BufferAttribute(uv, 2));
    g.setIndex(idx);
    g.computeVertexNormals();
    g.computeBoundingSphere();
    return g;
  }, [data, ctx]);
  useEffect(() => () => geometry.dispose(), [geometry]);

  return (
    <mesh geometry={geometry} scale={[1, exaggeration, 1]} raycast={() => null}>
      {relief
        ? <meshStandardMaterial key={"s" + fusion.cacheKey} map={tex} roughness={1} metalness={0} polygonOffset polygonOffsetFactor={2} polygonOffsetUnits={2}
            onBeforeCompile={fusion.onBeforeCompile} customProgramCacheKey={() => fusion.cacheKey} />
        : <meshBasicMaterial key={"b" + fusion.cacheKey} map={tex} polygonOffset polygonOffsetFactor={2} polygonOffsetUnits={2}
            onBeforeCompile={fusion.onBeforeCompile} customProgramCacheKey={() => fusion.cacheKey} />}
    </mesh>
  );
}

/** Thin outline marking the high-resolution site tile (where the readout works) inside the context. */
export function TileOutline({ data, exaggeration }: { data: TerrainData; exaggeration: number }) {
  const line = useMemo(() => {
    const { width: W, height: H, spacing_m: d, min } = data.meta.heightmap;
    const { west, north } = data.meta.extent_m;
    const pts: number[] = [];
    const add = (r: number, c: number) => {
      pts.push(west + (c + 0.5) * d, data.heights[r * W + c] - min + 1.5, -(north - (r + 0.5) * d));
    };
    const s = 8;
    for (let c = 0; c < W; c += s) add(0, c);
    for (let r = 0; r < H; r += s) add(r, W - 1);
    for (let c = W - 1; c >= 0; c -= s) add(H - 1, c);
    for (let r = H - 1; r >= 0; r -= s) add(r, 0);
    const g = new THREE.BufferGeometry();
    g.setAttribute("position", new THREE.BufferAttribute(new Float32Array(pts), 3));
    return new THREE.LineLoop(g, new THREE.LineBasicMaterial({ color: "#ffd166", transparent: true, opacity: 0.55, fog: false }));
  }, [data]);
  useEffect(() => () => { line.geometry.dispose(); (line.material as THREE.Material).dispose(); }, [line]);
  return <primitive object={line} scale={[1, exaggeration, 1]} />;
}
