import { Cuboid, LoaderCircle } from "lucide-react";
import type { Memory } from "../types";

/** Small card badge: "3D-ready" when the 3D check passed, "Checking 3D" while it is pending. */
export function ReadinessBadge({ memory, pending = false }: { memory: Memory; pending?: boolean }) {
  if (memory.readiness3d?.ready) return <span className="readiness-badge" title={memory.readiness3d.reasons.join("; ")}><Cuboid size={11} /> 3D-ready</span>;
  if (!memory.readiness3d && pending) return <span className="readiness-badge pending"><LoaderCircle className="spin" size={11} /> Checking 3D</span>;
  return null;
}

/** Detail-view explanation of why a memory is (or is not) filed into the 3D-ready folders. */
export function ReadinessReasons({ memory }: { memory: Memory }) {
  const readiness = memory.readiness3d;
  if (!readiness) return <div className="readiness-detail"><strong><Cuboid size={14} /> Not checked for 3D yet</strong><p>It stays in All memories until a 3D check runs.</p></div>;
  return (
    <div className={`readiness-detail ${readiness.ready ? "ready" : ""}`}>
      <strong><Cuboid size={14} /> {readiness.ready ? "3D-ready" : "Not 3D-ready"} <span>{Math.round(readiness.score * 100)}/100</span></strong>
      <ul>{readiness.reasons.slice(0, 4).map((reason) => <li key={reason}>{reason}</li>)}</ul>
      <small>
        {readiness.source === "heuristic" ? "Estimated without the depth model" : "Measured with Depth Anything V2"}
        {readiness.sampledAt !== undefined ? ` on the frame at ${readiness.sampledAt.toFixed(1)}s` : ""}
        {readiness.ready ? "" : " · kept in All memories only"}
      </small>
    </div>
  );
}
