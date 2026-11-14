/**
 * Mars-haze veil over the map window, used for every globe <-> surface transition. Globe and Region render the
 * same veil in the same place, so the hand-over between the two canvases is invisible: the descent fades INTO
 * it, the surface fades OUT of it. Shows a real progress bar (site build stages, then downloads) while loading.
 */
export function Veil({ opacity, label, sub, progress }: {
  opacity: number; label?: string; sub?: string; progress?: number | null;
}) {
  return (
    <div className="veil" style={{ opacity, pointerEvents: opacity > 0.5 ? "auto" : "none" }} aria-hidden={opacity < 0.05}
         role="status" aria-live="polite">
      {label && <div className="veil-box" key={label}>
        <div className="veil-label">{label}</div>
        {progress !== undefined && <div className="veil-bar">
          <div className={progress === null ? "indeterminate" : undefined}
               style={progress === null ? undefined : { width: `${Math.round(Math.max(0.02, progress) * 100)}%` }} />
        </div>}
        {sub && <div className="veil-sub">{sub}</div>}
      </div>}
    </div>
  );
}
