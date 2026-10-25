import { ArrowLeft, ArrowRight, Folder, Images, LoaderCircle, Sparkles, Video } from "lucide-react";
import { useState } from "react";
import type { Memory, MemoryFolder } from "../types";
import { friendlyMemoryTitle } from "../memory-labels";

function Thumb({ memory }: { memory: Memory }) {
  const label = friendlyMemoryTitle(memory);
  if (memory.thumbnailUrl) return <img src={memory.thumbnailUrl} alt={label} loading="lazy" />;
  if (memory.mediaType === "image") return <img src={memory.url} alt={label} loading="lazy" />;
  return memory.url ? <video src={memory.url} muted playsInline preload="metadata" aria-label={label} /> : <span className="folder-thumb-placeholder"><Video size={20} /></span>;
}

/**
 * Folder-first library. Pictures is the general root, category folders sit
 * underneath it, and "All memories" (the broad archive) is always listed last.
 * Every folder is a view onto the same archived memories, never a copy.
 * The 3D check that decides what Pictures and categories contain runs on the
 * backend only; nothing about it (scores, badges, reasons) is shown here.
 * Only categories that actually contain memories are listed. "All memories" is
 * the backup archive: reachable from the sidebar, not shown on this page.
 */
export default function FoldersView({ folders, memories, onSelect, onReorganize, reorganizing = false }: {
  folders: MemoryFolder[];
  memories: Memory[];
  onSelect: (memory: Memory) => void;
  onReorganize?: () => void;
  reorganizing?: boolean;
}) {
  const [activeId, setActiveId] = useState("");
  const byId = new Map(memories.map((memory) => [memory.id, memory]));
  const root = folders.find((folder) => folder.kind === "root");
  const categories = folders.filter((folder) => folder.kind === "category" && folder.memoryIds.length > 0);
  const active = folders.find((folder) => folder.id === activeId);
  const covers = (folder: MemoryFolder) => (folder.coverMemoryIds?.length ? folder.coverMemoryIds : folder.memoryIds).slice(0, 4).map((id) => byId.get(id)).filter(Boolean) as Memory[];
  const pending = (folder: MemoryFolder) => folder.pendingMemoryIds?.length || 0;

  if (active) {
    const contents = active.memoryIds.map((id) => byId.get(id)).filter(Boolean) as Memory[];
    const path = active.kind === "root" ? "PICTURES" : `PICTURES / ${active.name.toUpperCase()}`;
    return (
      <section className="folders-view">
        <button className="text-button" onClick={() => setActiveId("")}><ArrowLeft size={16} /> Back to folders</button>
        <div className="folder-detail-heading"><Folder size={25} /><div><span className="eyebrow">{path}</span><h2>{active.name} <span>{contents.length}</span></h2></div></div>
        {pending(active) > 0 && <p className="folder-pending"><LoaderCircle className="spin" size={13} /> {pending(active)} more arriving from your current import</p>}
        <div className="memory-grid folder-memory-grid">
          {contents.map((memory) => (
            <button className="memory-card" key={memory.id} onClick={() => onSelect(memory)}>
              <div className="memory-photo"><Thumb memory={memory} /></div>
              <div className="memory-info"><p>{memory.date || "Date not recorded"} <span>·</span> {memory.mediaType === "video" ? "Video" : "Photo"}</p><h3>{friendlyMemoryTitle(memory)}</h3></div>
            </button>
          ))}
        </div>
        {!contents.length && !pending(active) && <p className="folder-empty">This folder is empty.</p>}
      </section>
    );
  }

  const rootCard = (folder: MemoryFolder, caption: string) => (
    <button className="folder-root-card" key={folder.id} onClick={() => setActiveId(folder.id)}>
      <div className="folder-icon"><Folder size={28} /></div>
      <div><h3>{folder.name}</h3><p>{folder.memoryIds.length} individual memories · {caption}{pending(folder) ? ` · ${pending(folder)} arriving` : ""}</p></div>
      <ArrowRight size={18} />
    </button>
  );

  return (
    <section className="folders-view">
      <div className="section-heading">
        <div><span className="eyebrow"><Folder size={12} /> ORGANIZED LIBRARY</span><h2>Your memory folders <span>{categories.length}</span></h2></div>
        <p className="folder-description">Your best moments, sorted into folders. Everything you imported is kept as a backup in All memories.</p>
      </div>
      {root && <div className="folder-root-grid single">{rootCard(root, "your best photos and videos")}</div>}
      <div className="section-heading folder-category-heading">
        <h2>Categories <span>{categories.length}</span></h2>
        <div className="folder-actions">
          {onReorganize && categories.length > 0 && <button className="text-button" disabled={reorganizing} onClick={onReorganize}>{reorganizing ? <LoaderCircle className="spin" size={14} /> : <Sparkles size={14} />} Re-sort folders</button>}
        </div>
      </div>
      <div className="folder-category-grid">
        {categories.map((folder) => (
          <button className="folder-category-card" key={folder.id} onClick={() => setActiveId(folder.id)}>
            <div className="folder-tab" />
            <div className="folder-category-photo-grid">
              {covers(folder).map((memory) => <Thumb key={memory.id} memory={memory} />)}
            </div>
            <div className="folder-category-copy"><h3>{folder.name}</h3><p><Images size={13} /> {folder.memoryIds.length} individual memories{pending(folder) ? ` · ${pending(folder)} arriving` : ""} <ArrowRight size={14} /></p></div>
          </button>
        ))}
      </div>
      {!categories.length && <p className="folder-empty">Import photos or videos and they will be sorted into folders here.</p>}
    </section>
  );
}
