import { useState } from "react";
import { Check, LoaderCircle, Sparkles, X } from "lucide-react";
import type { Memory } from "../types";

export default function MetadataEditor({
  memory,
  onSaved,
  onClose,
}: {
  memory: Memory;
  onSaved: (memory: Memory) => void;
  onClose: () => void;
}) {
  const [title, setTitle] = useState(memory.title);
  const [description, setDescription] = useState(memory.description);
  const [date, setDate] = useState(memory.date);
  const [location, setLocation] = useState(memory.location);
  const [tags, setTags] = useState(memory.tags.join(", "));
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState("");
  const [analysisStatus, setAnalysisStatus] = useState("");
  async function analyze() {
    setSaving(true);
    setError("");
    setAnalysisStatus("");
    try {
      const response = await fetch(`/api/memories/${memory.id}/analyze`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: "{}",
      });
      const result = await response.json();
      if (!response.ok)
        throw new Error(result.error || "Image description is unavailable.");
      if (result.analyzed) {
        setDescription(result.memory.description);
        setTags(result.memory.tags.join(", "));
      }
      setAnalysisStatus(result.status);
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setSaving(false);
    }
  }
  async function save(event: React.FormEvent) {
    event.preventDefault();
    setSaving(true);
    setError("");
    try {
      const response = await fetch(`/api/memories/${memory.id}`, {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          title,
          description,
          date,
          location,
          tags: tags
            .split(",")
            .map((tag) => tag.trim())
            .filter(Boolean),
        }),
      });
      const result = await response.json();
      if (!response.ok)
        throw new Error(result.error || "Could not save this memory.");
      onSaved(result);
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setSaving(false);
    }
  }
  return (
    <div className="modal-backdrop" onClick={onClose}>
      <form
        className="modal"
        role="dialog"
        aria-modal="true"
        aria-label="Edit memory details"
        onClick={(e) => e.stopPropagation()}
        onSubmit={save}
      >
        <button
          type="button"
          className="modal-close"
          onClick={onClose}
          aria-label="Close details editor"
        >
          <X size={20} />
        </button>
        <span className="eyebrow">THE WAY YOU REMEMBER IT</span>
        <h2 className="editor-title">Fill in the little things.</h2>
        <p>Add your own context so this moment is easier to find.</p>
        <label className="field-label">
          Title
          <input
            value={title}
            maxLength={160}
            required
            onChange={(e) => setTitle(e.target.value)}
          />
        </label>
        <label className="field-label">
          The story
          <textarea
            rows={4}
            value={description}
            maxLength={4000}
            onChange={(e) => setDescription(e.target.value)}
          />
        </label>
        <div className="metadata-row">
          <label className="field-label">
            Date
            <input
              type="date"
              value={date}
              onChange={(e) => setDate(e.target.value)}
            />
          </label>
          <label className="field-label">
            Place
            <input
              value={location}
              maxLength={200}
              onChange={(e) => setLocation(e.target.value)}
              placeholder="Where was this?"
            />
          </label>
        </div>
        <label className="field-label">
          Tags, separated by commas
          <input
            value={tags}
            onChange={(e) => setTags(e.target.value)}
            placeholder="family, summer, graduation"
          />
        </label>
        {error && (
          <p role="alert" className="form-error">
            {error}
          </p>
        )}
        {analysisStatus && (
          <p className="fine-print" role="status">
            {analysisStatus}
          </p>
        )}
        {memory.mediaType === "image" && memory.url.startsWith("/uploads/") && (
          <button
            type="button"
            className="text-button edit-details"
            disabled={saving}
            onClick={() => void analyze()}
          >
            <Sparkles size={14} />
            Refresh image description with Gemini
          </button>
        )}
        <button
          type="submit"
          className="button primary wide"
          disabled={saving || !title.trim()}
        >
          {saving ? (
            <LoaderCircle className="spin" size={17} />
          ) : (
            <Check size={17} />
          )}
          Save your memory
        </button>
      </form>
    </div>
  );
}
