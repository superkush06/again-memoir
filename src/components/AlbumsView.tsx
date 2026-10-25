import { useMemo, useState } from "react";
import {
  ArrowLeft,
  ArrowRight,
  Check,
  Cuboid,
  Images,
  LockKeyhole,
  Plus,
  Sparkles,
  Users,
  X,
} from "lucide-react";
import type { Album, Memory } from "../types";
import { friendlyMemoryTitle } from "../memory-labels";

type AlbumChanges = {
  title?: string;
  type?: "confirmed";
  addMemoryIds?: string[];
  removeMemoryIds?: string[];
  coverMemoryId?: string;
  worldAnchorMemoryId?: string;
};

export default function AlbumsView({
  albums,
  memories,
  mode,
  busy,
  onUpdate,
  onCreate,
  onEnterWorld,
  onShare,
}: {
  albums: Album[];
  memories: Memory[];
  mode: "albums" | "suggested" | "worlds";
  busy: string;
  onUpdate: (id: string, changes: AlbumChanges) => Promise<void>;
  onCreate: (title: string, memoryIds: string[]) => Promise<void>;
  onEnterWorld: (album: Album) => Promise<void>;
  onShare: (album: Album) => void;
}) {
  const visible = albums.filter((album) => mode !== "suggested" || album.type === "suggested");
  const [activeId, setActiveId] = useState("");
  const [title, setTitle] = useState("");
  const [addId, setAddId] = useState("");
  const [manual, setManual] = useState(false);
  const [manualTitle, setManualTitle] = useState("");
  const [manualIds, setManualIds] = useState<string[]>([]);
  const active = visible.find((album) => album.id === activeId) || albums.find((album) => album.id === activeId);
  const byId = useMemo(() => new Map(memories.map((memory) => [memory.id, memory])), [memories]);
  const open = (album: Album) => { setActiveId(album.id); setTitle(album.title); setAddId(""); };

  if (active) {
    const cover = byId.get(active.coverMemoryId);
    const anchor = byId.get(active.worldAnchorMemoryId);
    const albumMemories = active.memoryIds.map((id) => byId.get(id)).filter(Boolean) as Memory[];
    const available = memories.filter((memory) => !active.memoryIds.includes(memory.id));
    return (
      <section className="album-detail">
        <button className="text-button" onClick={() => setActiveId("")}><ArrowLeft size={16} /> Back to albums</button>
        <div className="album-detail-hero">
          <div className="album-detail-cover">
            {cover && <img src={cover.thumbnailUrl || cover.url} alt="" />}
            <span><Images size={14} /> Album cover</span>
          </div>
          <div className="album-detail-copy">
            <div className="album-private"><LockKeyhole size={13} /> Private until you choose to share</div>
            <input className="album-title-input" value={title} onChange={(event) => setTitle(event.target.value)} aria-label="Album title" />
            <p>{albumMemories.length} memories · {active.type === "suggested" ? `${Math.round(active.confidence * 100)}% grouping confidence` : active.type}</p>
            <div className="album-actions">
              <button className="button primary" onClick={() => void onEnterWorld(active)} disabled={Boolean(busy)}><Cuboid size={17} /> Enter album world</button>
              <button className="button secondary" onClick={() => onShare(active)}><Users size={17} /> Share together</button>
              {title.trim() && title.trim() !== active.title && <button className="button secondary" onClick={() => void onUpdate(active.id, { title: title.trim() })}>Save name</button>}
              {active.type === "suggested" && <button className="button secondary" onClick={() => void onUpdate(active.id, { type: "confirmed" })}><Check size={16} /> Keep this album</button>}
            </div>
          </div>
          <div className="album-anchor-choice">
            {anchor && <img src={anchor.thumbnailUrl || anchor.url} alt="" />}
            <span><Cuboid size={14} /> World anchor</span>
            <strong>{anchor?.title}</strong>
            <small>Chosen for scene width, depth, ground and stable geometry—not just visual appeal.</small>
          </div>
        </div>
        <div className="section-heading album-memory-heading">
          <h2>Inside this album <span>{albumMemories.length}</span></h2>
          {available.length > 0 && <div className="album-add-row">
            <select value={addId} onChange={(event) => setAddId(event.target.value)} aria-label="Memory to add"><option value="">Add another memory…</option>{available.map((memory) => <option key={memory.id} value={memory.id}>{friendlyMemoryTitle(memory)}</option>)}</select>
            <button className="button secondary small" disabled={!addId} onClick={() => { void onUpdate(active.id, { addMemoryIds: [addId] }); setAddId(""); }}><Plus size={15} /> Add</button>
          </div>}
        </div>
        <div className="album-memory-grid">
          {albumMemories.map((memory, index) => (
            <article className="album-memory-row" key={memory.id}>
              <img src={memory.thumbnailUrl || memory.url} alt="" />
              <div><small>{String(index + 1).padStart(2, "0")} · {memory.source.replace("-", " ")}</small><strong>{friendlyMemoryTitle(memory)}</strong></div>
              <label title="Use as album cover"><input type="radio" name="cover" checked={active.coverMemoryId === memory.id} onChange={() => void onUpdate(active.id, { coverMemoryId: memory.id })} /> Cover</label>
              <label title="Use as reconstructed world anchor"><input type="radio" name="anchor" checked={active.worldAnchorMemoryId === memory.id} onChange={() => void onUpdate(active.id, { worldAnchorMemoryId: memory.id })} /> World</label>
              <button aria-label={`Remove ${friendlyMemoryTitle(memory)} from album`} disabled={albumMemories.length === 1} onClick={() => void onUpdate(active.id, { removeMemoryIds: [memory.id] })}><X size={16} /></button>
            </article>
          ))}
        </div>
      </section>
    );
  }

  if (manual) {
    return <section className="manual-album-panel">
      <button className="text-button" onClick={() => setManual(false)}><ArrowLeft size={16} /> Back to albums</button>
      <h2>Gather a new album.</h2>
      <p>Choose the memories that belong together. You can change the cover and world anchor afterward.</p>
      <label className="field-label">Album name<input value={manualTitle} onChange={(event) => setManualTitle(event.target.value)} placeholder="A weekend worth keeping" /></label>
      <div className="manual-memory-list">{memories.map((memory) => <label key={memory.id}><input type="checkbox" checked={manualIds.includes(memory.id)} onChange={() => setManualIds((ids) => ids.includes(memory.id) ? ids.filter((id) => id !== memory.id) : [...ids, memory.id])} /><img src={memory.thumbnailUrl || memory.url} alt="" /><span>{friendlyMemoryTitle(memory)}</span></label>)}</div>
      <button className="button primary" disabled={!manualTitle.trim() || !manualIds.length || Boolean(busy)} onClick={async () => { await onCreate(manualTitle.trim(), manualIds); setManual(false); setManualTitle(""); setManualIds([]); }}><Plus size={16} /> Create private album</button>
    </section>;
  }

  return (
    <section className="albums-view">
      <div className="section-heading">
        <h2>{mode === "suggested" ? "Suggested from your moments" : mode === "worlds" ? "Worlds ready to enter" : "Your albums"} <span>{visible.length}</span></h2>
        {mode === "albums" && <button className="button secondary small" onClick={() => setManual(true)}><Plus size={15} /> New album</button>}
      </div>
      {visible.length ? <div className="album-grid">{visible.map((album) => {
        const cover = byId.get(album.coverMemoryId); const anchor = byId.get(album.worldAnchorMemoryId);
        return <button className="album-card" key={album.id} onClick={() => open(album)}>
          <div className="album-cover-photo">{cover && <img src={cover.thumbnailUrl || cover.url} alt="" />}<span className="album-type">{album.type === "suggested" ? <><Sparkles size={12} /> Suggested</> : <><LockKeyhole size={12} /> Private</>}</span><div className="anchor-peek">{anchor && <img src={anchor.thumbnailUrl || anchor.url} alt="" />}<Cuboid size={14} /></div></div>
          <div className="album-card-copy"><small>{album.memoryIds.length} memories</small><h3>{album.title}</h3><p><Images size={13} /> Cover <span /> <Cuboid size={13} /> Separate world anchor</p><strong>{mode === "worlds" ? "Enter world" : "Open album"} <ArrowRight size={15} /></strong></div>
        </button>;
      })}</div> : <div className="empty-state"><Images size={40} /><h2>{mode === "suggested" ? "Suggestions appear after an import is grouped." : "Your first album starts with a few memories."}</h2><p>Import a manageable selection. Again will find event-shaped clusters without needing location data.</p></div>}
    </section>
  );
}
