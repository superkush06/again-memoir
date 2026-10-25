import { Check, CircleAlert, LoaderCircle } from "lucide-react";
import type { ImportJob, ImportStage } from "../types";

const stages: ImportStage[] = [
  "received",
  "archived",
  "hashed",
  "embedded",
  "scored",
  "grouped",
  "ready",
];
/** The internal 3D check is never shown as its own step. */
const shownStages: ImportStage[] = [
  "received",
  "archived",
  "hashed",
  "embedded",
  "grouped",
  "ready",
];

export default function ImportProgress({ jobs }: { jobs: ImportJob[] }) {
  const job = jobs[0];
  if (!job) return null;
  const done = job.processedItems + job.skippedItems + job.failedItems;
  const percent = job.totalItems
    ? Math.round((done / job.totalItems) * 100)
    : 0;
  const active = job.status === "processing" || job.status === "queued";
  const completedCleanly = job.status === "ready" && job.failedItems === 0;
  // Background library maintenance (the backend-only 3D check) is not an import; don't show it.
  if (job.kind === "rescore-3d") return null;
  const plan = job.folderPlan;
  const categoryCount = plan
    ? plan.folderNames.filter(
        (name) => name !== "Pictures" && name !== "All memories",
      ).length
    : 0;
  const review = !plan
    ? ""
    : plan.review.mode === "gemini"
      ? `Gemini reviewed the folders: ${plan.review.kept} kept${plan.review.renamed ? `, ${plan.review.renamed} renamed` : ""}${plan.review.rejected ? `, ${plan.review.rejected} unsupported suggestions ignored` : ""}`
      : plan.review.reason === "too_many_items"
        ? "Large import: sorted locally without per-photo model calls"
        : plan.review.reason === "not_configured"
          ? "Sorted locally (Gemini not configured)"
          : plan.review.reason === "empty" || plan.review.reason === "retry"
            ? ""
            : "Sorted locally (Gemini review unavailable)";
  const title = active
    ? "Turning this selection into memories"
    : job.status === "ready"
      ? "Your latest import is ready"
      : "Import finished with a few items to retry";
  const summary = completedCleanly
    ? `${job.processedItems} ${job.processedItems === 1 ? "memory" : "memories"} saved locally${job.skippedItems ? ` · ${job.skippedItems} duplicates skipped` : ""}`
    : `${job.source.replace("-", " ")} · ${job.totalItems} items · ${job.processedItems} saved · ${job.skippedItems} duplicates · ${job.failedItems} failed`;
  return (
    <section
      className={`import-progress${active ? " active" : ""}${completedCleanly ? " complete" : ""}`}
      aria-live="polite"
    >
      <div className="import-progress-heading">
        <span>
          {active ? (
            <LoaderCircle className="spin" size={18} />
          ) : job.failedItems ? (
            <CircleAlert size={18} />
          ) : (
            <Check size={18} />
          )}
        </span>
        <div>
          <strong>{title}</strong>
          <small>{summary}</small>
          {!completedCleanly && plan && (
            <small className="import-plan-line">
              {categoryCount} {categoryCount === 1 ? "folder" : "folders"}{" "}
              created before archiving{review ? ` · ${review}` : ""}
            </small>
          )}
        </div>
        {!completedCleanly && <b>{percent}%</b>}
      </div>
      {!completedCleanly && (
        <>
          <div className="import-progress-bar">
            <i style={{ width: `${percent}%` }} />
          </div>
          <div className="import-stage-list">
            <span className={plan ? "reached" : ""}>folders planned</span>
            {shownStages.map((stage) => (
              <span
                key={stage}
                className={
                  stages.indexOf(stage) <= stages.indexOf(job.currentStage)
                    ? "reached"
                    : ""
                }
              >
                {stage}
              </span>
            ))}
          </div>
        </>
      )}
    </section>
  );
}
