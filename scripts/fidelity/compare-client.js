const $ = (selector) => document.querySelector(selector);
const element = (tag, className, text) => {
  const node = document.createElement(tag);
  if (className) node.className = className;
  if (text !== undefined) node.textContent = text;
  return node;
};
const views = ["source-camera", "left-8cm", "right-8cm"];
let data;
let state;
let swipe = 50;
let statusTimer;

function normalize(query) {
  const photo =
    data.photos.find((item) => item.index === Number(query.get("photo"))) ??
    data.photos[0];
  const hasVariant = (id) => data.variants.some((variant) => variant.id === id);
  const crop = query.get("crop");
  return {
    photo: photo.index,
    left: hasVariant(query.get("left")) ? query.get("left") : "depth-256",
    right: hasVariant(query.get("right")) ? query.get("right") : "depth-384",
    view: views.includes(query.get("view"))
      ? query.get("view")
      : "source-camera",
    mode: query.get("mode") === "swipe" ? "swipe" : "side",
    crop: photo.crops.some((item) => item.id === crop) ? crop : "full",
  };
}

function change(patch) {
  const params = new URLSearchParams({ ...state, ...patch });
  state = normalize(params);
  const url = new URL(location.href);
  for (const [key, value] of Object.entries(state))
    url.searchParams.set(key, value);
  history.replaceState(null, "", url);
  render();
}

function message(text) {
  $("#status").textContent = text;
  $("#status").classList.add("visible");
  clearTimeout(statusTimer);
  statusTimer = setTimeout(
    () => $("#status").classList.remove("visible"),
    2400,
  );
}

const selectedPhoto = () =>
  data.photos.find((photo) => photo.index === state.photo);
const variant = (id) => data.variants.find((item) => item.id === id);
const measured = (photo) =>
  Boolean(
    photo.runs["depth-256"]?.views["source-camera"] &&
    photo.runs["depth-384"]?.views["source-camera"] &&
    photo.runs["depth-256"]?.global &&
    photo.runs["depth-384"]?.global,
  );

function cropFor(photo) {
  const selection = photo.crops.find((crop) => crop.id === state.crop);
  const width = photo.provenance?.dimensions.width ?? 960;
  const height = photo.provenance?.dimensions.height ?? 720;
  if (!selection)
    return {
      box: [0, 0, 1, 1],
      aspect: width / height,
      description:
        "Full source framing. Both implementations use the same saved camera preset.",
    };
  const [l, t, r, b] = selection.box;
  const box = [
    Math.floor(l * width) / width,
    Math.floor(t * height) / height,
    Math.ceil(r * width) / width,
    Math.ceil(b * height) / height,
  ];
  return {
    box,
    aspect: ((width / height) * (box[2] - box[0])) / (box[3] - box[1]),
    description:
      selection.description +
      " Fixed rectangle in source-image coordinates; neighboring pixels are included.",
  };
}

function imageFrame(photo, id, crop) {
  const frame = element("div", "image-frame");
  frame.style.aspectRatio = String(crop.aspect);
  frame.style.width = `min(100%, ${62 * crop.aspect}vh)`;
  const url = photo.runs[id]?.views[state.view];
  const unavailable = () => {
    frame.replaceChildren();
    const missing = element("div", "missing");
    missing.append(
      element("strong", "", "Capture unavailable"),
      element(
        "span",
        "",
        `No saved ${variant(id).label} render for photo ${photo.index}, ${state.view}.`,
      ),
    );
    frame.append(missing);
    frame.dataset.available = "false";
  };
  if (!url) {
    unavailable();
    return frame;
  }
  const img = element("img");
  img.alt = `${variant(id).label}; photo ${photo.index}; ${state.view}; ${state.crop}`;
  const [l, t, r, b] = crop.box;
  img.style.width = `${100 / (r - l)}%`;
  img.style.height = `${100 / (b - t)}%`;
  img.style.left = `${(-100 * l) / (r - l)}%`;
  img.style.top = `${(-100 * t) / (b - t)}%`;
  img.addEventListener("error", unavailable, { once: true });
  img.src = url;
  frame.append(img);
  frame.dataset.available = "true";
  return frame;
}

function setDivider() {
  const layer = $(".swipe-top");
  if (layer) layer.style.clipPath = `inset(0 ${100 - swipe}% 0 0)`;
  const divider = $(".swipe-divider");
  if (divider) divider.style.left = `${swipe}%`;
  $("#swipe-percent").textContent = `${swipe}%`;
  $("#swipe-range").value = swipe;
}

function renderStage(photo, crop) {
  const stage = $("#comparison-stage");
  stage.replaceChildren();
  const bothAvailable =
    photo.runs[state.left]?.views[state.view] &&
    photo.runs[state.right]?.views[state.view];
  const useSwipe = state.mode === "swipe" && bothAvailable;
  $("#swipe-control").hidden = !useSwipe;
  if (useSwipe) {
    const wrapper = element("div", "swipe-stage");
    wrapper.style.aspectRatio = String(crop.aspect);
    wrapper.style.width = `min(100%, ${62 * crop.aspect}vh)`;
    for (const [id, className] of [
      [state.right, "swipe-layer"],
      [state.left, "swipe-layer swipe-top"],
    ]) {
      const layer = element("div", className);
      const image = imageFrame(photo, id, crop);
      image.style.width = "100%";
      layer.append(image);
      wrapper.append(layer);
    }
    wrapper.append(
      element("div", "swipe-divider"),
      element("span", "swipe-label left", variant(state.left).label),
      element("span", "swipe-label right", variant(state.right).label),
    );
    stage.append(wrapper);
    setDivider();
  } else {
    const grid = element("div", "comparison-grid");
    for (const id of [state.left, state.right]) {
      const panel = element("div", "render-panel");
      const title = element("div", "panel-title", variant(id).label);
      title.append(
        element(
          "span",
          "",
          state.view === "source-camera"
            ? "Source camera"
            : state.view === "left-8cm"
              ? "Left 8 cm virtual"
              : "Right 8 cm virtual",
        ),
      );
      panel.append(title, imageFrame(photo, id, crop));
      grid.append(panel);
    }
    stage.append(grid);
    if (state.mode === "swipe" && !bothAvailable)
      stage.append(
        element(
          "p",
          "muted small",
          "Swipe needs both saved renders. Unavailable captures are shown explicitly.",
        ),
      );
  }
}

function score(photo, id) {
  const run = photo.runs[id];
  if (!run?.views["source-camera"]) return null;
  return state.crop === "full" ? run.global : run.regions[state.crop];
}

function value(metric, name) {
  if (!metric) return "Not measured";
  const number = metric[name];
  if (name === "psnrDb" && number === null && metric.exactMatch)
    return "∞ (exact pixels)";
  if (typeof number !== "number" || !Number.isFinite(number))
    return "Not measured";
  if (name === "changedPixelFraction") return `${(number * 100).toFixed(2)}%`;
  return name === "psnrDb" ? `${number.toFixed(2)} dB` : number.toFixed(5);
}

function renderScores(photo) {
  const content = $("#scores-content");
  content.replaceChildren();
  $("#score-scope").textContent =
    state.crop === "full"
      ? "All source pixels"
      : `Reviewed ROI · ${state.crop}`;
  if (state.view !== "source-camera") {
    const notice = element("div", "score-empty");
    notice.append(
      element("b", "", "No quantitative novel-view result. "),
      document.createTextNode(
        "These saved side views have no ground-truth photograph. Return to Source camera to inspect the measured pixel scores.",
      ),
    );
    content.append(notice);
    return;
  }
  const left = score(photo, state.left),
    right = score(photo, state.right);
  if (!left && !right) {
    content.append(
      element(
        "div",
        "score-empty",
        "No saved source-view metrics for this photo and selection. This is unavailable evidence, not a zero-error result.",
      ),
    );
    return;
  }
  const table = element("table");
  const head = element("tr");
  for (const label of [
    "Metric",
    variant(state.left).label,
    variant(state.right).label,
    "Right − left",
  ])
    head.append(element("th", "", label));
  const thead = element("thead");
  thead.append(head);
  table.append(thead);
  const tbody = element("tbody");
  for (const [key, label] of [
    ["mae", "MAE"],
    ["rmse", "RMSE"],
    ["psnrDb", "PSNR"],
    ["changedPixelFraction", "Changed pixels >10/255"],
  ]) {
    const row = element("tr");
    let delta = "—";
    if (typeof left?.[key] === "number" && typeof right?.[key] === "number") {
      const difference = right[key] - left[key];
      const digits = key === "mae" || key === "rmse" ? 5 : 2;
      delta = `${difference > 0 ? "+" : ""}${(key === "changedPixelFraction" ? difference * 100 : difference).toFixed(digits)}${key === "changedPixelFraction" ? " pp" : key === "psnrDb" ? " dB" : ""}`;
    }
    for (const text of [label, value(left, key), value(right, key), delta])
      row.append(element("td", "", text));
    tbody.append(row);
  }
  table.append(tbody);
  content.append(table);
  if (!left || !right)
    content.append(
      element(
        "p",
        "muted small",
        "One selected implementation has no saved score for this region. It is not replaced with a whole-image score.",
      ),
    );
}

function renderProvenance(photo) {
  const target = $("#provenance-content");
  target.replaceChildren();
  const dl = element("dl");
  const pair = (label, value) => {
    dl.append(element("dt", "", label), element("dd", "", value));
  };
  pair("Left implementation", variant(state.left).description);
  pair("Right implementation", variant(state.right).description);
  pair(
    "Evidence scope",
    "Saved depth surfaces only. Full scene reconstruction, model generalization and headset/runtime performance are unmeasured here.",
  );
  pair(
    "Metric scope",
    "Original photo resized once to capture size; opaque sRGB RGB errors. Fixed reviewed rectangles include neighboring pixels, not semantic masks.",
  );
  if (photo.provenance) {
    const p = photo.provenance;
    pair(
      "Built-in captures",
      `${p.dimensions.width} × ${p.dimensions.height} pixels · ${p.generatedAt}`,
    );
    pair(
      "Camera preset",
      `${state.view} · fixed orientation; virtual offsets ${JSON.stringify(p.views.find((v) => v.name === state.view)?.offset ?? null)} metres in inferred scene scale, not measured physical camera displacement`,
    );
    pair("Built-in renderer hash", p.browserBundleSha256);
    pair("Original SHA-256", p.inputHashes.referenceOriginal);
    for (const id of [state.left, state.right]) {
      const geometry = photo.runs[id]?.geometry;
      if (geometry)
        pair(
          variant(id).label,
          `${geometry.triangles.toLocaleString()} triangles${geometry.meshDepthDimensions ? ` · ${geometry.meshDepthDimensions.width} × ${geometry.meshDepthDimensions.height} mesh depth grid` : ""}`,
        );
    }
    target.append(dl);
    const links = element("div", "report-links");
    for (const [name, url] of Object.entries(p.reports))
      if (url) {
        const link = element("a", "", `${name} report JSON`);
        link.href = url;
        link.target = "_blank";
        link.rel = "noopener";
        links.append(link);
      }
    if (data.resultsReport) {
      const link = element("a", "", "Measured results and limitations");
      link.href = data.resultsReport;
      link.target = "_blank";
      link.rel = "noopener";
      links.append(link);
    }
    target.append(links);
  } else {
    pair(
      "Capture provenance",
      "Unavailable for this photo. Original thumbnail is provided for inventory only.",
    );
    target.append(dl);
  }
}

function render() {
  const photo = selectedPhoto();
  $("#photo-title").textContent = photo.title;
  $("#photo-description").textContent = photo.description;
  $("#original-thumb").src = photo.thumbnail ?? photo.original ?? "";
  $("#original-thumb").hidden = !photo.thumbnail && !photo.original;
  $("#original-link").href = photo.original ?? photo.thumbnail ?? "#";
  $("#availability").textContent = measured(photo)
    ? "Measured depth comparison available · source and ±8 cm virtual offsets"
    : "Depth comparison not measured for this photo · original available for review";
  $("#left-select").value = state.left;
  $("#right-select").value = state.right;
  const cropSelect = $("#crop-select");
  cropSelect.replaceChildren(new Option("Full image", "full"));
  for (const crop of photo.crops)
    cropSelect.add(new Option(crop.id.replaceAll("-", " "), crop.id));
  cropSelect.value = state.crop;
  document.querySelectorAll("[data-view]").forEach((button) => {
    button.classList.toggle("active", button.dataset.view === state.view);
    button.setAttribute(
      "aria-pressed",
      String(button.dataset.view === state.view),
    );
  });
  document.querySelectorAll("[data-mode]").forEach((button) => {
    button.classList.toggle("active", button.dataset.mode === state.mode);
    button.setAttribute(
      "aria-pressed",
      String(button.dataset.mode === state.mode),
    );
  });
  document
    .querySelectorAll(".photo-card")
    .forEach((button) =>
      button.setAttribute(
        "aria-current",
        String(Number(button.dataset.photo) === state.photo),
      ),
    );
  $("#view-explanation").textContent =
    state.view === "source-camera"
      ? "Registered source view · quantitative scores available where measured"
      : "Virtual translation at inferred scale · visual inspection only; no held-out ground truth";
  const crop = cropFor(photo);
  $("#crop-description").textContent =
    crop.description +
    (state.view !== "source-camera" && state.crop !== "full"
      ? " Side views use the same pixel rectangle, not object tracking."
      : "");
  renderStage(photo, crop);
  renderScores(photo);
  renderProvenance(photo);
  document.title = `${photo.title} · Saved fidelity comparison`;
}

async function start() {
  const response = await fetch("/api/data");
  if (!response.ok)
    throw new Error("Saved comparison inventory could not be loaded");
  data = await response.json();
  $("#measured-count").textContent =
    `${data.measuredCount} / ${data.total} photos measured`;
  $("#library-count").textContent = data.total;
  const list = $("#photo-list");
  for (const photo of data.photos) {
    const button = element("button", "photo-card");
    button.dataset.photo = photo.index;
    button.setAttribute(
      "aria-label",
      `${photo.title}; ${measured(photo) ? "measured depth comparison" : "depth comparison unavailable"}`,
    );
    if (photo.thumbnail) {
      const img = element("img");
      img.src = photo.thumbnail;
      img.alt = "";
      img.loading = "lazy";
      button.append(img);
    }
    const labels = element("span");
    labels.append(
      element("span", "name", photo.title),
      element(
        "span",
        `availability-label ${measured(photo) ? "measured" : ""}`,
        measured(photo) ? "● Measured" : "No depth comparison",
      ),
    );
    button.append(labels);
    button.addEventListener("click", () => change({ photo: photo.index }));
    list.append(button);
  }
  for (const selector of ["#left-select", "#right-select"])
    for (const variant of data.variants)
      $(selector).add(new Option(variant.label, variant.id));
  $("#left-select").addEventListener("change", (event) =>
    change({ left: event.target.value }),
  );
  $("#right-select").addEventListener("change", (event) =>
    change({ right: event.target.value }),
  );
  $("#crop-select").addEventListener("change", (event) =>
    change({ crop: event.target.value }),
  );
  document
    .querySelectorAll("[data-view]")
    .forEach((button) =>
      button.addEventListener("click", () =>
        change({ view: button.dataset.view }),
      ),
    );
  document
    .querySelectorAll("[data-mode]")
    .forEach((button) =>
      button.addEventListener("click", () =>
        change({ mode: button.dataset.mode }),
      ),
    );
  $("#source-reset").addEventListener("click", () =>
    change({ view: "source-camera", crop: "full" }),
  );
  $("#swipe-range").addEventListener("input", (event) => {
    swipe = Number(event.target.value);
    setDivider();
  });
  $("#copy-link").addEventListener("click", async () => {
    try {
      await navigator.clipboard.writeText(location.href);
      message("Comparison link copied");
    } catch {
      message("Copy the current address to restore this comparison");
    }
  });
  window.addEventListener("popstate", () => {
    state = normalize(new URLSearchParams(location.search));
    render();
  });
  state = normalize(new URLSearchParams(location.search));
  change({});
  window.savedComparisonReady = true;
}

start().catch((error) => {
  $("#photo-title").textContent = "Saved comparison unavailable";
  $("#photo-description").textContent = error.message;
  $("#measured-count").textContent = "Inventory could not be loaded";
  console.error(error);
});
