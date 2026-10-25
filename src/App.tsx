import {
  lazy,
  Suspense,
  useCallback,
  useEffect,
  useRef,
  useState,
} from "react";
import {
  ArrowDownToLine,
  ArrowLeft,
  ArrowRight,
  ArrowUpRight,
  BookOpen,
  Check,
  ChevronRight,
  Clock3,
  Copy,
  Cuboid,
  Film,
  Folder,
  ImagePlus,
  Images,
  Layers3,
  Link2,
  LockKeyhole,
  LogOut,
  LoaderCircle,
  MapPin,
  Plus,
  Search,
  Settings2,
  Sparkles,
  Users,
  X,
} from "lucide-react";
import { createMultiplayerClient } from "./multiplayer";
import MetadataEditor from "./components/MetadataEditor";
import Onboarding from "./components/Onboarding";
import AlbumsView from "./components/AlbumsView";
import ImportProgress from "./components/ImportProgress";
import FoldersView from "./components/FoldersView";
import { friendlyMemoryTitle } from "./memory-labels";
import type {
  Album,
  AlbumSharePreview,
  Chapter,
  ImportJob,
  Memory,
  MemoryFolder,
  MemorySource,
  RoomSnapshot,
  SceneSpec,
} from "./types";

type View =
  | "memories"
  | "folders"
  | "albums"
  | "timeline"
  | "suggested"
  | "worlds"
  | "chapters";
type Modal =
  | "import"
  | "sources"
  | "settings"
  | "room"
  | "album-share"
  | "room-preview"
  | null;
type Health = { [key: string]: unknown };
// Temporary product policy: logout is also the local privacy wipe until accounts exist.
const DELETE_PERSONAL_DATA_ON_LOGOUT = true;
const MemoryWorld = lazy(() => import("./components/MemoryWorld"));
const displayDate = (date: string, options: Intl.DateTimeFormatOptions) =>
  date && !Number.isNaN(Date.parse(date))
    ? new Date(
        date.length === 10 ? `${date}T12:00:00` : date,
      ).toLocaleDateString("en-US", options)
    : "Date not recorded";
const sourceNames: Record<MemorySource, string> = {
  demo: "Sample memory",
  upload: "Your upload",
  "google-photos": "Google Photos",
  instagram: "Instagram",
  linkedin: "LinkedIn",
  youtube: "YouTube",
};

function memoryTimestamp(memory: Memory) {
  // Import time is provenance, not evidence of when the photographed moment
  // happened. Keep unknown capture dates visibly unknown.
  return memory.capturedAt || memory.date || "";
}

function dateGroupLabel(value: string) {
  if (!value || Number.isNaN(Date.parse(value))) return "Undated";
  const date = new Date(value.length === 10 ? `${value}T12:00:00` : value);
  const today = new Date();
  const start = new Date(
    today.getFullYear(),
    today.getMonth(),
    today.getDate(),
  );
  const day = new Date(date.getFullYear(), date.getMonth(), date.getDate());
  const daysAgo = Math.round((start.getTime() - day.getTime()) / 86400000);
  if (daysAgo === 0) return "Today";
  if (daysAgo === 1) return "Yesterday";
  if (date.getFullYear() === today.getFullYear()) {
    return date.toLocaleDateString("en-US", { month: "long", day: "numeric" });
  }
  return date.toLocaleDateString("en-US", { month: "long", year: "numeric" });
}

function albumDateLabel(album: Album) {
  const start = album.dateRange?.start;
  const end = album.dateRange?.end;
  if (!start) return "Date not recorded";
  const startLabel = displayDate(start, {
    month: "short",
    day: "numeric",
    year: "numeric",
  });
  if (!end || end === start) return startLabel;
  return `${startLabel} – ${displayDate(end, { month: "short", day: "numeric", year: "numeric" })}`;
}
async function api<T>(
  path: string,
  body?: unknown,
  signal?: AbortSignal,
): Promise<T> {
  const options: RequestInit =
    body instanceof FormData
      ? { method: "POST", body }
      : body !== undefined
        ? {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify(body),
          }
        : {};
  const response = await fetch(`/api${path}`, { ...options, signal });
  let result;
  try {
    result = await response.json();
  } catch {
    throw new Error(
      "The server is unavailable or restarting. Please try again in a moment.",
    );
  }
  if (!response.ok)
    throw new Error(
      result.error ||
        result.message ||
        "Something went wrong. Please try again.",
    );
  return result;
}
async function patchApi<T>(path: string, body: unknown): Promise<T> {
  const response = await fetch(`/api${path}`, {
    method: "PATCH",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
  const result = await response.json().catch(() => ({}));
  if (!response.ok)
    throw new Error(result.error || "The change could not be saved.");
  return result;
}
function MemoryCard({
  memory,
  onClick,
  jumpable = false,
}: {
  memory: Memory;
  onClick: () => void;
  jumpable?: boolean;
}) {
  return (
    <button className="memory-card" onClick={onClick}>
      <div className="memory-photo">
        {memory.mediaType === "video" && !memory.thumbnailUrl ? (
          <div className="video-placeholder">
            <Film size={34} />
            <span>Video memory</span>
          </div>
        ) : (
          <img
            src={memory.thumbnailUrl || memory.url}
            alt={friendlyMemoryTitle(memory)}
            loading="lazy"
            onError={(e) => {
              e.currentTarget.style.opacity = "0";
            }}
          />
        )}
        <span className="photo-tag">
          {memory.mediaType === "video" ? (
            <Film size={12} />
          ) : (
            <Images size={12} />
          )}{" "}
          {sourceNames[memory.source]}
        </span>
        <span className="photo-open">
          <ArrowUpRight size={20} />
        </span>
      </div>
      <div className="memory-info">
        <p>
          {displayDate(memoryTimestamp(memory), {
            month: "short",
            year: "numeric",
          })}{" "}
          <span>·</span> {memory.location || sourceNames[memory.source]}
        </p>
        <h3>{friendlyMemoryTitle(memory)}</h3>
        <div className="memory-tags">
          {memory.organization?.folderPath?.at(-1) && (
            <span className="folder-chip">
              {memory.organization.folderPath.at(-1)}
            </span>
          )}
          {memory.tags.slice(0, 2).map((tag) => (
            <span key={tag}>{tag}</span>
          ))}
          {jumpable && (
            <span className="scene-label">
              <Cuboid size={13} /> Step inside
            </span>
          )}
        </div>
      </div>
    </button>
  );
}

function MomentShelf({
  albums,
  memories,
  onEnter,
}: {
  albums: Album[];
  memories: Memory[];
  onEnter: (album: Album) => void;
}) {
  const memoryById = new Map(memories.map((memory) => [memory.id, memory]));
  const moments = albums
    .filter(
      (album) =>
        album.type === "suggested" && memoryById.has(album.coverMemoryId),
    )
    .slice(0, 4);
  if (!moments.length) return null;
  return (
    <section className="moment-shelf" aria-labelledby="moment-shelf-title">
      <div className="section-heading moment-shelf-heading">
        <div>
          <span className="eyebrow">
            <Sparkles size={12} /> CURATED FOR REVISITING
          </span>
          <h2 id="moment-shelf-title">
            Good places to step into <span>{moments.length}</span>
          </h2>
        </div>
        <p>
          Again chooses one scene-ready anchor for each event. The rest of your
          photos stay in the gallery.
        </p>
      </div>
      <div className="moment-shelf-grid">
        {moments.map((album) => {
          const cover = memoryById.get(album.coverMemoryId)!;
          return (
            <button
              className="moment-shelf-card"
              key={album.id}
              onClick={() => onEnter(album)}
            >
              <div className="moment-shelf-photo">
                <img
                  src={cover.thumbnailUrl || cover.url}
                  alt=""
                  loading="lazy"
                />
                <span>
                  <Cuboid size={13} /> Enter moment
                </span>
              </div>
              <div className="moment-shelf-copy">
                <small>
                  {albumDateLabel(album)} · {album.memoryIds.length} memories
                </small>
                <h3>{album.title}</h3>
                <p>
                  {album.worldAnchorMemoryId === album.coverMemoryId
                    ? "Wide scene selected for a world"
                    : "A strong cover with a scene-ready world anchor"}
                </p>
              </div>
            </button>
          );
        })}
      </div>
    </section>
  );
}

function recapTitleFor(memory: Memory, album?: Album) {
  if (album?.title.trim()) return album.title.trim();
  const folder = memory.organization?.folderPath?.at(-1)?.trim();
  if (folder && !/^pictures$/i.test(folder)) return folder;
  const timestamp = memoryTimestamp(memory);
  if (timestamp && !Number.isNaN(Date.parse(timestamp))) {
    return `${displayDate(timestamp, { month: "long" }).toLowerCase()} lately`;
  }
  return "moments worth keeping";
}

function ScrapbookBoard({
  hero,
  album,
  memories,
  onOpen,
  onEnter,
}: {
  hero: Memory;
  album?: Album;
  memories: Memory[];
  onOpen: (memory: Memory) => void;
  onEnter: () => void;
}) {
  const byId = new Map(memories.map((memory) => [memory.id, memory]));
  const albumMemories = album
    ? (album.memoryIds.map((id) => byId.get(id)).filter(Boolean) as Memory[])
    : [];
  const supportingMemories =
    hero.source === "demo"
      ? [...memories].sort((left, right) => {
          const ordinary = (memory: Memory) =>
            memory.tags.some((tag) =>
              /family|home|birthday|school|graduation/i.test(tag),
            )
              ? 1
              : 0;
          return ordinary(right) - ordinary(left);
        })
      : memories;
  const candidates = [hero, ...albumMemories, ...supportingMemories];
  const boardMemories = candidates
    .filter(
      (memory, index, all) =>
        all.findIndex((item) => item.id === memory.id) === index,
    )
    .slice(0, 4);
  const title = recapTitleFor(hero, album);

  return (
    <section
      className="scrapbook-board"
      aria-labelledby="scrapbook-recap-title"
    >
      <div className="scrapbook-copy">
        <span>YOUR CURRENT RECAP</span>
        <h2 id="scrapbook-recap-title">{title}</h2>
        <p>
          {album
            ? `${album.memoryIds.length} real moments, gathered together.`
            : "A few real moments from your library."}
        </p>
      </div>
      <div className="scrapbook-rule-note" aria-hidden="true">
        the little things
        <br />
        were the big things <b>↘</b>
      </div>
      <div className="scrapbook-photos">
        {boardMemories.map((memory, index) => (
          <button
            className={`scrapbook-photo scrapbook-photo--${index + 1}`}
            key={memory.id}
            onClick={() => onOpen(memory)}
            aria-label={`Open original: ${friendlyMemoryTitle(memory)}`}
          >
            {memory.mediaType === "video" && !memory.thumbnailUrl ? (
              <span className="video-placeholder">
                <Film size={28} /> Video memory
              </span>
            ) : (
              <img
                src={memory.thumbnailUrl || memory.url}
                alt=""
                loading={index ? "lazy" : "eager"}
              />
            )}
            <span>
              {index === 0
                ? "the one that opens the door"
                : memoryTimestamp(memory)
                  ? displayDate(memoryTimestamp(memory), {
                      month: "short",
                      day: "numeric",
                    })
                  : "undated"}
            </span>
          </button>
        ))}
      </div>
      <div className="scrapbook-actions">
        <span>
          <Images size={14} /> Original photographs preserved
        </span>
        <button onClick={onEnter}>
          <Cuboid size={16} /> Step inside this memory{" "}
          <ArrowUpRight size={15} />
        </button>
      </div>
    </section>
  );
}

export default function App() {
  const returnedToGoogleOnboarding =
    new URLSearchParams(location.search).get("onboarding") === "google";
  const [view, setView] = useState<View>("memories");
  const [memories, setMemories] = useState<Memory[]>([]);
  const [results, setResults] = useState<Memory[] | null>(null);
  const [chapters, setChapters] = useState<Chapter[]>([]);
  const [albums, setAlbums] = useState<Album[]>([]);
  const [folders, setFolders] = useState<MemoryFolder[]>([]);
  const [jobs, setJobs] = useState<ImportJob[]>([]);
  const [query, setQuery] = useState("");
  const [searching, setSearching] = useState(false);
  const [searchNote, setSearchNote] = useState("");
  const [filter, setFilter] = useState<"all" | "image" | "video">("all");
  const [selected, setSelected] = useState<Memory | null>(null);
  const [world, setWorld] = useState<Memory | null>(null);
  const [scene, setScene] = useState<SceneSpec | null>(null);
  const [memoryPortal, setMemoryPortal] = useState<Memory | null>(null);
  const [memoryPortalClosing, setMemoryPortalClosing] = useState(false);
  const memoryPortalTimer = useRef<number | null>(null);
  const [albumWorldMemories, setAlbumWorldMemories] = useState<Memory[]>([]);
  const [albumWorldCurrent, setAlbumWorldCurrent] = useState<Memory | null>(
    null,
  );
  const [shareAlbum, setShareAlbum] = useState<Album | null>(null);
  const [shareIds, setShareIds] = useState<string[]>([]);
  const [sharePreview, setSharePreview] = useState<AlbumSharePreview | null>(
    null,
  );
  const [guestPreview, setGuestPreview] = useState<AlbumSharePreview | null>(
    null,
  );
  const [modal, setModal] = useState<Modal>(null);
  const [busy, setBusy] = useState("");
  const [notice, setNotice] = useState("");
  const [error, setError] = useState("");
  const [health, setHealth] = useState<Health>({});
  const [showOnboarding, setShowOnboarding] = useState(
    () =>
      returnedToGoogleOnboarding ||
      localStorage.getItem("again-onboarding-complete") !== "true",
  );
  const [name, setName] = useState(
    localStorage.getItem("again-name") || "A fellow traveler",
  );
  const [roomCode, setRoomCode] = useState(
    new URLSearchParams(location.search).get("room") || "",
  );
  const [room, setRoom] = useState<RoomSnapshot | null>(null);
  const [profile, setProfile] = useState(
    "https://www.instagram.com/_ryan_ding/",
  );
  const [socialSource, setSocialSource] = useState<
    "instagram" | "linkedin" | "youtube"
  >("instagram");
  const [socialOwnership, setSocialOwnership] = useState(false);
  const [socialConsent, setSocialConsent] = useState(false);
  const [albumUrl, setAlbumUrl] = useState(
    "https://photos.app.goo.gl/BYdzzQJMn45bDYio6",
  );
  const [albumConsent, setAlbumConsent] = useState(false);

  const beginMemoryPortal = useCallback((memory: Memory) => {
    if (memoryPortalTimer.current !== null)
      window.clearTimeout(memoryPortalTimer.current);
    memoryPortalTimer.current = null;
    setMemoryPortalClosing(false);
    setMemoryPortal(memory);
  }, []);
  const finishMemoryPortal = useCallback(() => {
    if (memoryPortalTimer.current !== null)
      window.clearTimeout(memoryPortalTimer.current);
    setMemoryPortalClosing(true);
    memoryPortalTimer.current = window.setTimeout(() => {
      setMemoryPortal(null);
      setMemoryPortalClosing(false);
      memoryPortalTimer.current = null;
    }, 650);
  }, []);
  const cancelMemoryPortal = useCallback(() => {
    if (memoryPortalTimer.current !== null)
      window.clearTimeout(memoryPortalTimer.current);
    memoryPortalTimer.current = null;
    setMemoryPortal(null);
    setMemoryPortalClosing(false);
  }, []);
  useEffect(
    () => () => {
      if (memoryPortalTimer.current !== null)
        window.clearTimeout(memoryPortalTimer.current);
    },
    [],
  );
  const [pickerId, setPickerId] = useState("");
  const [googlePickerLimit, setGooglePickerLimit] = useState(() => {
    const saved = Number(localStorage.getItem("again-google-picker-limit"));
    return [50, 200, 500, 2000].includes(saved) ? saved : 2000;
  });
  const [chapterDraft, setChapterDraft] = useState<Chapter | null>(null);
  const [metadataDraft, setMetadataDraft] = useState<Memory | null>(null);
  const multiplayer = useRef<ReturnType<typeof createMultiplayerClient> | null>(
    null,
  );
  const memoryRef = useRef<Memory[]>([]);
  const searchSequence = useRef(0);
  const sharedContentKey = useRef("");
  const sharedGeneration = useRef(0);
  const sceneRequest = useRef(0);
  const sceneAbort = useRef<AbortController | null>(null);
  const inputRef = useRef<HTMLInputElement>(null);
  const refresh = useCallback(async () => {
    const [list, info, chapterList, albumList, folderList, jobList] =
      await Promise.all([
        api<Memory[] | { memories: Memory[] }>("/memories"),
        api<Health>("/health"),
        api<Chapter[] | { chapters: Chapter[] }>("/chapters"),
        api<{ albums: Album[] }>("/albums"),
        api<{ folders: MemoryFolder[] }>("/folders"),
        api<{ jobs: ImportJob[] }>("/import-jobs"),
      ]);
    const items = Array.isArray(list) ? list : list.memories;
    setMemories(items);
    setResults(
      (previous) =>
        previous?.map(
          (item) => items.find((memory) => memory.id === item.id) || item,
        ) ?? null,
    );
    memoryRef.current = items;
    setHealth(info);
    setChapters(
      Array.isArray(chapterList) ? chapterList : chapterList.chapters,
    );
    setAlbums(albumList.albums);
    setFolders(folderList.folders);
    setJobs(jobList.jobs);
  }, []);
  useEffect(() => {
    refresh().catch((e) => setError(e.message));
    const client = createMultiplayerClient();
    multiplayer.current = client;
    const unsub = client.subscribe(
      (snapshot) => {
        setRoom(snapshot);
        const key = snapshot?.memoryId
          ? JSON.stringify([snapshot.roomId, snapshot.memoryId, snapshot.scene])
          : "";
        if (key === sharedContentKey.current) return;
        sharedContentKey.current = key;
        const generation = ++sharedGeneration.current;
        if (snapshot?.memoryId) {
          const albumState = snapshot.scene?.albumWorld;
          if (albumState) {
            const allowed =
              albumState.sharedMemoryIds || albumState.relatedMemoryIds;
            const related = allowed
              .map((id) => memoryRef.current.find((memory) => memory.id === id))
              .filter(Boolean) as Memory[];
            setAlbumWorldMemories(related);
            setAlbumWorldCurrent(
              related.find(
                (memory) => memory.id === albumState.currentMemoryId,
              ) || null,
            );
          } else {
            setAlbumWorldMemories([]);
            setAlbumWorldCurrent(null);
          }
          const memory = memoryRef.current.find(
            (m) => m.id === snapshot.memoryId,
          );
          if (memory) {
            setWorld(memory);
            setScene(snapshot.scene);
            setSelected(null);
          } else {
            api<Memory[] | { memories: Memory[] }>("/memories")
              .then((list) => {
                if (sharedGeneration.current !== generation) return;
                const all = Array.isArray(list) ? list : list.memories;
                setMemories(all);
                memoryRef.current = all;
                const found = all.find((m) => m.id === snapshot.memoryId);
                if (found) {
                  setWorld(found);
                  setScene(snapshot.scene);
                  const albumState = snapshot.scene?.albumWorld;
                  if (albumState) {
                    const allowed =
                      albumState.sharedMemoryIds || albumState.relatedMemoryIds;
                    const related = allowed
                      .map((id) => all.find((memory) => memory.id === id))
                      .filter(Boolean) as Memory[];
                    setAlbumWorldMemories(related);
                    setAlbumWorldCurrent(
                      related.find(
                        (memory) => memory.id === albumState.currentMemoryId,
                      ) || null,
                    );
                  }
                } else
                  setError(
                    "This room’s memory is not on this server. Open the same app address as your host.",
                  );
              })
              .catch((e) => {
                if (sharedGeneration.current === generation)
                  setError(e.message);
              });
          }
        }
      },
      (e) => setError(e.message),
    );
    if (new URLSearchParams(location.search).has("room")) setModal("room");
    const params = new URLSearchParams(location.search);
    if (
      (params.has("google") || params.has("photos")) &&
      params.get("onboarding") !== "google"
    )
      setModal("sources");
    return () => {
      unsub();
      sharedContentKey.current = "";
      sharedGeneration.current++;
      client.disconnect();
    };
  }, [refresh]);
  useEffect(() => {
    if (
      !jobs.some(
        (job) => job.status === "queued" || job.status === "processing",
      )
    )
      return;
    const timer = window.setInterval(
      () => void refresh().catch((e) => setError(e.message)),
      1200,
    );
    return () => window.clearInterval(timer);
  }, [jobs, refresh]);
  useEffect(() => {
    if (world) window.scrollTo({ top: 0, behavior: "instant" });
  }, [world?.id]);
  useEffect(() => {
    if (!notice) return;
    const timer = setTimeout(() => setNotice(""), 5500);
    return () => clearTimeout(timer);
  }, [notice]);
  useEffect(() => {
    const key = (event: KeyboardEvent) => {
      if (event.key === "Escape") {
        sceneAbort.current?.abort();
        setModal(null);
        setSelected(null);
        setChapterDraft(null);
        setMetadataDraft(null);
        sceneRequest.current++;
        setBusy("");
      }
      if ((event.metaKey || event.ctrlKey) && event.key === "k") {
        event.preventDefault();
        inputRef.current?.focus();
      }
    };
    window.addEventListener("keydown", key);
    return () => window.removeEventListener("keydown", key);
  }, []);
  async function search(text = query) {
    setQuery(text);
    const sequence = ++searchSequence.current;
    if (!text.trim()) {
      setResults(null);
      setSearchNote("");
      return;
    }
    setSearching(true);
    setError("");
    try {
      const result = await api<{
        memories: Memory[];
        mode: string;
        explanation: string;
      }>("/search", { query: text });
      if (sequence === searchSequence.current) {
        setResults(result.memories);
        setSearchNote(
          `${result.explanation} · ${result.mode === "gemini" ? "Gemini search" : "Local search"}`,
        );
        setView("memories");
      }
    } catch (e) {
      setError((e as Error).message);
    } finally {
      if (sequence === searchSequence.current) setSearching(false);
    }
  }
  async function enterMemory(memory: Memory) {
    if (room && room.hostId !== multiplayer.current?.identity) {
      if (room.memoryId === memory.id && room.scene?.reconstruction) {
        beginMemoryPortal(memory);
        setWorld(memory);
        setScene(room.scene);
        setSelected(null);
        return;
      }
      setError(
        "Your host chooses the shared memory. Leave the room to explore on your own.",
      );
      return;
    }
    beginMemoryPortal(memory);
    const request = ++sceneRequest.current;
    sceneAbort.current?.abort();
    const abort = new AbortController();
    sceneAbort.current = abort;
    const client = multiplayer.current;
    const startingRoom = client?.snapshot?.roomId ?? null;
    const generation = sharedGeneration.current;
    setBusy(`scene:${memory.id}`);
    setError("");
    try {
      const result = await api<SceneSpec | { scene: SceneSpec }>(
        `/memories/${memory.id}/scene`,
        {},
        abort.signal,
      );
      if (
        request !== sceneRequest.current ||
        client !== multiplayer.current ||
        (client?.snapshot?.roomId ?? null) !== startingRoom ||
        sharedGeneration.current !== generation
      )
        return;
      const next = "scene" in result ? result.scene : result;
      if (startingRoom) await client?.selectScene(memory.id, next);
      if (
        request === sceneRequest.current &&
        (client?.snapshot?.roomId ?? null) === startingRoom
      ) {
        setScene(next);
        setWorld(memory);
        setSelected(null);
      }
    } catch (e) {
      if (!abort.signal.aborted) {
        if (request === sceneRequest.current) cancelMemoryPortal();
        setError((e as Error).message);
      }
    } finally {
      if (request === sceneRequest.current) setBusy("");
    }
  }
  function closeMemory() {
    sceneAbort.current?.abort();
    sceneRequest.current++;
    setBusy("");
    setSelected(null);
    cancelMemoryPortal();
  }
  async function upload(files: FileList | null, afterImport?: () => void) {
    if (!files?.length) return;
    setBusy("upload");
    setError("");
    try {
      const data = new FormData();
      Array.from(files).forEach((file) => data.append("files", file));
      const result = await api<{
        memories?: Memory[];
        warnings?: string[];
        statuses?: { id: string; status: string }[];
        message?: string;
      }>("/upload", data);
      await refresh();
      setResults(null);
      setModal(null);
      setNotice(
        result.warnings?.join(" ") ||
          [...new Set(result.statuses?.map((item) => item.status) || [])].join(
            " ",
          ) ||
          "Memories added to your library.",
      );
      afterImport?.();
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setBusy("");
    }
  }
  async function reorganizeFolders() {
    setBusy("reorganize");
    setError("");
    try {
      const result = await api<{
        folders: MemoryFolder[];
        summary: {
          kept: number;
          renamed: number;
          rejected: number;
          reviewed: number;
          local: number;
        };
      }>("/folders/reorganize", {
        timeZone: Intl.DateTimeFormat().resolvedOptions().timeZone,
      });
      await refresh();
      setNotice(
        result.summary.reviewed
          ? `Gemini reviewed ${result.summary.reviewed} memories: ${result.summary.kept} folders made sense and were kept, ${result.summary.renamed} renamed.`
          : "Folders re-sorted locally.",
      );
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setBusy("");
    }
  }
  async function connectGoogle(context: "onboarding" | "sources" = "sources") {
    setBusy("google");
    setError("");
    try {
      const result = await api<{ url: string }>(
        `/integrations/google/auth-url?context=${context}`,
      );
      location.href = result.url;
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setBusy("");
    }
  }
  async function pickGoogle() {
    setBusy("picker");
    setError("");
    const pickerWindow = window.open("about:blank", "again-google-photos");
    try {
      const result = await api<{ id: string; pickerUri: string }>(
        // Reopen the current picker session when there is one; otherwise create one with the chosen limit.
        pickerId
          ? `/integrations/google/picker/${encodeURIComponent(pickerId)}`
          : "/integrations/google/picker",
        pickerId ? undefined : { maxItemCount: googlePickerLimit },
      );
      setPickerId(result.id);
      if (pickerWindow) {
        pickerWindow.opener = null;
        pickerWindow.location.replace(result.pickerUri);
      } else window.open(result.pickerUri, "_blank", "noopener,noreferrer");
      setNotice(
        `Google lets you choose up to ${googlePickerLimit.toLocaleString()} moments in this session. Select them in the picker, then return here to start processing.`,
      );
    } catch (e) {
      pickerWindow?.close();
      setError((e as Error).message);
    } finally {
      setBusy("");
    }
  }
  async function finishPicker(): Promise<{
    imported: number;
    warnings: string[];
  } | null> {
    setBusy("picker-import");
    setError("");
    try {
      const result = await api<{ jobId: string; job: ImportJob }>(
        `/integrations/google/picker/${pickerId}/import`,
        { timeZone: Intl.DateTimeFormat().resolvedOptions().timeZone },
      );
      await refresh();
      setPickerId("");
      setModal(null);
      setJobs((current) => [
        result.job,
        ...current.filter((job) => job.id !== result.jobId),
      ]);
      setNotice(
        "Your Google Photos selection is safely processing in the background.",
      );
      return { imported: result.job.totalItems, warnings: [] };
    } catch (e) {
      setError((e as Error).message);
      return null;
    } finally {
      setBusy("");
    }
  }
  async function enterAlbumWorld(album: Album) {
    const portalMemory = memories.find(
      (memory) => memory.id === album.worldAnchorMemoryId,
    );
    if (portalMemory) beginMemoryPortal(portalMemory);
    setBusy(`album-world:${album.id}`);
    setError("");
    try {
      const result = await api<{
        album: Album;
        anchor: Memory;
        memories: Memory[];
        scene: SceneSpec;
      }>(`/albums/${album.id}/world`, {});
      setWorld(result.anchor);
      setScene(result.scene);
      setAlbumWorldMemories(result.memories);
      setAlbumWorldCurrent(result.anchor);
    } catch (e) {
      cancelMemoryPortal();
      setError((e as Error).message);
    } finally {
      setBusy("");
    }
  }
  async function updateAlbum(
    id: string,
    changes: {
      title?: string;
      type?: "confirmed";
      addMemoryIds?: string[];
      removeMemoryIds?: string[];
      coverMemoryId?: string;
      worldAnchorMemoryId?: string;
    },
  ) {
    setBusy(`album:${id}`);
    setError("");
    try {
      await patchApi(`/albums/${id}`, changes);
      await refresh();
      setNotice("Album updated.");
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setBusy("");
    }
  }
  async function createAlbum(title: string, memoryIds: string[]) {
    setBusy("album-create");
    setError("");
    try {
      await api("/albums", { title, memoryIds });
      await refresh();
      setNotice("Private album created.");
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setBusy("");
    }
  }
  async function openAlbumShare(album: Album) {
    setError("");
    try {
      const preview = await api<AlbumSharePreview>(
        `/albums/${album.id}/share-preview`,
        { memoryIds: album.memoryIds },
      );
      setShareAlbum(album);
      setShareIds(preview.memoryIds);
      setSharePreview(preview);
      setModal("album-share");
    } catch (e) {
      setError((e as Error).message);
    }
  }
  async function changeShareSelection(memoryId: string) {
    if (!shareAlbum) return;
    const next = shareIds.includes(memoryId)
      ? shareIds.filter((id) => id !== memoryId)
      : [...shareIds, memoryId];
    if (!next.length) return;
    setShareIds(next);
    try {
      setSharePreview(
        await api<AlbumSharePreview>(`/albums/${shareAlbum.id}/share-preview`, {
          memoryIds: next,
        }),
      );
    } catch (e) {
      setError((e as Error).message);
    }
  }
  async function selectAlbumMemory(memory: Memory) {
    if (!scene?.albumWorld || !world) return;
    if (room && room.hostId !== multiplayer.current?.identity) {
      setError("Your host chooses which album memory everyone is viewing.");
      return;
    }
    const allowed =
      scene.albumWorld.sharedMemoryIds || scene.albumWorld.relatedMemoryIds;
    if (!allowed.includes(memory.id)) return;
    const next: SceneSpec = {
      ...scene,
      albumWorld: { ...scene.albumWorld, currentMemoryId: memory.id },
    };
    setScene(next);
    setAlbumWorldCurrent(memory);
    if (room) await multiplayer.current?.selectScene(world.id, next);
  }
  async function shareAlbumWorld() {
    if (!shareAlbum || !shareIds.length) return;
    if (room && room.hostId !== multiplayer.current?.identity) {
      setError("Only the room host can share an album world.");
      return;
    }
    setBusy("album-share");
    setError("");
    try {
      let anchor = world;
      let baseScene = scene;
      let related = albumWorldMemories;
      if (
        !baseScene?.albumWorld ||
        baseScene.albumWorld.albumId !== shareAlbum.id ||
        !anchor
      ) {
        const result = await api<{
          anchor: Memory;
          memories: Memory[];
          scene: SceneSpec;
        }>(`/albums/${shareAlbum.id}/world`, {});
        anchor = result.anchor;
        baseScene = result.scene;
        related = result.memories;
      }
      const state = baseScene.albumWorld!;
      const currentMemoryId = shareIds.includes(state.currentMemoryId)
        ? state.currentMemoryId
        : shareIds[0];
      const sharedScene: SceneSpec = {
        ...baseScene,
        albumWorld: { ...state, currentMemoryId, sharedMemoryIds: shareIds },
      };
      const visible = shareIds
        .map(
          (id) =>
            related.find((memory) => memory.id === id) ||
            memoryRef.current.find((memory) => memory.id === id),
        )
        .filter(Boolean) as Memory[];
      setWorld(anchor);
      setScene(sharedScene);
      setAlbumWorldMemories(visible);
      setAlbumWorldCurrent(
        visible.find((memory) => memory.id === currentMemoryId) || null,
      );
      if (room) await multiplayer.current?.selectScene(anchor.id, sharedScene);
      else {
        localStorage.setItem("again-name", name);
        const device = /Quest|Oculus/i.test(navigator.userAgent)
          ? "vr"
          : /Mobile|Android|iPhone/i.test(navigator.userAgent)
            ? "mobile"
            : "desktop";
        await multiplayer.current!.create(name, device);
        await multiplayer.current!.selectScene(anchor.id, sharedScene);
      }
      setModal(null);
      setNotice("The selected album memories are now shared in this room.");
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setBusy("");
    }
  }
  async function importSocial(
    profileOverride = profile,
    ownershipOverride = socialOwnership,
    consentOverride = socialConsent,
    stayInOnboarding = false,
  ): Promise<{ imported: number; warnings: string[] } | null> {
    setBusy("social");
    setError("");
    try {
      const result = await api<{
        memories?: Memory[];
        message?: string;
        warnings?: string[];
      }>("/integrations/apify/import", {
        source: socialSource,
        profileUrl: profileOverride,
        limit: 6,
        confirmOwnership: ownershipOverride,
        confirmConsent: consentOverride,
        timeZone: Intl.DateTimeFormat().resolvedOptions().timeZone,
      });
      await refresh();
      setResults(null);
      setNotice(
        result.message ||
          `Imported ${result.memories?.length ?? ""} memories. ${result.warnings?.join(" ") || ""}`,
      );
      if (!stayInOnboarding) setModal(null);
      return {
        imported: result.memories?.length || 0,
        warnings: result.warnings || [],
      };
    } catch (e) {
      setError((e as Error).message);
      return null;
    } finally {
      setBusy("");
    }
  }
  async function importSharedAlbum() {
    setBusy("album");
    setError("");
    try {
      const result = await api<{ imported: number; warnings?: string[] }>(
        "/integrations/apify/google-photos-album",
        {
          albumUrl,
          limit: 12,
          confirmConsent: albumConsent,
          timeZone: Intl.DateTimeFormat().resolvedOptions().timeZone,
        },
      );
      await refresh();
      setResults(null);
      setNotice(
        `Imported ${result.imported} photos from the shared album. ${result.warnings?.join(" ") || ""}`,
      );
      setModal(null);
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setBusy("");
    }
  }
  async function connectRoom(join: boolean) {
    setBusy("room");
    setError("");
    try {
      localStorage.setItem("again-name", name);
      const device = /Quest|Oculus/i.test(navigator.userAgent)
        ? "vr"
        : /Mobile|Android|iPhone/i.test(navigator.userAgent)
          ? "mobile"
          : "desktop";
      if (join) await multiplayer.current!.join(roomCode, name, device);
      else {
        await multiplayer.current!.create(name, device);
        if (world) {
          let sharedScene = scene;
          if (sharedScene?.albumWorld && shareAlbum && shareIds.length) {
            const currentMemoryId = shareIds.includes(
              sharedScene.albumWorld.currentMemoryId,
            )
              ? sharedScene.albumWorld.currentMemoryId
              : shareIds[0];
            sharedScene = {
              ...sharedScene,
              albumWorld: {
                ...sharedScene.albumWorld,
                currentMemoryId,
                sharedMemoryIds: shareIds,
              },
            };
            setScene(sharedScene);
            setAlbumWorldCurrent(
              memoryRef.current.find(
                (memory) => memory.id === currentMemoryId,
              ) || null,
            );
            setAlbumWorldMemories(
              shareIds
                .map((id) =>
                  memoryRef.current.find((memory) => memory.id === id),
                )
                .filter(Boolean) as Memory[],
            );
          }
          await multiplayer.current!.selectScene(world.id, sharedScene);
        }
      }
      if (join) {
        const snapshot = multiplayer.current?.snapshot;
        const state = snapshot?.scene?.albumWorld;
        if (state) {
          const ids = state.sharedMemoryIds || state.relatedMemoryIds;
          const visible = ids
            .map((id) => memoryRef.current.find((memory) => memory.id === id))
            .filter(Boolean) as Memory[];
          const album = albums.find((item) => item.id === state.albumId);
          setGuestPreview({
            albumId: state.albumId,
            title: album?.title || "Shared album world",
            totalMedia: visible.length,
            memoryIds: ids,
            memories: visible.map(
              ({ id, title, mediaType, thumbnailUrl, source }) => ({
                id,
                title,
                mediaType,
                thumbnailUrl,
                source,
              }),
            ),
            sources: [...new Set(visible.map((memory) => memory.source))],
          });
          setModal("room-preview");
        } else setModal(null);
      } else setModal(null);
      setNotice(
        join
          ? "You’re in. Make a memory together."
          : "Your shared room is ready.",
      );
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setBusy("");
    }
  }
  async function copyInvite() {
    if (!room) return;
    const link = new URL(location.href);
    link.search = `?room=${room.code}`;
    try {
      await navigator.clipboard.writeText(link.toString());
      setNotice("Invitation link copied.");
    } catch {
      setNotice(
        `Room code: ${room.code}. Open this app address on your other device.`,
      );
    }
  }
  function draftChapter(memory?: Memory) {
    const sources = memory ? [memory] : (results || memories).slice(0, 6);
    setChapterDraft({
      id: crypto.randomUUID(),
      title: memory?.title || query || "A chapter worth keeping",
      body: sources.map((m) => `${m.title}\n${m.description}`).join("\n\n"),
      memoryIds: sources.map((m) => m.id),
      updatedAt: new Date().toISOString(),
    });
    setSelected(null);
  }
  async function saveChapter() {
    if (!chapterDraft) return;
    setBusy("chapter");
    try {
      await api("/chapters", chapterDraft);
      await refresh();
      setChapterDraft(null);
      setView("chapters");
      setWorld(null);
      setNotice("A little piece of your life, kept.");
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setBusy("");
    }
  }
  async function leaveRoom() {
    setBusy("leaving");
    try {
      await multiplayer.current?.leave();
      setRoom(null);
      setNotice("You left the shared room.");
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setBusy("");
    }
  }
  const dialogOpen = Boolean(
    modal || selected || chapterDraft || metadataDraft,
  );
  useEffect(() => {
    if (!dialogOpen) return;
    const previouslyFocused = document.activeElement as HTMLElement | null;
    const frame = requestAnimationFrame(() =>
      document
        .querySelector<HTMLElement>(
          '[role="dialog"] input, [role="dialog"] button',
        )
        ?.focus(),
    );
    const trap = (event: KeyboardEvent) => {
      if (event.key !== "Tab") return;
      const focusable = Array.from(
        document.querySelectorAll<HTMLElement>(
          '[role="dialog"] button:not(:disabled), [role="dialog"] input:not(:disabled), [role="dialog"] textarea, [role="dialog"] select, [role="dialog"] a[href]',
        ),
      );
      const first = focusable[0],
        last = focusable[focusable.length - 1];
      if (event.shiftKey && document.activeElement === first) {
        event.preventDefault();
        last?.focus();
      } else if (!event.shiftKey && document.activeElement === last) {
        event.preventDefault();
        first?.focus();
      }
    };
    document.addEventListener("keydown", trap);
    return () => {
      cancelAnimationFrame(frame);
      document.removeEventListener("keydown", trap);
      previouslyFocused?.focus();
    };
  }, [dialogOpen]);
  const shown = (results || memories).filter(
    (m) => filter === "all" || m.mediaType === filter,
  );
  const suggestedAlbums = albums.filter((album) => album.type === "suggested");
  const memoryById = new Map(memories.map((memory) => [memory.id, memory]));
  const jumpableIds = new Set(
    suggestedAlbums.map((album) => album.worldAnchorMemoryId).filter(Boolean),
  );
  const hero =
    memoryById.get(suggestedAlbums[0]?.coverMemoryId || "") ||
    memories.find((memory) => memory.source !== "demo") ||
    memories.find((memory) =>
      memory.tags.some((tag) =>
        /family|home|birthday|school|graduation/i.test(tag),
      ),
    ) ||
    memories[0];
  const heroAlbum = suggestedAlbums.find(
    (album) => album.coverMemoryId === hero?.id,
  );
  const connected = health.integrations as Record<string, unknown> | undefined;
  const googleReady = Boolean(
    connected?.googlePhotos &&
    typeof connected.googlePhotos === "object" &&
    (connected.googlePhotos as { connected?: boolean }).connected,
  );
  const googleConfigured = Boolean(
    connected?.googlePhotos &&
    typeof connected.googlePhotos === "object" &&
    (connected.googlePhotos as { configured?: boolean }).configured,
  );
  function finishOnboarding() {
    localStorage.setItem("again-onboarding-complete", "true");
    setShowOnboarding(false);
    setView("folders");
    const url = new URL(location.href);
    url.searchParams.delete("google");
    url.searchParams.delete("photos");
    url.searchParams.delete("onboarding");
    history.replaceState({}, "", `${url.pathname}${url.search}${url.hash}`);
  }
  async function logoutAndReset() {
    setBusy("logout");
    setError("");
    const operations = await Promise.allSettled([
      DELETE_PERSONAL_DATA_ON_LOGOUT
        ? api<{ cleared: boolean }>("/account/clear-personal-data", {
            confirm: true,
          })
        : Promise.resolve({ cleared: false }),
      api<{ disconnected: boolean }>("/integrations/google/disconnect", {}),
      room ? multiplayer.current?.leave() : Promise.resolve(),
    ]);
    localStorage.removeItem("again-onboarding-complete");
    localStorage.removeItem("again-name");
    localStorage.removeItem("again-google-picker-limit");
    setName("A fellow traveler");
    setGooglePickerLimit(2000);
    setPickerId("");
    setRoom(null);
    setWorld(null);
    setScene(null);
    setSelected(null);
    setResults(null);
    setAlbumWorldMemories([]);
    setAlbumWorldCurrent(null);
    setShareAlbum(null);
    setShareIds([]);
    setSharePreview(null);
    setGuestPreview(null);
    setModal(null);
    setView("folders");
    const url = new URL(location.href);
    url.search = "";
    url.hash = "";
    history.replaceState({}, "", url.pathname || "/");
    await refresh().catch(() => {});
    setShowOnboarding(true);
    setBusy("");
    if (operations.some((operation) => operation.status === "rejected")) {
      setError(
        "The local session was reset, but cleanup or one remote connection may still need attention.",
      );
    }
  }

  return (
    <div className={`app-shell${world ? " app-shell--world" : ""}`}>
      {showOnboarding && (
        <Onboarding
          memories={memories}
          googleConfigured={googleConfigured}
          googleConnected={googleReady}
          pickerId={pickerId}
          busy={busy}
          error={error}
          returnedFromGoogle={returnedToGoogleOnboarding}
          onConnectGoogle={() => connectGoogle("onboarding")}
          onOpenGooglePicker={pickGoogle}
          onImportGoogle={finishPicker}
          onImportInstagram={(instagramProfile, ownership, consent) =>
            importSocial(instagramProfile, ownership, consent, true)
          }
          onChooseFiles={upload}
          onClearError={() => setError("")}
          onFinish={finishOnboarding}
        />
      )}
      {memoryPortal && (
        <div
          className={`memory-portal${memoryPortalClosing ? " memory-portal--closing" : ""}`}
          role="status"
          aria-live="polite"
          aria-label={`Opening ${friendlyMemoryTitle(memoryPortal)}`}
        >
          <div className="memory-portal__paper memory-portal__paper--left" />
          <div className="memory-portal__paper memory-portal__paper--right" />
          <div className="memory-portal__photo-frame">
            <img src={memoryPortal.thumbnailUrl || memoryPortal.url} alt="" />
          </div>
          <div className="memory-portal__copy">
            <span>STEP CLOSER</span>
            <strong>{friendlyMemoryTitle(memoryPortal)}</strong>
            <small>
              Moving through the photograph into your point of view…
            </small>
          </div>
        </div>
      )}
      {metadataDraft && (
        <MetadataEditor
          memory={metadataDraft}
          onClose={() => setMetadataDraft(null)}
          onSaved={(memory) => {
            setMetadataDraft(null);
            setSelected(memory);
            void refresh().catch((e) => setError(e.message));
            setNotice("Your memory details are saved.");
          }}
        />
      )}
      <aside className="sidebar">
        <a className="brand" href="/" aria-label="Again home">
          <span className="brand-mark">✳</span>again
          <span className="brand-dot">.</span>
        </a>
        <p className="brand-caption">A little closer to your life.</p>
        <div className="sidebar-label">YOUR STORY</div>
        <nav>
          {(
            [
              { id: "folders", label: "Folders", icon: Folder },
              { id: "albums", label: "Albums", icon: Layers3 },
              { id: "timeline", label: "Timeline", icon: Clock3 },
              { id: "suggested", label: "Suggested albums", icon: Sparkles },
              { id: "worlds", label: "Worlds", icon: Cuboid },
              { id: "chapters", label: "Chapters", icon: BookOpen },
              { id: "memories", label: "All memories", icon: Images },
            ] as const
          ).map((item) => (
            <button
              key={item.id}
              className={
                view === item.id && !world ? "nav-item active" : "nav-item"
              }
              onClick={() => {
                setView(item.id);
                setWorld(null);
                setAlbumWorldMemories([]);
                setAlbumWorldCurrent(null);
              }}
            >
              <item.icon size={18} />
              {item.label}
              {item.id === "memories" && <span>{memories.length}</span>}
              {item.id === "albums" && <span>{albums.length}</span>}
              {item.id === "suggested" && (
                <span>
                  {albums.filter((album) => album.type === "suggested").length}
                </span>
              )}
            </button>
          ))}
        </nav>
        <div className="sidebar-label second">BETTER TOGETHER</div>
        <button className="nav-item" onClick={() => setModal("room")}>
          <Users size={18} />
          Shared rooms{room && <i className="live-dot" />}
        </button>
        <button className="nav-item" onClick={() => setModal("sources")}>
          <Link2 size={18} />
          Connected sources
        </button>
        <button className="nav-item" onClick={() => setModal("settings")}>
          <Settings2 size={18} />
          Settings
        </button>
        <div className="sidebar-bottom">
          <div className="invite-card">
            <div className="invite-people">
              <span>Y</span>
              <span>+</span>
            </div>
            <h4>Remember it together.</h4>
            <p>Some stories need more than one storyteller.</p>
            <button onClick={() => setModal("room")}>
              Invite someone <ArrowUpRight size={15} />
            </button>
          </div>
          <button className="profile-row" onClick={() => setModal("room")}>
            <span className="profile-avatar">
              {name.slice(0, 1).toUpperCase()}
            </span>
            <div>
              <strong>Your personal memoir</strong>
              <small>
                {room ? "In a shared room" : "Made of your moments"}
              </small>
            </div>
            <Settings2 size={16} />
          </button>
        </div>
      </aside>
      <main className="main">
        <header className="topbar">
          <div className="breadcrumb">
            Your story <ChevronRight size={14} />
            <strong>
              {world
                ? "Inside a memory"
                : view === "chapters"
                  ? "Chapters"
                  : view === "folders"
                    ? "Folders"
                    : view === "timeline"
                      ? "Timeline"
                      : view === "albums"
                        ? "Albums"
                        : view === "suggested"
                          ? "Suggested albums"
                          : view === "worlds"
                            ? "Worlds"
                            : "All memories"}
            </strong>
          </div>
          <div className="topbar-actions">
            {room ? (
              <button
                className="status-pill online"
                onClick={() => setModal("room")}
              >
                <span className="live-dot" />
                {room.members.length} here together
              </button>
            ) : (
              <span className="status-pill">
                <span className="small-dot" />
                {memories.some((m) => m.source !== "demo")
                  ? "Personal library"
                  : "Sample collection"}
              </span>
            )}
            <button
              className="button secondary small"
              onClick={() => void logoutAndReset()}
              disabled={Boolean(busy)}
              title="Delete local memories, disconnect sources, and restart onboarding"
            >
              {busy === "logout" ? (
                <LoaderCircle className="spin" size={16} />
              ) : (
                <LogOut size={16} />
              )}
              Log out & delete files
            </button>
            <button
              className="button primary small"
              onClick={() => setModal("import")}
            >
              <Plus size={17} />
              Add memories
            </button>
          </div>
        </header>
        {error && (
          <div role="alert" className="error-banner">
            {error}
            <button onClick={() => setError("")} aria-label="Dismiss error">
              <X size={16} />
            </button>
          </div>
        )}
        {world ? (
          <section className="world-page">
            <div className="world-heading">
              <button
                className="text-button"
                onClick={() => {
                  cancelMemoryPortal();
                  setWorld(null);
                  setAlbumWorldMemories([]);
                  setAlbumWorldCurrent(null);
                }}
              >
                <ArrowLeft size={16} />
                Back to your memories
              </button>
              <button
                className="button secondary small"
                onClick={() => {
                  const album =
                    scene?.albumWorld &&
                    albums.find(
                      (item) => item.id === scene.albumWorld?.albumId,
                    );
                  if (album) void openAlbumShare(album);
                  else setModal("room");
                }}
              >
                <Users size={16} />
                {scene?.albumWorld
                  ? "Choose what guests see"
                  : room
                    ? "Invite to this room"
                    : "Remember together"}
              </button>
            </div>
            <Suspense
              fallback={
                <div className="world-loading">
                  <LoaderCircle className="spin" />
                  Opening your memory…
                </div>
              }
            >
              <MemoryWorld
                memory={world}
                scene={scene}
                participants={
                  room?.members.filter(
                    (p) => p.id !== multiplayer.current?.identity,
                  ) || []
                }
                onPose={(pose) => {
                  if (room)
                    void multiplayer.current?.updatePose(pose).catch(() => {});
                }}
                onReady={finishMemoryPortal}
              />
            </Suspense>
            {scene?.albumWorld && albumWorldMemories.length > 0 && (
              <div className="album-world-tray">
                <div>
                  <strong>Memories in this world</strong>
                  <small>
                    {room
                      ? "The host guides what everyone is viewing."
                      : "The reconstructed anchor stays in place while you revisit each moment."}
                  </small>
                </div>
                <div className="album-world-strip">
                  {albumWorldMemories.map((memory, index) => (
                    <button
                      key={memory.id}
                      className={
                        albumWorldCurrent?.id === memory.id ? "active" : ""
                      }
                      onClick={() => void selectAlbumMemory(memory)}
                      disabled={Boolean(
                        room && room.hostId !== multiplayer.current?.identity,
                      )}
                    >
                      <img src={memory.thumbnailUrl || memory.url} alt="" />
                      <span>{String(index + 1).padStart(2, "0")}</span>
                    </button>
                  ))}
                </div>
                <p>{scene.albumWorld.geometryNotice}</p>
              </div>
            )}
            <div className="world-caption">
              <div>
                <span className="eyebrow">
                  {scene?.albumWorld
                    ? "CURRENT MEMORY · ORIGINAL PRESERVED"
                    : "THE ORIGINAL, ALWAYS HERE"}
                </span>
                <h2>{albumWorldCurrent?.title || world.title}</h2>
                <p>{albumWorldCurrent?.description || world.description}</p>
              </div>
              <button
                className="button secondary"
                onClick={() => setSelected(albumWorldCurrent || world)}
              >
                <Images size={17} />
                View original
              </button>
            </div>
          </section>
        ) : (
          <div className="page-content">
            <ImportProgress jobs={jobs} />
            <section className="page-intro">
              <div>
                <div className="eyebrow">
                  <span className="tiny-spark">✳</span> EVERY MOMENT HAS A PLACE
                </div>
                <h1
                  className={
                    view === "memories" ? "scrapbook-page-title" : undefined
                  }
                >
                  {view === "chapters" ? (
                    <>
                      The chapters of <em>you.</em>
                    </>
                  ) : view === "timeline" ? (
                    <>
                      A life, <em>unfolding.</em>
                    </>
                  ) : view === "albums" ? (
                    <>
                      The moments that <em>belong together.</em>
                    </>
                  ) : view === "folders" ? (
                    <>
                      Your memories, <em>in their places.</em>
                    </>
                  ) : view === "suggested" ? (
                    <>
                      Events, gently <em>gathered.</em>
                    </>
                  ) : view === "worlds" ? (
                    <>
                      Step into a <em>whole chapter.</em>
                    </>
                  ) : (
                    <>
                      Your memory <em>scrapbook.</em>
                    </>
                  )}
                </h1>
                <p>
                  {view === "chapters"
                    ? "Keep the stories behind the photos, in your own words."
                    : view === "timeline"
                      ? "Follow the thread. See how far you’ve come."
                      : view === "albums"
                        ? "Private collections built from the memories you choose."
                        : view === "folders"
                          ? "A general Pictures folder, automatic categories, and every individual memory inside them."
                          : view === "suggested"
                            ? "Explainable groups based on time, visual similarity, words and source context."
                            : view === "worlds"
                              ? "One reconstructed anchor, with the related moments close at hand."
                              : "Find the moments that made you. Step back in, together."}
                </p>
              </div>
              <div className="intro-note">
                For the things
                <br />
                you never want to forget.<span>↙</span>
              </div>
            </section>
            {(view === "memories" || view === "timeline") && (
              <section className="search-section">
                <form
                  className="search-box"
                  onSubmit={(e) => {
                    e.preventDefault();
                    void search();
                  }}
                >
                  <Search size={22} />
                  <input
                    ref={inputRef}
                    value={query}
                    onChange={(e) => setQuery(e.target.value)}
                    placeholder="What would you like to remember?"
                    aria-label="Search your memories"
                  />
                  {query && (
                    <button
                      type="button"
                      className="clear-search"
                      onClick={() => {
                        setQuery("");
                        setResults(null);
                        setSearchNote("");
                        searchSequence.current++;
                        setSearching(false);
                      }}
                      aria-label="Clear search"
                    >
                      <X size={17} />
                    </button>
                  )}
                  <span className="search-shortcut">⌘ K</span>
                  <button
                    className="search-submit"
                    aria-label="Find memories"
                    disabled={searching}
                  >
                    {searching ? (
                      <LoaderCircle className="spin" size={20} />
                    ) : (
                      <ArrowRight size={20} />
                    )}
                  </button>
                </form>
                <div className="suggestions">
                  <span>A little inspiration</span>
                  {[
                    "Late nights with friends",
                    "Moments from school",
                    "Around the family table",
                  ].map((text) => (
                    <button key={text} onClick={() => void search(text)}>
                      {text}
                      <ArrowUpRight size={12} />
                    </button>
                  ))}
                </div>
              </section>
            )}
            {view === "memories" && !results && hero && (
              <ScrapbookBoard
                hero={hero}
                album={heroAlbum}
                memories={memories}
                onOpen={setSelected}
                onEnter={() =>
                  heroAlbum
                    ? void enterAlbumWorld(heroAlbum)
                    : void enterMemory(hero)
                }
              />
            )}
            {view === "memories" && !results && (
              <MomentShelf
                albums={suggestedAlbums}
                memories={memories}
                onEnter={(album) => void enterAlbumWorld(album)}
              />
            )}
            {view === "folders" ? (
              <FoldersView
                folders={folders}
                memories={memories}
                onSelect={setSelected}
                onReorganize={() => void reorganizeFolders()}
                reorganizing={busy === "reorganize"}
              />
            ) : view === "albums" ||
              view === "suggested" ||
              view === "worlds" ? (
              <AlbumsView
                albums={albums}
                memories={memories}
                mode={view}
                busy={busy}
                onUpdate={updateAlbum}
                onCreate={createAlbum}
                onEnterWorld={enterAlbumWorld}
                onShare={(album) => void openAlbumShare(album)}
              />
            ) : view === "chapters" ? (
              <section>
                <div className="section-heading">
                  <h2>
                    Your stories <span>{chapters.length}</span>
                  </h2>
                  <button
                    className="button secondary small"
                    onClick={() => draftChapter()}
                    disabled={!memories.length}
                  >
                    <Plus size={16} />
                    New chapter
                  </button>
                </div>
                {chapters.length ? (
                  <div className="chapter-grid">
                    {chapters.map((chapter, index) => (
                      <button
                        className="chapter-card"
                        key={chapter.id}
                        onClick={() => setChapterDraft(chapter)}
                      >
                        <span className="chapter-number">
                          CHAPTER {String(index + 1).padStart(2, "0")}
                        </span>
                        <BookOpen size={30} />
                        <h3>{chapter.title}</h3>
                        <p>{chapter.body}</p>
                        <span>
                          {chapter.memoryIds.length} source memories{" "}
                          <ArrowUpRight size={16} />
                        </span>
                      </button>
                    ))}
                  </div>
                ) : (
                  <div className="empty-state">
                    <BookOpen size={40} />
                    <h2>
                      Photos hold a moment.
                      <br />
                      Stories give it a home.
                    </h2>
                    <p>
                      Choose a memory and build your first chapter.
                      <br />
                      You can edit every word and keep the originals alongside
                      it.
                    </p>
                    <button
                      className="button primary"
                      onClick={() => draftChapter()}
                      disabled={!memories.length}
                    >
                      Start a chapter
                      <ArrowRight size={16} />
                    </button>
                  </div>
                )}
              </section>
            ) : (
              <section className="library-section">
                <div className="section-heading">
                  <h2>
                    {results
                      ? "Found in your life"
                      : view === "timeline"
                        ? "Through the years"
                        : "Your memories"}{" "}
                    <span>{shown.length}</span>
                  </h2>
                  <div className="filters">
                    {(
                      [
                        { key: "all", label: "All memories" },
                        { key: "image", label: "Photos" },
                        { key: "video", label: "Videos" },
                      ] as const
                    ).map((item) => (
                      <button
                        key={item.key}
                        className={filter === item.key ? "selected" : ""}
                        onClick={() => setFilter(item.key)}
                      >
                        {item.label}
                      </button>
                    ))}
                  </div>
                </div>
                {searchNote && (
                  <div className="search-note">
                    <Sparkles size={14} />
                    {searchNote}
                    <button onClick={() => draftChapter()}>
                      Keep as a chapter <ArrowUpRight size={13} />
                    </button>
                  </div>
                )}
                {view === "timeline" ? (
                  <div className="timeline">
                    {[
                      ...new Set(
                        shown.map((m) =>
                          m.date ? m.date.slice(0, 4) : "Undated",
                        ),
                      ),
                    ]
                      .sort()
                      .reverse()
                      .map((year) => (
                        <div className="timeline-year" key={year}>
                          <h2>{year}</h2>
                          <div className="memory-grid">
                            {shown
                              .filter((m) =>
                                year === "Undated"
                                  ? !m.date
                                  : m.date.startsWith(year),
                              )
                              .map((memory) => (
                                <MemoryCard
                                  key={memory.id}
                                  memory={memory}
                                  jumpable={jumpableIds.has(memory.id)}
                                  onClick={() => setSelected(memory)}
                                />
                              ))}
                          </div>
                        </div>
                      ))}
                  </div>
                ) : view === "memories" && !results ? (
                  <div className="photo-date-groups">
                    {[
                      ...new Set(
                        shown.map((memory) =>
                          dateGroupLabel(memoryTimestamp(memory)),
                        ),
                      ),
                    ].map((label) => (
                      <section className="photo-date-group" key={label}>
                        <div className="photo-date-heading">
                          <h3>{label}</h3>
                          <span>
                            {
                              shown.filter(
                                (memory) =>
                                  dateGroupLabel(memoryTimestamp(memory)) ===
                                  label,
                              ).length
                            }
                          </span>
                        </div>
                        <div className="memory-grid">
                          {shown
                            .filter(
                              (memory) =>
                                dateGroupLabel(memoryTimestamp(memory)) ===
                                label,
                            )
                            .map((memory) => (
                              <MemoryCard
                                key={memory.id}
                                memory={memory}
                                jumpable={jumpableIds.has(memory.id)}
                                onClick={() => setSelected(memory)}
                              />
                            ))}
                        </div>
                      </section>
                    ))}
                  </div>
                ) : (
                  <div className="memory-grid">
                    {shown.map((memory) => (
                      <MemoryCard
                        key={memory.id}
                        memory={memory}
                        jumpable={jumpableIds.has(memory.id)}
                        onClick={() => setSelected(memory)}
                      />
                    ))}
                  </div>
                )}
                {!shown.length && (
                  <div className="empty-state">
                    <Search size={34} />
                    <h2>
                      {results
                        ? "That moment is still out there."
                        : "Room for your next memory."}
                    </h2>
                    <p>
                      {results
                        ? "Try another person, place, year, or feeling."
                        : "Add photos and videos to begin your story."}
                    </p>
                    <button
                      className="button secondary"
                      onClick={() => setModal("import")}
                    >
                      Add memories
                      <Plus size={16} />
                    </button>
                  </div>
                )}
              </section>
            )}
            <footer className="page-footer">
              <span className="brand-mark">✳</span> Your life isn’t a feed. It’s
              a story.<span>Made to be remembered.</span>
            </footer>
          </div>
        )}
      </main>
      {notice && (
        <div className="toast" role="status">
          <Check size={18} />
          {notice}
        </div>
      )}
      {selected && (
        <div className="modal-backdrop" onClick={closeMemory}>
          <section
            className="memory-detail"
            role="dialog"
            aria-modal="true"
            aria-label={friendlyMemoryTitle(selected)}
            onClick={(e) => e.stopPropagation()}
          >
            <button
              className="modal-close"
              onClick={closeMemory}
              aria-label="Close memory"
            >
              <X size={20} />
            </button>
            <div className="detail-media">
              {selected.mediaType === "video" ? (
                <video
                  src={selected.url}
                  poster={selected.thumbnailUrl}
                  controls
                  playsInline
                />
              ) : (
                <img src={selected.url} alt={selected.title} />
              )}
            </div>
            <div className="detail-body">
              <span className="eyebrow">
                {sourceNames[selected.source]} ·{" "}
                {displayDate(selected.date, {
                  month: "long",
                  day: "numeric",
                  year: "numeric",
                })}
              </span>
              <h2>{friendlyMemoryTitle(selected)}</h2>
              <span className="detail-location">
                <MapPin size={14} />
                {selected.location || "A place worth remembering"}
              </span>
              <p>{selected.description}</p>
              <div className="detail-tags">
                {selected.tags.map((tag) => (
                  <span key={tag}>{tag}</span>
                ))}
              </div>
              <div className="detail-actions">
                <button
                  className="button primary"
                  disabled={Boolean(busy)}
                  onClick={() => void enterMemory(selected)}
                >
                  {busy.startsWith("scene") ? (
                    <LoaderCircle className="spin" size={18} />
                  ) : (
                    <Cuboid size={18} />
                  )}
                  {busy.startsWith("scene")
                    ? "Casting your memory into 3D…"
                    : "Step inside this memory"}
                  <ArrowUpRight size={16} />
                </button>
                <button
                  className="button secondary"
                  onClick={() => draftChapter(selected)}
                >
                  <BookOpen size={17} />
                  Build a chapter
                </button>
              </div>
              {busy.startsWith("scene") && (
                <div className="reconstruction-progress" role="status">
                  <span className="reconstruction-pulse" />
                  <div>
                    <strong>
                      {selected.mediaType === "video"
                        ? "Finding depth and objects across your video."
                        : "Finding the space inside your photo."}
                    </strong>
                    <p>
                      {selected.mediaType === "video"
                        ? "We’re sampling the clip and rebuilding its depth and visible objects. The first visit can take a few minutes; playback then uses cached frames."
                        : "We’re finding subjects, filling hidden surfaces, and building a walkable world. The first memory can take a few minutes; later visits open faster."}
                    </p>
                  </div>
                </div>
              )}
              <button
                className="text-button edit-details"
                onClick={() => {
                  setMetadataDraft(selected);
                  setSelected(null);
                }}
              >
                Edit memory details <Settings2 size={14} />
              </button>
              <p className="fine-print">
                {selected.mediaType === "video"
                  ? "Step into moving video with sampled depth and reconstructed objects. Video objects stay fixed; unseen surfaces and motion between samples are approximate."
                  : "Walk around the people and objects in your photo. Pick up recognized everyday objects. Visible colors are preserved; sides, backs, and hidden surroundings are extrapolated."}
              </p>
            </div>
          </section>
        </div>
      )}
      {modal && (
        <div
          className="modal-backdrop"
          onClick={() => {
            if (!busy) setModal(null);
          }}
        >
          <section
            className="modal"
            role="dialog"
            aria-modal="true"
            aria-label={
              modal === "room"
                ? "Remember together"
                : modal === "album-share"
                  ? "Choose album memories to share"
                  : modal === "room-preview"
                    ? "Preview shared album room"
                    : modal === "sources"
                      ? "Connected sources"
                      : modal === "settings"
                        ? "Import settings"
                        : "Add memories"
            }
            onClick={(e) => e.stopPropagation()}
          >
            <button
              className="modal-close"
              onClick={() => setModal(null)}
              aria-label="Close dialog"
            >
              <X size={20} />
            </button>
            {modal === "import" ? (
              <>
                <span className="modal-symbol">
                  <ImagePlus size={27} />
                </span>
                <h2>Make room for your memories.</h2>
                <p>Bring in the moments you want to keep close.</p>
                <label
                  className={`upload-zone ${busy === "upload" ? "disabled" : ""}`}
                >
                  <ArrowDownToLine size={32} />
                  <strong>
                    {busy === "upload"
                      ? "Saving and understanding your memories…"
                      : "Choose photos or videos"}
                  </strong>
                  <span>
                    JPEG, PNG, WebP, MP4 or WebM · up to 50 MB each, 8 files at
                    a time
                  </span>
                  <input
                    type="file"
                    accept="image/jpeg,image/png,image/webp,video/mp4,video/webm"
                    multiple
                    disabled={Boolean(busy)}
                    onChange={(e) => void upload(e.target.files)}
                  />
                </label>
                <div className="or-divider">
                  or bring them from somewhere else
                </div>
                <button
                  className="source-option"
                  onClick={() => setModal("sources")}
                >
                  <span className="google-symbol">✳</span>
                  <div>
                    <strong>Connect your sources</strong>
                    <small>Google Photos, Instagram & LinkedIn</small>
                  </div>
                  <ChevronRight size={20} />
                </button>
                <p className="fine-print">
                  Photos are archived, deduplicated and grouped locally. Gemini
                  is reserved for representative album and world descriptions.
                </p>
              </>
            ) : modal === "settings" ? (
              <>
                <span className="modal-symbol">
                  <Settings2 size={26} />
                </span>
                <h2>Import settings.</h2>
                <p>Choose how large each Google Photos selection can be.</p>
                <div className="source-panel">
                  <label className="field-label">
                    Google Photos batch size
                    <select
                      value={googlePickerLimit}
                      onChange={(event) => {
                        const value = Number(event.target.value);
                        setGooglePickerLimit(value);
                        localStorage.setItem(
                          "again-google-picker-limit",
                          String(value),
                        );
                      }}
                    >
                      <option value={2000}>
                        Up to 2,000 · broad first import
                      </option>
                      <option value={500}>Up to 500 · large batch</option>
                      <option value={200}>Up to 200 · focused batch</option>
                      <option value={50}>Up to 50 · quick batch</option>
                    </select>
                  </label>
                  <p className="fine-print">
                    This controls the maximum allowed in a new Picker session.
                    Large imports continue in the background and can take longer
                    to archive and process.
                  </p>
                </div>
                <p className="privacy-callout">
                  <LockKeyhole size={15} /> Google requires you to approve the
                  items in its Picker. Again cannot automatically inspect or
                  retrieve your latest photos, and no setting can bypass that
                  approval.
                </p>
                <button
                  className="button primary wide"
                  onClick={() => {
                    setModal("sources");
                  }}
                >
                  Open connected sources
                </button>
              </>
            ) : modal === "sources" ? (
              <>
                <span className="modal-symbol">
                  <Link2 size={26} />
                </span>
                <h2>Your memories, connected.</h2>
                <p>Bring scattered moments into one personal collection.</p>
                <div className="source-panel">
                  <div className="source-title">
                    <span className="google-symbol">✳</span>
                    <div>
                      <h3>Google Photos</h3>
                      <small>
                        Select as many photos and videos as you want to
                        remember.
                      </small>
                    </div>
                  </div>
                  <p className="fine-print">
                    Choose up to {googlePickerLimit.toLocaleString()} moments in
                    this session. Google requires you to select them in its
                    Picker; Again cannot silently browse or auto-select your
                    recent library.
                  </p>
                  <div className="button-row">
                    {!googleReady && (
                      <button
                        className="button secondary small"
                        onClick={() => void connectGoogle()}
                        disabled={Boolean(busy) || !googleConfigured}
                      >
                        {googleConfigured
                          ? "Connect Google"
                          : "OAuth setup required"}
                      </button>
                    )}
                    <button
                      className="button primary small"
                      onClick={() => void pickGoogle()}
                      disabled={Boolean(busy) || !googleReady}
                    >
                      {googleReady ? "Choose photos" : "Connect first"}
                    </button>
                  </div>
                  {pickerId && (
                    <button
                      className="button primary wide"
                      onClick={() => void finishPicker()}
                      disabled={Boolean(busy)}
                    >
                      Import my selected photos
                    </button>
                  )}
                </div>
                <div className="source-panel">
                  <div className="source-title">
                    <span className="google-symbol">✳</span>
                    <div>
                      <h3>Shared Google Photos album</h3>
                      <small>
                        Bring in an album someone shared with a link, like an
                        event's community album.
                      </small>
                    </div>
                  </div>
                  <label className="field-label">
                    Album link
                    <input
                      value={albumUrl}
                      onChange={(e) => setAlbumUrl(e.target.value)}
                      placeholder="https://photos.app.goo.gl/…"
                    />
                  </label>
                  <label className="consent-check">
                    <input
                      type="checkbox"
                      checked={albumConsent}
                      onChange={(e) => setAlbumConsent(e.target.checked)}
                    />
                    <span>
                      I have permission to import this album, and I authorize
                      Again to retrieve and archive its photos.
                    </span>
                  </label>
                  <button
                    className="button primary wide"
                    onClick={() => void importSharedAlbum()}
                    disabled={Boolean(busy) || !albumConsent}
                  >
                    {busy === "album" ? (
                      <LoaderCircle size={17} className="spin" />
                    ) : (
                      <Plus size={17} />
                    )}
                    Import up to 12 photos
                  </button>
                  <p className="fine-print">
                    Our Apify Actor reads the album's public share page; only the
                    link is sent. Google's Picker can't open albums shared by
                    others, so this covers them.
                  </p>
                </div>
                <div className="source-panel">
                  <div className="source-title">
                    <span className="social-symbol">◎</span>
                    <div>
                      <h3>Social memories</h3>
                      <small>Import accessible posts using Apify.</small>
                    </div>
                  </div>
                  <label className="field-label">
                    Source
                    <select
                      value={socialSource}
                      onChange={(e) =>
                        setSocialSource(
                          e.target.value as
                            "instagram" | "linkedin" | "youtube",
                        )
                      }
                    >
                      <option value="instagram">Instagram</option>
                      <option value="linkedin">
                        LinkedIn (configured actor required)
                      </option>
                      <option value="youtube">
                        YouTube (configured actor required)
                      </option>
                    </select>
                  </label>
                  <label className="field-label">
                    Profile URL
                    <input
                      value={profile}
                      onChange={(e) => setProfile(e.target.value)}
                      placeholder={
                        socialSource === "instagram"
                          ? "https://www.instagram.com/yourname/"
                          : socialSource === "linkedin"
                            ? "https://www.linkedin.com/in/yourname/"
                            : "https://www.youtube.com/@yourchannel"
                      }
                    />
                  </label>
                  <label className="consent-check">
                    <input
                      type="checkbox"
                      checked={socialOwnership}
                      onChange={(e) => setSocialOwnership(e.target.checked)}
                    />
                    <span>
                      I confirm this is my account, or I have permission to
                      import it.
                    </span>
                  </label>
                  <label className="consent-check">
                    <input
                      type="checkbox"
                      checked={socialConsent}
                      onChange={(e) => setSocialConsent(e.target.checked)}
                    />
                    <span>
                      I authorize Again to retrieve and archive the selected
                      posts and media.
                    </span>
                  </label>
                  <button
                    className="button primary wide"
                    onClick={() => void importSocial()}
                    disabled={
                      Boolean(busy) || !socialOwnership || !socialConsent
                    }
                  >
                    {busy === "social" ? (
                      <LoaderCircle size={17} className="spin" />
                    ) : (
                      <Plus size={17} />
                    )}
                    Import up to 6 posts
                  </button>
                  <p className="fine-print">
                    Only the account or channel you name is sent to Apify. Again
                    does not ask for or store your social password. Private
                    profiles may not be accessible.
                  </p>
                </div>
              </>
            ) : modal === "room-preview" ? (
              <>
                <span className="modal-symbol">
                  <Cuboid size={26} />
                </span>
                <h2>{guestPreview?.title}</h2>
                <p>
                  Review the memories the host chose before you enter this
                  shared album world.
                </p>
                {guestPreview && (
                  <>
                    <div className="share-summary">
                      <strong>
                        {guestPreview.totalMedia} photos or videos
                      </strong>
                      <span>
                        {guestPreview.sources
                          .map((source) => sourceNames[source])
                          .join(" · ")}
                      </span>
                    </div>
                    <div className="share-memory-list preview-only">
                      {guestPreview.memories.map((memory) => (
                        <div key={memory.id}>
                          <img src={memory.thumbnailUrl} alt="" />
                          <span>
                            <strong>{memory.title}</strong>
                            <small>
                              {sourceNames[memory.source]} · {memory.mediaType}
                            </small>
                          </span>
                        </div>
                      ))}
                    </div>
                  </>
                )}
                <p className="privacy-callout">
                  <LockKeyhole size={15} /> Only this selection appears in the
                  room navigation. Photos may include people who have not
                  separately consented to sharing.
                </p>
                <button
                  className="button primary wide"
                  onClick={() => setModal(null)}
                >
                  Enter shared album world <ArrowRight size={17} />
                </button>
                <button
                  className="text-button danger"
                  disabled={Boolean(busy)}
                  onClick={() => void leaveRoom()}
                >
                  Leave without entering
                </button>
              </>
            ) : modal === "album-share" ? (
              <>
                <span className="modal-symbol">
                  <Users size={26} />
                </span>
                <h2>Choose what enters the room.</h2>
                <p>
                  {shareAlbum?.title} stays private. Only the memories checked
                  below will be included in this room.
                </p>
                {sharePreview && (
                  <div className="share-summary">
                    <strong>{sharePreview.totalMedia} photos or videos</strong>
                    <span>
                      {sharePreview.sources
                        .map((source) => sourceNames[source])
                        .join(" · ")}
                    </span>
                  </div>
                )}
                <div className="share-memory-list">
                  {shareAlbum?.memoryIds.map((id) => {
                    const memory = memories.find((item) => item.id === id);
                    if (!memory) return null;
                    const checked = shareIds.includes(id);
                    const isAnchor = id === shareAlbum.worldAnchorMemoryId;
                    return (
                      <label key={id}>
                        <input
                          type="checkbox"
                          checked={checked}
                          disabled={
                            isAnchor || (checked && shareIds.length === 1)
                          }
                          onChange={() => void changeShareSelection(id)}
                        />
                        <img src={memory.thumbnailUrl || memory.url} alt="" />
                        <span>
                          <strong>{memory.title}</strong>
                          <small>
                            {sourceNames[memory.source]} · {memory.mediaType}
                            {isAnchor ? " · required world anchor" : ""}
                          </small>
                        </span>
                      </label>
                    );
                  })}
                </div>
                <p className="privacy-callout">
                  <LockKeyhole size={15} /> Sharing a photo does not imply that
                  people pictured consented. Review this list before inviting
                  guests.
                </p>
                {!room && (
                  <label className="field-label">
                    What should guests call you?
                    <input
                      value={name}
                      maxLength={32}
                      onChange={(event) => setName(event.target.value)}
                    />
                  </label>
                )}
                <button
                  className="button primary wide"
                  disabled={!shareIds.length || !name.trim() || Boolean(busy)}
                  onClick={() => void shareAlbumWorld()}
                >
                  {busy === "album-share" ? (
                    <LoaderCircle className="spin" size={17} />
                  ) : (
                    <Users size={17} />
                  )}
                  {room
                    ? "Share selection in this room"
                    : "Create room with this selection"}
                </button>
                <p className="fine-print">
                  The reconstructed scene uses the album’s world anchor. Related
                  memories appear as a shared navigation strip; no additional
                  people or relationships are inferred.
                </p>
              </>
            ) : (
              <>
                <span className="modal-symbol">
                  <Users size={27} />
                </span>
                <h2>
                  {room
                    ? "You’re here, together."
                    : "Some memories are better shared."}
                </h2>
                <p>One room. The same moment. Laptop, phone, or Meta Quest.</p>
                {room ? (
                  <>
                    <div className="room-code">
                      <small>YOUR INVITATION CODE</small>
                      <strong>
                        {room.code.match(/.{1,4}/g)?.join(" ") || room.code}
                      </strong>
                      <button
                        className="button primary"
                        onClick={() => void copyInvite()}
                      >
                        <Copy size={16} />
                        Copy invitation
                      </button>
                    </div>
                    <div className="member-list">
                      {room.members.map((member) => (
                        <div key={member.id}>
                          <span style={{ background: member.color }}>
                            {member.name.slice(0, 1)}
                          </span>
                          <strong>{member.name}</strong>
                          <small>
                            {member.device}
                            {member.id === room.hostId ? " · host" : ""}
                          </small>
                        </div>
                      ))}
                    </div>
                    <p className="fine-print">
                      The host chooses the memory. Everyone sees the same scene
                      and each other’s position. Open the same app address on
                      every device.
                    </p>
                    <button
                      className="text-button danger"
                      disabled={Boolean(busy)}
                      onClick={() => void leaveRoom()}
                    >
                      Leave this room
                    </button>
                  </>
                ) : (
                  <>
                    <label className="field-label">
                      What should we call you?
                      <input
                        value={name}
                        maxLength={32}
                        onChange={(e) => setName(e.target.value)}
                      />
                    </label>
                    <button
                      className="button primary wide"
                      disabled={Boolean(busy) || !name.trim()}
                      onClick={() => void connectRoom(false)}
                    >
                      {busy === "room" ? (
                        <LoaderCircle className="spin" size={17} />
                      ) : (
                        <Plus size={17} />
                      )}
                      Start a shared room
                    </button>
                    <div className="or-divider">or join someone you know</div>
                    <label className="field-label">
                      Invitation code
                      <input
                        value={roomCode}
                        onChange={(e) =>
                          setRoomCode(e.target.value.toUpperCase())
                        }
                        placeholder="Enter your room code"
                        maxLength={20}
                      />
                    </label>
                    <button
                      className="button secondary wide"
                      disabled={
                        Boolean(busy) || !roomCode.trim() || !name.trim()
                      }
                      onClick={() => void connectRoom(true)}
                    >
                      Join their memory
                      <ArrowRight size={17} />
                    </button>
                  </>
                )}
                <p className="connection-note">
                  <span className="live-dot" />
                  Live rooms powered by SpacetimeDB
                </p>
              </>
            )}
          </section>
        </div>
      )}
      {chapterDraft && (
        <div className="modal-backdrop" onClick={() => setChapterDraft(null)}>
          <section
            className="modal chapter-editor"
            role="dialog"
            aria-modal="true"
            aria-label="Edit chapter"
            onClick={(e) => e.stopPropagation()}
          >
            <button
              className="modal-close"
              onClick={() => setChapterDraft(null)}
              aria-label="Close chapter"
            >
              <X size={20} />
            </button>
            <span className="eyebrow">A CHAPTER OF YOUR LIFE</span>
            <label className="field-label">
              Title
              <input
                value={chapterDraft.title}
                onChange={(e) =>
                  setChapterDraft({ ...chapterDraft, title: e.target.value })
                }
              />
            </label>
            <label className="field-label">
              Your story
              <textarea
                value={chapterDraft.body}
                rows={10}
                onChange={(e) =>
                  setChapterDraft({ ...chapterDraft, body: e.target.value })
                }
              />
            </label>
            <span className="field-label">Kept alongside the originals</span>
            <div className="chapter-sources">
              {chapterDraft.memoryIds.map((id) => {
                const m = memories.find((item) => item.id === id);
                return m ? (
                  <button
                    key={id}
                    onClick={() => {
                      setChapterDraft(null);
                      setSelected(m);
                    }}
                  >
                    <img src={m.thumbnailUrl || m.url} alt="" />
                    <span>{m.title}</span>
                    <ArrowUpRight size={14} />
                  </button>
                ) : null;
              })}
            </div>
            <p className="fine-print">
              This draft uses the source descriptions. Edit it to preserve your
              own recollection.
            </p>
            <button
              className="button primary wide"
              disabled={Boolean(busy) || !chapterDraft.title.trim()}
              onClick={() => void saveChapter()}
            >
              <Check size={18} />
              Save chapter
            </button>
          </section>
        </div>
      )}
    </div>
  );
}
