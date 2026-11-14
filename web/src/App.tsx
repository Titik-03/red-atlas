import { useState } from "react";
import { Globe } from "./Globe";
import Region from "./Region";
import { ErrorBoundary } from "./ErrorBoundary";
import { Veil } from "./Veil";

export default function App() {
  // region = folder holding meta.json / heightmap.bin / texture.jpg ("/terrain/jezero" or "/sites/<id>").
  // The globe stays mounted (paused) underneath, so going back is instant and keeps layers and selection.
  const [region, setRegion] = useState<string | null>(null);
  return <>
    <Globe onExplore={setRegion} hidden={!!region} />
    {region && <>
      <ErrorBoundary key={region} fallback={(e) =>
        <div className="sheet surface-view">
          <Veil opacity={1} label="Could not open this site" sub={`${e.message || e}. Go back to the globe and try again.`} />
        </div>}>
        <div className="sheet surface-view"><Region base={region} /></div>
      </ErrorBoundary>
      <button className="back-to-orbit" onClick={() => setRegion(null)}>Back to the globe</button>
    </>}
  </>;
}
