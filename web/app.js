/* ============================================================
   NetRoute Simulator — Application Logic v3
   Features: Zoom/Pan, Node Drag, Run-Again, Real-time Timer
   ============================================================ */

(function () {
  "use strict";

  /* ----------------------------------------------------------
     State
     ---------------------------------------------------------- */
  let nodes = [];
  let edges = [];
  let nextNodeId = 0;

  // Algorithm results (full, from WASM)
  let kruskalResult = null;
  let primResult = null;
  let dijkstraPath = null;

  // Animation — progressive reveal
  let animTimers = []; // active requestAnimationFrame / interval IDs
  let isAnimating = false;
  let activeAnimCount = 0; // number of concurrent animations running
  let mainAnimEdges = []; // edges revealed so far on main canvas
  let compareAnimEdges = []; // edges revealed so far on compare canvas

  // Edge-fill animation progress (0→1 per edge being drawn)
  let mainFillProgress = 0;
  let compareFillProgress = 0;
  let mainEdgeQueue = [];
  let compareEdgeQueue = [];

  // Packet simulation
  let packetSrcId = null;
  let packetDestId = null;
  let packetAnimFrame = null;
  let packetPos = null; // { x, y } in normalized coords
  let packetPathEdges = []; // edges for the shortest path
  let packetProgress = 0; // overall progress along path

  // Interaction modes
  let addRouterMode = false;
  let connectMode = false;
  let connectFirst = null;

  // View mode
  let compareMode = false;

  let wasmReady = false;
  let sliderDebounce = null;

  // Track the last algorithm run for "Run Again"
  let lastAlgoRun = null; // "kruskal" | "prim" | "dijkstra" | "compare" | null
  let lastDijkstraSrc = null;
  let lastDijkstraDest = null;

  // Real-time timer state
  let timerState = {
    main: {
      running: false,
      startTime: 0,
      targetDuration: 0,
      elapsed: 0,
      label: "",
      actualNs: 0,
    },
    compare: {
      running: false,
      startTime: 0,
      targetDuration: 0,
      elapsed: 0,
      label: "",
      actualNs: 0,
    },
  };
  let timerAnimFrame = null;

  /* ----------------------------------------------------------
     Zoom / Pan / Drag State
     ---------------------------------------------------------- */
  const viewState = {
    main: { offsetX: 0, offsetY: 0, zoom: 1 },
    compare: { offsetX: 0, offsetY: 0, zoom: 1 },
  };

  let isPanning = false;
  let panStart = { x: 0, y: 0 };
  let panTarget = null; // "main" | "compare"

  let isDraggingNode = false;
  let dragNode = null;
  let dragCanvas = null;

  /* ----------------------------------------------------------
     DOM References
     ---------------------------------------------------------- */
  const mainCanvas = document.getElementById("canvas-main");
  const compareCanvas = document.getElementById("canvas-compare");
  const panelMain = document.getElementById("panel-main");
  const panelCompare = document.getElementById("panel-compare");
  const panelMainTitle = document.getElementById("panel-main-title");
  const panelMainBadge = document.getElementById("panel-main-badge");
  const terminalEl = document.getElementById("terminal-output");

  // Sliders
  const sliderNodes = document.getElementById("slider-nodes");
  const sliderDensity = document.getElementById("slider-density");
  const sliderWeight = document.getElementById("slider-weight");
  const sliderSpeed = document.getElementById("slider-speed");
  const valNodes = document.getElementById("val-nodes");
  const valDensity = document.getElementById("val-density");
  const valWeight = document.getElementById("val-weight");
  const valSpeed = document.getElementById("val-speed");

  // Buttons
  const btnAddRouter = document.getElementById("btn-add-router");
  const btnConnect = document.getElementById("btn-connect");
  const btnClear = document.getElementById("btn-clear");
  const btnGenerate = document.getElementById("btn-generate");
  const btnKruskal = document.getElementById("btn-kruskal");
  const btnPrim = document.getElementById("btn-prim");
  const btnDijkstra = document.getElementById("btn-dijkstra");
  const btnCompare = document.getElementById("btn-compare");
  const btnSendPacket = document.getElementById("btn-send-packet");
  const btnClearSel = document.getElementById("btn-clear-selection");

  // Stats
  const statNodes = document.getElementById("stat-nodes");
  const statLinks = document.getElementById("stat-links");
  const statCost = document.getElementById("stat-cost");

  // Packet display
  const pktSrcEl = document.getElementById("pkt-src");
  const pktDestEl = document.getElementById("pkt-dest");
  const pktHintEl = document.getElementById("pkt-hint");

  // Dijkstra modal
  const modalOverlay = document.getElementById("dijkstra-modal");
  const modalSrc = document.getElementById("modal-src");
  const modalDest = document.getElementById("modal-dest");
  const modalRun = document.getElementById("modal-run");
  const modalCancel = document.getElementById("modal-cancel");

  /* ----------------------------------------------------------
     Helpers
     ---------------------------------------------------------- */
  function getAnimSpeed() {
    // slider 1..10  →  interval in ms between edges
    // 1 = slowest (600ms), 10 = fastest (40ms)
    const v = parseInt(sliderSpeed.value, 10);
    return Math.round(640 - v * 60);
  }

  function getEdgeFillDuration() {
    // How long (ms) the color "travels" along a single edge
    const v = parseInt(sliderSpeed.value, 10);
    return Math.round(500 - v * 40); // 460ms at 1×  → 100ms at 10×
  }

  /* ----------------------------------------------------------
     Logger
     ---------------------------------------------------------- */
  function log(msg, type = "info") {
    const line = document.createElement("div");
    line.className = `log-line log-line--${type}`;
    const ts = document.createElement("span");
    ts.className = "log-timestamp";
    const now = new Date();
    ts.textContent = `[${String(now.getHours()).padStart(2, "0")}:${String(now.getMinutes()).padStart(2, "0")}:${String(now.getSeconds()).padStart(2, "0")}]`;
    line.appendChild(ts);
    line.appendChild(document.createTextNode(msg));
    terminalEl.appendChild(line);
    terminalEl.scrollTop = terminalEl.scrollHeight;
  }

  /* ----------------------------------------------------------
     Coordinate Transforms (zoom / pan support)
     ---------------------------------------------------------- */
  function getView(canvasId) {
    return canvasId === "compare" ? viewState.compare : viewState.main;
  }

  // Convert normalized node coords (0..1) to screen pixel coords on a canvas
  function nodeToScreen(node, canvas, view) {
    const w = canvas.width,
      h = canvas.height;
    const sx = node.x * w * view.zoom + view.offsetX;
    const sy = node.y * h * view.zoom + view.offsetY;
    return { x: sx, y: sy };
  }

  // Convert screen pixel coords back to normalized coords
  function screenToNormalized(sx, sy, canvas, view) {
    const w = canvas.width,
      h = canvas.height;
    const nx = (sx - view.offsetX) / (w * view.zoom);
    const ny = (sy - view.offsetY) / (h * view.zoom);
    return { x: nx, y: ny };
  }

  /* ----------------------------------------------------------
     Canvas Rendering
     ---------------------------------------------------------- */
  function resizeCanvas(canvas) {
    const p = canvas.parentElement;
    if (canvas.width !== p.clientWidth || canvas.height !== p.clientHeight) {
      canvas.width = p.clientWidth;
      canvas.height = p.clientHeight;
    }
  }

  /**
   * Draw the full graph with zoom/pan support.
   */
  function drawGraph(canvas, highlighted, filling, color, packet, canvasId) {
    resizeCanvas(canvas);
    const ctx = canvas.getContext("2d");
    const w = canvas.width;
    const h = canvas.height;
    const view = getView(canvasId);
    const isLight = document.body.classList.contains("light-theme");
    ctx.clearRect(0, 0, w, h);

    if (nodes.length === 0) {
      ctx.fillStyle = isLight ? "#6B7280" : "#8E95A3";
      ctx.font = "14px 'Space Mono', monospace";
      ctx.textAlign = "center";
      ctx.fillText("AWAITING PARAMS TO GENERATE GRAPH", w / 2, h / 2);
      return;
    }

    const baseNr = Math.max(12, Math.min(24, 300 / nodes.length));
    const nr = baseNr * Math.min(view.zoom, 2); // scale node radius with zoom, cap at 2x

    // Build highlight set
    const hlSet = new Set();
    if (highlighted) {
      highlighted.forEach((e) => {
        hlSet.add(`${e.src}-${e.dest}`);
        hlSet.add(`${e.dest}-${e.src}`);
      });
    }

    // --- Draw all edges ---
    edges.forEach((edge) => {
      const a = nodes.find((n) => n.id === edge.src);
      const b = nodes.find((n) => n.id === edge.dest);
      if (!a || !b) return;
      const ap = nodeToScreen(a, canvas, view);
      const bp = nodeToScreen(b, canvas, view);
      const isHl = hlSet.has(`${edge.src}-${edge.dest}`);
      ctx.beginPath();
      ctx.moveTo(ap.x, ap.y);
      ctx.lineTo(bp.x, bp.y);
      ctx.strokeStyle = isHl ? color : isLight ? "#D1D5DB" : "#3A3F47";
      ctx.lineWidth = isHl ? 3.5 : 1.2;
      ctx.stroke();
      // Weight
      const mx = (ap.x + bp.x) / 2,
        my = (ap.y + bp.y) / 2;
      ctx.fillStyle = isHl ? color : isLight ? "#6B7280" : "#8E95A3";
      ctx.font = `bold ${isHl ? 12 : 10}px 'Space Mono', monospace`;
      ctx.textAlign = "center";
      ctx.textBaseline = "bottom";
      ctx.fillText(String(edge.weight), mx, my - 3);
    });

    // --- Draw the edge currently being filled ---
    if (filling && filling.edge) {
      const fe = filling.edge;
      const a = nodes.find((n) => n.id === fe.src);
      const b = nodes.find((n) => n.id === fe.dest);
      if (a && b) {
        const ap = nodeToScreen(a, canvas, view);
        const bp = nodeToScreen(b, canvas, view);
        const p = filling.progress; // 0..1
        const cx = ap.x + (bp.x - ap.x) * p;
        const cy = ap.y + (bp.y - ap.y) * p;
        ctx.beginPath();
        ctx.moveTo(ap.x, ap.y);
        ctx.lineTo(cx, cy);
        ctx.strokeStyle = color;
        ctx.lineWidth = 3.5;
        ctx.stroke();
        // Glowing tip
        ctx.beginPath();
        ctx.arc(cx, cy, 4, 0, Math.PI * 2);
        ctx.fillStyle = color;
        ctx.fill();
      }
    }

    // --- Draw nodes ---
    nodes.forEach((node) => {
      const np = nodeToScreen(node, canvas, view);
      let isOnPath = false;
      if (highlighted) {
        highlighted.forEach((e) => {
          if (e.src === node.id || e.dest === node.id) isOnPath = true;
        });
      }
      // Selected node indicators for packet sim
      const isSrc = packetSrcId === node.id;
      const isDest = packetDestId === node.id;
      const isConnect = connectMode && connectFirst === node.id;

      if (isOnPath || isSrc || isDest || isConnect) {
        ctx.beginPath();
        ctx.arc(np.x, np.y, nr + 5, 0, Math.PI * 2);
        ctx.fillStyle = isSrc
          ? isLight
            ? "#16A34A33"
            : "#39FF1433"
          : isDest
            ? isLight
              ? "#DC262633"
              : "#FF003C33"
            : isConnect
              ? isLight
                ? "#0284C733"
                : "#00E5FF33"
              : color + "22";
        ctx.fill();
      }
      ctx.beginPath();
      ctx.arc(np.x, np.y, nr, 0, Math.PI * 2);
      ctx.fillStyle = isLight ? "#FFFFFF" : "#121418";
      ctx.fill();
      ctx.strokeStyle = isSrc
        ? isLight
          ? "#16A34A"
          : "#39FF14"
        : isDest
          ? isLight
            ? "#DC2626"
            : "#FF003C"
          : isConnect
            ? isLight
              ? "#0284C7"
              : "#00E5FF"
            : isOnPath
              ? color
              : isLight
                ? "#9CA3AF"
                : "#262930";
      ctx.lineWidth = isSrc || isDest || isOnPath || isConnect ? 3 : 2;
      ctx.stroke();
      ctx.fillStyle = isLight ? "#111827" : "#E0E4EA";
      ctx.font = `bold ${nr * 0.65}px 'Space Grotesk', sans-serif`;
      ctx.textAlign = "center";
      ctx.textBaseline = "middle";
      ctx.fillText(String(node.id), np.x, np.y);
    });

    // --- Draw packet dot ---
    if (packet) {
      const pp = {
        x: packet.x * w * view.zoom + view.offsetX,
        y: packet.y * h * view.zoom + view.offsetY,
      };
      // Outer glow
      ctx.beginPath();
      ctx.arc(pp.x, pp.y, 10, 0, Math.PI * 2);
      ctx.fillStyle = "rgba(255, 165, 0, 0.25)";
      ctx.fill();
      // Inner dot
      ctx.beginPath();
      ctx.arc(pp.x, pp.y, 6, 0, Math.PI * 2);
      ctx.fillStyle = "#ff8c00";
      ctx.fill();
      ctx.strokeStyle = "#fff";
      ctx.lineWidth = 2;
      ctx.stroke();
    }

    // --- Draw timer overlay ---
    const ts = canvasId === "compare" ? timerState.compare : timerState.main;
    if (ts.label) {
      drawTimerOverlay(ctx, w, h, ts);
    }

    // --- Draw Connect Mode Banner ---
    if (connectMode && canvasId === "main") {
      const bw = 320,
        bh = 30;
      const bx = (w - bw) / 2,
        by = 16;
      ctx.fillStyle = isLight ? "rgba(255,255,255,0.9)" : "rgba(10,11,14,0.9)";
      ctx.beginPath();
      ctx.roundRect(bx, by, bw, bh, 4);
      ctx.fill();
      ctx.strokeStyle = isLight ? "#0284C7" : "#00E5FF";
      ctx.lineWidth = 1;
      ctx.stroke();

      ctx.fillStyle = isLight ? "#0284C7" : "#00E5FF";
      ctx.font = "bold 11px 'Space Mono', monospace";
      ctx.textAlign = "center";
      ctx.textBaseline = "middle";
      const txt =
        connectFirst === null
          ? "CONNECT_MODE // SELECT FIRST NODE"
          : `CONNECT_MODE // LINKING NODE ${connectFirst} -> ?`;
      ctx.fillText(txt, bx + bw / 2, by + bh / 2);
    }
  }

  /* ----------------------------------------------------------
     Timer Overlay Drawing
     ---------------------------------------------------------- */
  function drawTimerOverlay(ctx, w, h, ts) {
    const isLight = document.body.classList.contains("light-theme");
    const padding = 12;
    const boxW = 220;
    const boxH = 52;
    const x = w - boxW - padding;
    const y = padding;

    // Semi-transparent background
    ctx.fillStyle = isLight
      ? "rgba(255, 255, 255, 0.9)"
      : "rgba(0, 0, 0, 0.75)";
    ctx.beginPath();
    ctx.roundRect(x, y, boxW, boxH, 8);
    ctx.fill();

    // Label
    ctx.fillStyle = isLight ? "#111827" : "#E0E4EA";
    ctx.font = "bold 11px 'Space Mono', monospace";
    ctx.textAlign = "left";
    ctx.textBaseline = "top";
    ctx.fillText(ts.label, x + 10, y + 8);

    // Progress bar background
    const barX = x + 10;
    const barY = y + 26;
    const barW = boxW - 20;
    const barH = 6;
    ctx.fillStyle = isLight ? "rgba(0,0,0,0.1)" : "rgba(255,255,255,0.2)";
    ctx.beginPath();
    ctx.roundRect(barX, barY, barW, barH, 3);
    ctx.fill();

    // Progress bar fill
    let progress = 0;
    if (ts.running && ts.targetDuration > 0) {
      progress = Math.min(
        1,
        (performance.now() - ts.startTime) / ts.targetDuration,
      );
    } else if (!ts.running && ts.targetDuration > 0) {
      progress = 1;
    }
    const barColor = ts.running
      ? isLight
        ? "#0284C7"
        : "#00E5FF"
      : isLight
        ? "#16A34A"
        : "#39FF14";
    ctx.fillStyle = barColor;
    ctx.beginPath();
    ctx.roundRect(barX, barY, barW * progress, barH, 3);
    ctx.fill();

    // Time display
    let displayTime;
    if (ts.running) {
      const elapsed = performance.now() - ts.startTime;
      const scaledNs = (elapsed / ts.targetDuration) * ts.actualNs;
      displayTime = formatNanoTime(scaledNs);
    } else {
      displayTime = formatNanoTime(ts.actualNs);
    }
    ctx.fillStyle = ts.running
      ? isLight
        ? "#0284C7"
        : "#00E5FF"
      : isLight
        ? "#16A34A"
        : "#39FF14";
    ctx.font = "bold 13px 'Space Mono', monospace";
    ctx.textAlign = "left";
    ctx.textBaseline = "top";
    ctx.fillText(displayTime, barX, barY + 10);

    // Status
    const statusText = ts.running ? "RUNNING..." : "✓ DONE";
    ctx.fillStyle = ts.running
      ? isLight
        ? "#EA580C"
        : "#FF3E00"
      : isLight
        ? "#16A34A"
        : "#39FF14";
    ctx.font = "bold 10px 'Space Grotesk', sans-serif";
    ctx.textAlign = "right";
    ctx.fillText(statusText, x + boxW - 10, barY + 11);
  }

  function formatNanoTime(ns) {
    if (ns < 1000) return ns.toFixed(2) + " ns";
    if (ns < 1e6) return (ns / 1000).toFixed(2) + " µs";
    if (ns < 1e9) return (ns / 1e6).toFixed(2) + " ms";
    return (ns / 1e9).toFixed(2) + " s";
  }

  function startTimer(target, label, actualNs) {
    const SCALE_FACTOR = 1e4;
    // Exactly scale the time by 1e4 without clamping it, representing 100% "real time scaled" data.
    const displayDuration = (actualNs * SCALE_FACTOR) / 1e6; // convert scaled ns to ms

    const ts = target === "compare" ? timerState.compare : timerState.main;
    ts.running = true;
    ts.startTime = performance.now();
    ts.targetDuration = displayDuration;
    ts.actualNs = actualNs;
    ts.label = label;
    ts.elapsed = 0;

    // Schedule timer end
    const timerId = setTimeout(() => {
      ts.running = false;
      ts.elapsed = ts.actualNs;
      redrawAll();
    }, displayDuration);
    animTimers.push(timerId);

    // Start continuous redraw for smooth timer
    if (!timerAnimFrame) {
      function tickTimer() {
        if (timerState.main.running || timerState.compare.running) {
          redrawAll();
          timerAnimFrame = requestAnimationFrame(tickTimer);
        } else {
          timerAnimFrame = null;
          redrawAll(); // final draw
        }
      }
      timerAnimFrame = requestAnimationFrame(tickTimer);
    }
  }

  function clearTimers() {
    timerState.main = {
      running: false,
      startTime: 0,
      targetDuration: 0,
      elapsed: 0,
      label: "",
      actualNs: 0,
    };
    timerState.compare = {
      running: false,
      startTime: 0,
      targetDuration: 0,
      elapsed: 0,
      label: "",
      actualNs: 0,
    };
    if (timerAnimFrame) {
      cancelAnimationFrame(timerAnimFrame);
      timerAnimFrame = null;
    }
  }

  function redrawAll() {
    const isLight = document.body.classList.contains("light-theme");
    // Main canvas
    const mHl = mainAnimEdges.length > 0 ? mainAnimEdges : null;
    const mFill =
      mainEdgeQueue.length > 0
        ? { edge: mainEdgeQueue[0], progress: mainFillProgress }
        : null;
    drawGraph(
      mainCanvas,
      mHl,
      mFill,
      compareMode
        ? isLight
          ? "#0284C7"
          : "#00E5FF"
        : isLight
          ? "#EA580C"
          : "#FF3E00",
      packetPos,
      "main",
    );

    // Compare canvas (only if visible)
    if (compareMode) {
      const cHl = compareAnimEdges.length > 0 ? compareAnimEdges : null;
      const cFill =
        compareEdgeQueue.length > 0
          ? { edge: compareEdgeQueue[0], progress: compareFillProgress }
          : null;
      drawGraph(
        compareCanvas,
        cHl,
        cFill,
        isLight ? "#16A34A" : "#39FF14",
        packetPos,
        "compare",
      );
    }

    updateStats();
  }

  /* ----------------------------------------------------------
     Stats
     ---------------------------------------------------------- */
  function updateStats() {
    statNodes.textContent = nodes.length;
    statLinks.textContent = edges.length;
    const cost = kruskalResult
      ? kruskalResult.totalCost
      : primResult
        ? primResult.totalCost
        : "—";
    statCost.textContent = cost;
  }

  /* ----------------------------------------------------------
     Animation System — Progressive Edge Fill
     ---------------------------------------------------------- */
  function stopAllAnimations() {
    animTimers.forEach((id) => {
      cancelAnimationFrame(id);
      clearTimeout(id);
    });
    animTimers = [];
    if (packetAnimFrame) {
      cancelAnimationFrame(packetAnimFrame);
      packetAnimFrame = null;
    }
    isAnimating = false;
    activeAnimCount = 0;
    mainEdgeQueue = [];
    compareEdgeQueue = [];
    mainFillProgress = 0;
    compareFillProgress = 0;
    clearTimers();
  }

  /**
   * Animate edges one-by-one with a smooth fill effect on one canvas.
   */
  function animateEdgesOnCanvas(orderedEdges, target, onComplete) {
    const queue = [...orderedEdges];
    const revealed = [];
    let fillProg = 0;
    const fillDur = getEdgeFillDuration();

    function setAnimState() {
      if (target === "main") {
        mainAnimEdges = revealed;
        mainEdgeQueue = queue;
        mainFillProgress = fillProg;
      } else {
        compareAnimEdges = revealed;
        compareEdgeQueue = queue;
        compareFillProgress = fillProg;
      }
    }

    function fillNextEdge() {
      if (queue.length === 0) {
        activeAnimCount--;
        if (activeAnimCount <= 0) {
          activeAnimCount = 0;
          isAnimating = false;
          updateRunAgainButton();
        }
        setAnimState();
        redrawAll();
        if (onComplete) onComplete();
        return;
      }

      const edge = queue[0];
      const startTime = performance.now();

      function tick(now) {
        const elapsed = now - startTime;
        fillProg = Math.min(1, elapsed / fillDur);
        setAnimState();
        redrawAll();

        if (fillProg < 1) {
          const id = requestAnimationFrame(tick);
          animTimers.push(id);
        } else {
          // Edge fully revealed
          revealed.push(queue.shift());
          fillProg = 0;
          setAnimState();

          if (target === "main") {
            log(
              `  ▸ edge ${edge.src} — ${edge.dest}  (w: ${edge.weight})`,
              "info",
            );
          }

          // Small pause between edges based on speed
          const pause = Math.max(20, getAnimSpeed() - fillDur);
          const tid = setTimeout(fillNextEdge, pause);
          animTimers.push(tid);
        }
      }

      const id = requestAnimationFrame(tick);
      animTimers.push(id);
    }

    isAnimating = true;
    activeAnimCount++;
    fillNextEdge();
  }

  /* ----------------------------------------------------------
     Run Again Button
     ---------------------------------------------------------- */
  function updateRunAgainButton() {
    const btnRunAgain = document.getElementById("btn-run-again");
    if (!btnRunAgain) return;

    if (lastAlgoRun && !isAnimating) {
      btnRunAgain.style.display = "flex";
      const names = {
        kruskal: "> KRUSKAL'S MST",
        prim: "> PRIM'S MST",
        dijkstra: "> DIJKSTRA'S SPF",
        compare: "COMPARE // K_VS_P",
      };
      btnRunAgain.textContent = `RETRY // ${names[lastAlgoRun] || lastAlgoRun}`;
    } else {
      btnRunAgain.style.display = "none";
    }
  }

  function runAgain() {
    if (!lastAlgoRun || isAnimating) return;
    switch (lastAlgoRun) {
      case "kruskal":
        runKruskal();
        break;
      case "prim":
        runPrim();
        break;
      case "dijkstra":
        if (lastDijkstraSrc !== null && lastDijkstraDest !== null) {
          runDijkstraWithParams(lastDijkstraSrc, lastDijkstraDest);
        }
        break;
      case "compare":
        runCompare(true);
        break;
    }
  }

  /* ----------------------------------------------------------
     Random Graph Generation
     ---------------------------------------------------------- */
  function generateRandomGraph() {
    stopAllAnimations();
    const nodeCount = parseInt(sliderNodes.value, 10);
    const density = parseInt(sliderDensity.value, 10) / 100;
    const maxWeight = parseInt(sliderWeight.value, 10);

    nodes = [];
    edges = [];
    kruskalResult = null;
    primResult = null;
    dijkstraPath = null;
    mainAnimEdges = [];
    compareAnimEdges = [];
    packetPathEdges = [];
    packetPos = null;
    nextNodeId = nodeCount;
    updateRunAgainButton();

    // Reset zoom/pan
    viewState.main = { offsetX: 0, offsetY: 0, zoom: 1 };
    viewState.compare = { offsetX: 0, offsetY: 0, zoom: 1 };

    const pad = 0.06;
    for (let i = 0; i < nodeCount; i++) {
      nodes.push({
        id: i,
        x: pad + Math.random() * (1 - 2 * pad),
        y: pad + Math.random() * (1 - 2 * pad),
      });
    }

    for (let i = 0; i < nodeCount; i++) {
      for (let j = i + 1; j < nodeCount; j++) {
        if (Math.random() < density) {
          edges.push({
            src: i,
            dest: j,
            weight: Math.floor(Math.random() * maxWeight) + 1,
          });
        }
      }
    }

    // Ensure connectivity
    const visited = new Set();
    const queue = [0];
    visited.add(0);
    while (queue.length > 0) {
      const cur = queue.shift();
      edges.forEach((e) => {
        const o = e.src === cur ? e.dest : e.dest === cur ? e.src : -1;
        if (o >= 0 && !visited.has(o)) {
          visited.add(o);
          queue.push(o);
        }
      });
    }
    for (let i = 0; i < nodeCount; i++) {
      if (!visited.has(i)) {
        const t = [...visited][Math.floor(Math.random() * visited.size)];
        edges.push({
          src: t,
          dest: i,
          weight: Math.floor(Math.random() * maxWeight) + 1,
        });
        visited.add(i);
      }
    }

    log(`Generated: ${nodes.length} nodes, ${edges.length} edges`, "success");
    redrawAll();
  }

  /* ----------------------------------------------------------
      Incremental Graph Updates
      ---------------------------------------------------------- */

  /**
   * Update node count: regenerate nodes and edges, but keep same positions if possible
   */
  function updateNodeCount() {
    stopAllAnimations();
    const newNodeCount = parseInt(sliderNodes.value, 10);
    const oldNodeCount = nodes.length;
    const density = parseInt(sliderDensity.value, 10) / 100;
    const maxWeight = parseInt(sliderWeight.value, 10);

    // Clear algorithm results but preserve node positions
    kruskalResult = null;
    primResult = null;
    dijkstraPath = null;
    mainAnimEdges = [];
    compareAnimEdges = [];
    packetPathEdges = [];
    packetPos = null;
    updateRunAgainButton();

    // If adding nodes
    if (newNodeCount > oldNodeCount) {
      const pad = 0.06;
      for (let i = oldNodeCount; i < newNodeCount; i++) {
        nodes.push({
          id: i,
          x: pad + Math.random() * (1 - 2 * pad),
          y: pad + Math.random() * (1 - 2 * pad),
        });
      }
    }
    // If removing nodes
    else if (newNodeCount < oldNodeCount) {
      nodes = nodes.filter((n) => n.id < newNodeCount);
      edges = edges.filter(
        (e) => e.src < newNodeCount && e.dest < newNodeCount,
      );
    }

    // Regenerate edges for the current node set
    edges = [];
    for (let i = 0; i < newNodeCount; i++) {
      for (let j = i + 1; j < newNodeCount; j++) {
        if (Math.random() < density) {
          edges.push({
            src: i,
            dest: j,
            weight: Math.floor(Math.random() * maxWeight) + 1,
          });
        }
      }
    }

    // Ensure connectivity
    const visited = new Set();
    const queue = [0];
    visited.add(0);
    while (queue.length > 0) {
      const cur = queue.shift();
      edges.forEach((e) => {
        const o = e.src === cur ? e.dest : e.dest === cur ? e.src : -1;
        if (o >= 0 && !visited.has(o)) {
          visited.add(o);
          queue.push(o);
        }
      });
    }
    for (let i = 0; i < newNodeCount; i++) {
      if (!visited.has(i)) {
        const t = [...visited][Math.floor(Math.random() * visited.size)];
        edges.push({
          src: t,
          dest: i,
          weight: Math.floor(Math.random() * maxWeight) + 1,
        });
        visited.add(i);
      }
    }

    nextNodeId = newNodeCount;
    log(`Updated to ${nodes.length} nodes, ${edges.length} edges`, "success");
    redrawAll();
  }

  /**
   * Update density: keep all nodes, regenerate edges
   */
  function updateDensity() {
    stopAllAnimations();
    const nodeCount = nodes.length;
    const density = parseInt(sliderDensity.value, 10) / 100;
    const maxWeight = parseInt(sliderWeight.value, 10);

    // Clear algorithm results but keep nodes
    kruskalResult = null;
    primResult = null;
    dijkstraPath = null;
    mainAnimEdges = [];
    compareAnimEdges = [];
    packetPathEdges = [];
    packetPos = null;
    updateRunAgainButton();

    // Regenerate edges with new density
    edges = [];
    for (let i = 0; i < nodeCount; i++) {
      for (let j = i + 1; j < nodeCount; j++) {
        if (Math.random() < density) {
          edges.push({
            src: i,
            dest: j,
            weight: Math.floor(Math.random() * maxWeight) + 1,
          });
        }
      }
    }

    // Ensure connectivity
    const visited = new Set();
    const queue = [0];
    visited.add(0);
    while (queue.length > 0) {
      const cur = queue.shift();
      edges.forEach((e) => {
        const o = e.src === cur ? e.dest : e.dest === cur ? e.src : -1;
        if (o >= 0 && !visited.has(o)) {
          visited.add(o);
          queue.push(o);
        }
      });
    }
    for (let i = 0; i < nodeCount; i++) {
      if (!visited.has(i)) {
        const t = [...visited][Math.floor(Math.random() * visited.size)];
        edges.push({
          src: t,
          dest: i,
          weight: Math.floor(Math.random() * maxWeight) + 1,
        });
        visited.add(i);
      }
    }

    log(
      `Updated density to ${(density * 100).toFixed(0)}%, now ${edges.length} edges`,
      "success",
    );
    redrawAll();
  }

  /**
   * Update max weight: keep all nodes and edges, just reassign weights
   */
  function updateMaxWeight() {
    stopAllAnimations();
    const maxWeight = parseInt(sliderWeight.value, 10);

    // Clear algorithm results (weights affect path costs)
    kruskalResult = null;
    primResult = null;
    dijkstraPath = null;
    mainAnimEdges = [];
    compareAnimEdges = [];
    packetPathEdges = [];
    packetPos = null;
    updateRunAgainButton();

    // Reassign weights to all existing edges
    edges.forEach((edge) => {
      edge.weight = Math.floor(Math.random() * maxWeight) + 1;
    });

    log(
      `Updated max weight to ${maxWeight}, reassigned all edge weights`,
      "success",
    );
    redrawAll();
  }

  /* ----------------------------------------------------------
      Compare Mode
      ---------------------------------------------------------- */
  function exitCompareMode() {
    if (!compareMode) return;
    compareMode = false;
    panelCompare.classList.add("canvas-panel--hidden");
    panelMainTitle.textContent = "Network Graph";
    panelMainBadge.textContent = "";
    btnCompare.textContent = "Compare Kruskal vs Prim";
    mainAnimEdges = [];
    compareAnimEdges = [];
    kruskalResult = null;
    primResult = null;
    setTimeout(redrawAll, 50);
  }

  function toggleCompareMode() {
    if (isAnimating) return;
    compareMode = !compareMode;

    if (compareMode) {
      panelCompare.classList.remove("canvas-panel--hidden");
      panelMainTitle.textContent = "Kruskal's Algorithm";
      panelMainBadge.textContent = "MST";
      btnCompare.textContent = "Exit Compare Mode";
      log("Compare mode ON — Kruskal (left) vs Prim (right)", "info");
    } else {
      panelCompare.classList.add("canvas-panel--hidden");
      panelMainTitle.textContent = "Network Graph";
      panelMainBadge.textContent = "";
      btnCompare.textContent = "Compare Kruskal vs Prim";
      mainAnimEdges = [];
      compareAnimEdges = [];
      kruskalResult = null;
      primResult = null;
      log("Compare mode OFF", "info");
    }
    // Let layout settle, then redraw
    setTimeout(redrawAll, 50);
  }

  /* ----------------------------------------------------------
     Interactive Modes
     ---------------------------------------------------------- */
  function setAddRouterMode(active) {
    addRouterMode = active;
    connectMode = false;
    connectFirst = null;
    btnAddRouter.classList.toggle("active", active);
    btnConnect.classList.remove("active");
    if (active) log("Add Router mode — click canvas to place", "info");
    redrawAll();
  }

  function setConnectMode(active) {
    connectMode = active;
    addRouterMode = false;
    connectFirst = null;
    btnConnect.classList.toggle("active", active);
    btnAddRouter.classList.remove("active");
    if (active) log("Connect mode — click two nodes", "info");
    redrawAll();
  }

  function getNodeAt(canvas, x, y) {
    const view = canvas === compareCanvas ? viewState.compare : viewState.main;
    const baseNr = Math.max(12, Math.min(24, 300 / nodes.length));
    const nr = baseNr * Math.min(view.zoom, 2);
    for (let i = nodes.length - 1; i >= 0; i--) {
      const n = nodes[i];
      const sp = nodeToScreen(n, canvas, view);
      const dx = sp.x - x,
        dy = sp.y - y;
      if (dx * dx + dy * dy <= (nr + 4) * (nr + 4)) return n;
    }
    return null;
  }

  function handleCanvasClick(e) {
    if (isAnimating) return;
    // If we were dragging a node, don't process as a click
    if (isDraggingNode) return;

    const canvas = e.target;
    const rect = canvas.getBoundingClientRect();
    const x = e.clientX - rect.left,
      y = e.clientY - rect.top;
    const view = canvas === compareCanvas ? viewState.compare : viewState.main;

    // --- Add Router ---
    if (addRouterMode) {
      const normalized = screenToNormalized(x, y, canvas, view);
      const n = { id: nextNodeId++, x: normalized.x, y: normalized.y };
      nodes.push(n);
      log(`Added router #${n.id}`, "success");
      clearAlgoResults();
      redrawAll();
      return;
    }

    // --- Connect ---
    if (connectMode) {
      const clicked = getNodeAt(canvas, x, y);
      if (!clicked) {
        if (connectFirst !== null) {
          connectFirst = null;
          log("Connection aborted", "info");
          redrawAll();
        }
        return;
      }
      if (connectFirst === null) {
        connectFirst = clicked.id;
        log(`Selected ${clicked.id} — click another to connect`, "info");
        redrawAll();
      } else {
        if (connectFirst === clicked.id) {
          log("Can't self-loop", "warn");
          connectFirst = null;
          redrawAll();
          return;
        }
        const exists = edges.some(
          (e) =>
            (e.src === connectFirst && e.dest === clicked.id) ||
            (e.src === clicked.id && e.dest === connectFirst),
        );
        if (exists) {
          log(`Edge already exists`, "warn");
          connectFirst = null;
          redrawAll();
          return;
        }
        const w = parseInt(
          prompt(`Weight for ${connectFirst} → ${clicked.id}:`, "1"),
          10,
        );
        if (isNaN(w) || w <= 0) {
          log("Invalid weight", "error");
          connectFirst = null;
          redrawAll();
          return;
        }
        edges.push({ src: connectFirst, dest: clicked.id, weight: w });
        log(`Connected ${connectFirst} ↔ ${clicked.id} (w: ${w})`, "success");
        connectFirst = null;
        clearAlgoResults();
        redrawAll();
      }
      return;
    }

    // --- Packet node selection (default click behavior) ---
    const clicked = getNodeAt(canvas, x, y);

    // Click on empty space clears selection
    if (!clicked) {
      if (packetSrcId !== null || packetDestId !== null) {
        clearNodeSelection();
        log("Canvas clicked: selection reset", "info");
        redrawAll();
      }
      return;
    }

    // Toggle logic: If click existing node, deselect it
    if (clicked.id === packetDestId) {
      packetDestId = null;
      pktDestEl.textContent = "--";
      pktHintEl.textContent = "DEST REMOVED // AWAIT NEW DESTINATION";
      btnSendPacket.disabled = true;
      log(`Deselected destination: node ${clicked.id}`, "info");
    } else if (clicked.id === packetSrcId) {
      if (packetDestId !== null) {
        // Drop src and promote dest to src
        packetSrcId = packetDestId;
        packetDestId = null;
        pktSrcEl.textContent = packetSrcId;
        pktDestEl.textContent = "--";
        pktHintEl.textContent = "AWAIT_INPUT // SELECT DESTINATION NODE";
        btnSendPacket.disabled = true;
      } else {
        packetSrcId = null;
        pktSrcEl.textContent = "--";
        pktHintEl.textContent = "AWAIT_INPUT // SELECT 2 NODES";
        btnSendPacket.disabled = true;
      }
      log(`Deselected source: node ${clicked.id}`, "info");
    } else if (packetSrcId === null) {
      packetSrcId = clicked.id;
      pktSrcEl.textContent = clicked.id;
      pktHintEl.textContent = "AWAIT_INPUT // SELECT DESTINATION NODE";
      log(`Packet source: node ${clicked.id}`, "info");
    } else if (packetDestId === null) {
      packetDestId = clicked.id;
      pktDestEl.textContent = clicked.id;
      pktHintEl.textContent = "READY // HIT TRANSMIT_PKT";
      btnSendPacket.disabled = false;
      log(`Packet destination: node ${clicked.id}`, "info");
    } else {
      // Already two selected — reset and pick new source
      clearNodeSelection();
      packetSrcId = clicked.id;
      pktSrcEl.textContent = clicked.id;
      pktHintEl.textContent = "AWAIT_INPUT // SELECT DESTINATION NODE";
      log(`Re-selected source: node ${clicked.id}`, "info");
    }
    redrawAll();
  }

  function clearNodeSelection() {
    packetSrcId = null;
    packetDestId = null;
    pktSrcEl.textContent = "--";
    pktDestEl.textContent = "--";
    pktHintEl.textContent = "AWAIT_INPUT // SELECT 2 NODES";
    btnSendPacket.disabled = true;
    packetPos = null;
    packetPathEdges = [];

    // Also clear Dijkstra path and any algorithm highlights
    dijkstraPath = null;
    mainAnimEdges = [];
    mainEdgeQueue = [];
    mainFillProgress = 0;
    compareAnimEdges = [];
    compareEdgeQueue = [];
    compareFillProgress = 0;

    // Reset panel title if it was showing Dijkstra
    if (
      panelMainTitle.textContent.includes("Dijkstra") ||
      panelMainTitle.textContent.includes("Packet")
    ) {
      panelMainTitle.textContent = "NET_GRAPH // MAIN";
      panelMainBadge.textContent = "";
    }

    clearTimers();
    redrawAll();
  }

  function clearAlgoResults() {
    kruskalResult = null;
    primResult = null;
    dijkstraPath = null;
    mainAnimEdges = [];
    compareAnimEdges = [];
    mainEdgeQueue = [];
    compareEdgeQueue = [];
    packetPathEdges = [];
    packetPos = null;
    clearTimers();
  }

  /* ----------------------------------------------------------
     Clear All
     ---------------------------------------------------------- */
  function clearAll() {
    stopAllAnimations();
    nodes = [];
    edges = [];
    nextNodeId = 0;
    clearAlgoResults();
    clearNodeSelection();
    addRouterMode = false;
    connectMode = false;
    connectFirst = null;
    btnAddRouter.classList.remove("active");
    btnConnect.classList.remove("active");
    lastAlgoRun = null;
    updateRunAgainButton();
    viewState.main = { offsetX: 0, offsetY: 0, zoom: 1 };
    viewState.compare = { offsetX: 0, offsetY: 0, zoom: 1 };
    log("Canvas cleared", "info");
    redrawAll();
  }

  /* ----------------------------------------------------------
     WASM Bridge
     ---------------------------------------------------------- */
  function loadGraphToWasm() {
    if (nodes.length === 0 || edges.length === 0) {
      log("No graph to load", "warn");
      return false;
    }
    const flat = [];
    edges.forEach((e) => flat.push(e.src, e.dest, e.weight));
    try {
      const ok = NetRouteWasmBridge.loadGraph(flat, nodes.length);
      if (ok) log(`WASM loaded: ${nodes.length}N, ${edges.length}E`, "success");
      else log("WASM loadGraph failed", "error");
      return ok;
    } catch (err) {
      log(`WASM error: ${err.message}`, "error");
      return false;
    }
  }

  /* ----------------------------------------------------------
     Benchmark helpers

     measureExecution(fn)
       Single-algorithm benchmark.  A brief warmup pass is run first
       so the WASM heap allocator's free-lists are pre-populated before
       we start the timed section.

     measureBoth(fnA, fnB)
       Fair head-to-head benchmark.  Both functions are called in an
       A→B alternating pattern inside the SAME loop so they always see
       an IDENTICAL allocator state at the start of every iteration.
       This eliminates the ordering bias that made the second algorithm
       appear systematically faster because it inherited recycled free-
       blocks from the first algorithm's tear-down.
     ---------------------------------------------------------- */
  function measureExecution(fn) {
    // Cold call — gives us the real result for drawing
    const result = fn();

    // Warmup: let the allocator settle
    const WARMUP = 60;
    for (let i = 0; i < WARMUP; i++) fn();

    // Timed section
    const RUNS = 400;
    const start = performance.now();
    for (let i = 0; i < RUNS; i++) fn();
    const elapsedNs = ((performance.now() - start) / RUNS) * 1e6;

    return { result, elapsedNs };
  }

  /**
   * Interleaved dual benchmark — the ONLY correct way to compare two
   * WASM routines that share the same heap allocator.
   *
   * Returns { resultA, resultB, nsA, nsB }
   */
  function measureBoth(fnA, fnB) {
    // Cold calls to get results for drawing
    const resultA = fnA();
    const resultB = fnB();

    // Warmup both together so the allocator sees the full mixed pattern
    const WARMUP = 60;
    for (let i = 0; i < WARMUP; i++) { fnA(); fnB(); }

    // Timed interleaved loop — A and B alternate in the same iteration
    // so their allocator state is as close to identical as possible
    const RUNS = 300;
    let totalA = 0;
    let totalB = 0;

    for (let i = 0; i < RUNS; i++) {
      // Measure A
      const t0 = performance.now();
      fnA();
      totalA += performance.now() - t0;

      // Measure B (same allocator state as after an A teardown)
      const t1 = performance.now();
      fnB();
      totalB += performance.now() - t1;
    }

    return {
      resultA,
      resultB,
      nsA: (totalA / RUNS) * 1e6,
      nsB: (totalB / RUNS) * 1e6,
    };
  }

  /* ----------------------------------------------------------
     Run Kruskal (single mode)
     ---------------------------------------------------------- */
  function runKruskal() {
    if (isAnimating) return;
    if (!wasmReady) {
      log("WASM not ready yet", "warn");
      return;
    }
    exitCompareMode();
    stopAllAnimations();
    clearAlgoResults();
    panelMainTitle.textContent = "Kruskal's Algorithm";
    panelMainBadge.textContent = "MST";
    lastAlgoRun = "kruskal";
    updateRunAgainButton();
    redrawAll();

    if (!loadGraphToWasm()) return;
    try {
      const { result: r, elapsedNs } = measureExecution(() =>
        NetRouteWasmBridge.runKruskal(),
      );
      if (!r) {
        log("Kruskal null — disconnected?", "error");
        return;
      }
      kruskalResult = r;
      log(
        `▶ Kruskal MST: ${r.edgeCount} edges, cost = ${r.totalCost} (${formatNanoTime(elapsedNs)})`,
        "success",
      );
      startTimer("main", "⏱ Kruskal's Algorithm", elapsedNs);
      animateEdgesOnCanvas(r.edges, "main", () => {
        log("✓ Kruskal complete", "success");
      });
    } catch (err) {
      log(`Kruskal error: ${err.message}`, "error");
    }
  }

  /* ----------------------------------------------------------
     Run Prim (single mode)
     ---------------------------------------------------------- */
  function runPrim() {
    if (isAnimating) return;
    if (!wasmReady) {
      log("WASM not ready yet", "warn");
      return;
    }
    exitCompareMode();
    stopAllAnimations();
    clearAlgoResults();
    panelMainTitle.textContent = "Prim's Algorithm";
    panelMainBadge.textContent = "MSF";
    lastAlgoRun = "prim";
    updateRunAgainButton();
    redrawAll();

    if (!loadGraphToWasm()) return;
    try {
      const { result: r, elapsedNs } = measureExecution(() =>
        NetRouteWasmBridge.runPrim(),
      );
      if (!r) {
        log("Prim null — disconnected?", "error");
        return;
      }
      primResult = r;
      log(
        `▶ Prim MST: ${r.edgeCount} edges, cost = ${r.totalCost} (${formatNanoTime(elapsedNs)})`,
        "success",
      );
      startTimer("main", "⏱ Prim's Algorithm", elapsedNs);
      animateEdgesOnCanvas(r.edges, "main", () => {
        log("✓ Prim complete", "success");
      });
    } catch (err) {
      log(`Prim error: ${err.message}`, "error");
    }
  }

  /* ----------------------------------------------------------
     Run Compare Mode (Kruskal + Prim simultaneously)
     ---------------------------------------------------------- */
  function runCompare(forceRun = false) {
    if (isAnimating) return;
    if (!wasmReady) {
      log("WASM not ready yet", "warn");
      return;
    }
    // If already in compare mode and not forced, just exit
    if (compareMode && forceRun !== true) {
      toggleCompareMode();
      return;
    }
    // If not in compare mode, enter it
    if (!compareMode) {
      toggleCompareMode();
    }

    stopAllAnimations();
    activeAnimCount = 0;
    clearAlgoResults();
    lastAlgoRun = "compare";
    updateRunAgainButton();
    redrawAll();

    if (!loadGraphToWasm()) return;
    try {
      // Use the interleaved benchmark so both algorithms see the same
      // WASM heap allocator state — eliminates ordering bias entirely
      const { resultA: rk, resultB: rp, nsA: kNs, nsB: pNs } = measureBoth(
        () => NetRouteWasmBridge.runKruskal(),
        () => NetRouteWasmBridge.runPrim(),
      );
      if (!rk || !rp) {
        log("One or both algorithms returned null", "error");
        return;
      }
      kruskalResult = rk;
      primResult = rp;
      log(
        `▶ Compare: Kruskal cost=${rk.totalCost} (${formatNanoTime(kNs)}), Prim cost=${rp.totalCost} (${formatNanoTime(pNs)})`,
        "success",
      );
      // Contextual explanation of the timing result
      const faster = kNs <= pNs ? "Kruskal" : "Prim";
      const ratio = Math.max(kNs, pNs) / Math.min(kNs, pNs);
      const density = edges.length / (nodes.length * (nodes.length - 1) / 2);
      const graphType = density > 0.5 ? "dense" : "sparse";
      log(
        `  ℹ ${faster} faster by ${ratio.toFixed(1)}×  [Kruskal: O(E·logE) sort | Prim: O(E·logV) heap] — ${graphType} graph (${(density*100).toFixed(0)}% density)`,
        "info",
      );
      if (kNs > pNs && density < 0.5) {
        log(
          `  ℹ Even sparse: Kruskal's qsort + getAllEdges() malloc always adds overhead Prim avoids`,
          "info",
        );
      } else if (kNs > pNs) {
        log(
          `  ℹ Dense graph — Kruskal's qsort(E·logE) dominates; Prim's heap is O(E·logV) which is tighter`,
          "info",
        );
      }

      // Start timers for both
      startTimer("main", "⏱ Kruskal's Algorithm", kNs);
      startTimer("compare", "⏱ Prim's Algorithm", pNs);

      // Animate both simultaneously
      let kDone = false,
        pDone = false;
      function checkBothDone() {
        if (kDone && pDone) {
          isAnimating = false;
          updateRunAgainButton();
          log("✓ Comparison complete", "success");
        }
      }
      animateEdgesOnCanvas(rk.edges, "main", () => {
        kDone = true;
        checkBothDone();
      });
      animateEdgesOnCanvas(rp.edges, "compare", () => {
        pDone = true;
        checkBothDone();
      });
    } catch (err) {
      log(`Compare error: ${err.message}`, "error");
    }
  }

  /* ----------------------------------------------------------
     Run Dijkstra
     ---------------------------------------------------------- */
  function openDijkstraModal() {
    if (isAnimating) return;
    if (!wasmReady) {
      log("WASM not ready yet", "warn");
      return;
    }
    exitCompareMode();
    modalSrc.value = packetSrcId !== null ? packetSrcId : "";
    modalDest.value = packetDestId !== null ? packetDestId : "";
    modalOverlay.classList.add("active");
    modalSrc.focus();
  }
  function closeDijkstraModal() {
    modalOverlay.classList.remove("active");
  }

  function runDijkstra() {
    const src = parseInt(modalSrc.value, 10);
    const dest = parseInt(modalDest.value, 10);
    closeDijkstraModal();
    runDijkstraWithParams(src, dest);
  }

  function runDijkstraWithParams(src, dest) {
    if (isNaN(src) || isNaN(dest)) {
      log("Invalid node IDs", "error");
      return;
    }
    if (!nodes.some((n) => n.id === src) || !nodes.some((n) => n.id === dest)) {
      log(`Node ${src} or ${dest} not found`, "error");
      return;
    }

    stopAllAnimations();
    clearAlgoResults();
    panelMainTitle.textContent = "🛤️ Dijkstra's SPF";
    panelMainBadge.textContent = "SPF";
    packetSrcId = src;
    packetDestId = dest;
    pktSrcEl.textContent = src;
    pktDestEl.textContent = dest;
    lastAlgoRun = "dijkstra";
    lastDijkstraSrc = src;
    lastDijkstraDest = dest;
    updateRunAgainButton();
    redrawAll();

    if (!loadGraphToWasm()) return;
    try {
      const { result: r, elapsedNs } = measureExecution(() =>
        NetRouteWasmBridge.runDijkstra(src, dest),
      );
      if (!r || !r.reachable) {
        log(`No path ${src} → ${dest}`, "warn");
        return;
      }
      dijkstraPath = r.path;
      log(
        `▶ Dijkstra: ${src} → ${dest} | ${r.pathLength} hops (${formatNanoTime(elapsedNs)})`,
        "success",
      );

      const pathEdges = [];
      for (let i = 0; i < r.path.length - 1; i++) {
        const s = r.path[i],
          d = r.path[i + 1];
        const e = edges.find(
          (e) => (e.src === s && e.dest === d) || (e.src === d && e.dest === s),
        );
        pathEdges.push({ src: s, dest: d, weight: e ? e.weight : 0 });
      }

      startTimer("main", "⏱ Dijkstra's SPF", elapsedNs);
      animateEdgesOnCanvas(pathEdges, "main", () => {
        log(`✓ Path: ${r.path.join(" → ")}`, "success");
      });
    } catch (err) {
      log(`Dijkstra error: ${err.message}`, "error");
    }
  }

  /* ----------------------------------------------------------
     Packet Simulation
     ---------------------------------------------------------- */
  function sendPacket() {
    if (packetSrcId === null || packetDestId === null) return;
    if (isAnimating) return;
    if (!wasmReady) {
      log("WASM not ready yet", "warn");
      return;
    }
    exitCompareMode();
    stopAllAnimations();
    clearAlgoResults();
    panelMainTitle.textContent = "📦 Packet Simulation";
    panelMainBadge.textContent = "LIVE";

    if (!loadGraphToWasm()) return;
    try {
      const r = NetRouteWasmBridge.runDijkstra(packetSrcId, packetDestId);
      if (!r || !r.reachable) {
        log(`No route ${packetSrcId} → ${packetDestId}`, "warn");
        return;
      }

      // Build path edges for highlight
      const pathEdges = [];
      for (let i = 0; i < r.path.length - 1; i++) {
        const s = r.path[i],
          d = r.path[i + 1];
        const e = edges.find(
          (e) => (e.src === s && e.dest === d) || (e.src === d && e.dest === s),
        );
        pathEdges.push({ src: s, dest: d, weight: e ? e.weight : 0 });
      }
      packetPathEdges = pathEdges;

      log(`Sending packet: ${r.path.join(" → ")}`, "success");

      // First animate the path edges, then move the packet dot along
      animateEdgesOnCanvas(pathEdges, "main", () => {
        log("✓ Route established — transmitting packet", "info");
        animatePacketDot(r.path);
      });
    } catch (err) {
      log(`Packet error: ${err.message}`, "error");
    }
  }

  function animatePacketDot(path) {
    const totalSegments = path.length - 1;
    if (totalSegments <= 0) return;

    isAnimating = true;
    const segmentDuration = getEdgeFillDuration() * 1.5; // slightly slower for visibility
    let currentSeg = 0;
    let segStart = performance.now();

    function tick(now) {
      const elapsed = now - segStart;
      let t = Math.min(1, elapsed / segmentDuration);

      const srcNode = nodes.find((n) => n.id === path[currentSeg]);
      const destNode = nodes.find((n) => n.id === path[currentSeg + 1]);
      if (!srcNode || !destNode) {
        isAnimating = false;
        return;
      }

      // Ease-in-out
      t = t < 0.5 ? 2 * t * t : 1 - Math.pow(-2 * t + 2, 2) / 2;

      packetPos = {
        x: srcNode.x + (destNode.x - srcNode.x) * t,
        y: srcNode.y + (destNode.y - srcNode.y) * t,
      };
      redrawAll();

      if (elapsed >= segmentDuration) {
        log(`  Packet arrived at node ${path[currentSeg + 1]}`, "info");
        currentSeg++;
        if (currentSeg >= totalSegments) {
          packetPos = null;
          isAnimating = false;
          log(
            `✓ Packet delivered to node ${path[path.length - 1]}!`,
            "success",
          );
          redrawAll();
          return;
        }
        segStart = now;
      }

      packetAnimFrame = requestAnimationFrame(tick);
    }

    packetAnimFrame = requestAnimationFrame(tick);
  }

  /* ----------------------------------------------------------
     Zoom / Pan / Drag Handlers
     ---------------------------------------------------------- */
  function setupCanvasInteraction(canvas, canvasId) {
    let didDrag = false;

    // --- Mouse wheel for zoom ---
    canvas.addEventListener(
      "wheel",
      (e) => {
        e.preventDefault();
        const view = getView(canvasId);
        const rect = canvas.getBoundingClientRect();
        const mx = e.clientX - rect.left;
        const my = e.clientY - rect.top;

        const zoomFactor = e.deltaY < 0 ? 1.1 : 0.9;
        const newZoom = Math.max(0.3, Math.min(5, view.zoom * zoomFactor));

        // Zoom toward mouse position
        const scale = newZoom / view.zoom;
        view.offsetX = mx - (mx - view.offsetX) * scale;
        view.offsetY = my - (my - view.offsetY) * scale;
        view.zoom = newZoom;

        redrawAll();
      },
      { passive: false },
    );

    // --- Mouse down ---
    canvas.addEventListener("mousedown", (e) => {
      const rect = canvas.getBoundingClientRect();
      const mx = e.clientX - rect.left;
      const my = e.clientY - rect.top;
      didDrag = false;

      // Check if clicking on a node → start drag
      const node = getNodeAt(canvas, mx, my);
      if (node && !addRouterMode && !connectMode) {
        isDraggingNode = true;
        dragNode = node;
        dragCanvas = canvas;
        canvas.style.cursor = "grabbing";
        e.preventDefault();
        return;
      }

      // Middle button or right button → start panning
      if (e.button === 1 || e.button === 2 || (e.button === 0 && e.ctrlKey)) {
        isPanning = true;
        panStart = { x: e.clientX, y: e.clientY };
        panTarget = canvasId;
        canvas.style.cursor = "move";
        e.preventDefault();
      }
    });

    // --- Mouse move ---
    canvas.addEventListener("mousemove", (e) => {
      if (isDraggingNode && dragNode && dragCanvas === canvas) {
        const rect = canvas.getBoundingClientRect();
        const mx = e.clientX - rect.left;
        const my = e.clientY - rect.top;
        const view = getView(canvasId);
        const normalized = screenToNormalized(mx, my, canvas, view);
        dragNode.x = Math.max(0.02, Math.min(0.98, normalized.x));
        dragNode.y = Math.max(0.02, Math.min(0.98, normalized.y));
        didDrag = true;
        redrawAll();
        return;
      }

      if (isPanning && panTarget === canvasId) {
        const view = getView(canvasId);
        const dx = e.clientX - panStart.x;
        const dy = e.clientY - panStart.y;
        view.offsetX += dx;
        view.offsetY += dy;
        panStart = { x: e.clientX, y: e.clientY };
        didDrag = true;
        redrawAll();
      }
    });

    // --- Mouse up ---
    canvas.addEventListener("mouseup", (e) => {
      if (isDraggingNode && dragCanvas === canvas) {
        isDraggingNode = false;
        dragNode = null;
        dragCanvas = null;
        canvas.style.cursor = "default";
        // Prevent the click from firing if we actually dragged
        if (didDrag) {
          e.stopImmediatePropagation();
        }
        return;
      }

      if (isPanning && panTarget === canvasId) {
        isPanning = false;
        panTarget = null;
        canvas.style.cursor = "default";
      }
    });

    // --- Mouse leave: cancel drag/pan ---
    canvas.addEventListener("mouseleave", () => {
      if (isDraggingNode && dragCanvas === canvas) {
        isDraggingNode = false;
        dragNode = null;
        dragCanvas = null;
        canvas.style.cursor = "default";
      }
      if (isPanning && panTarget === canvasId) {
        isPanning = false;
        panTarget = null;
        canvas.style.cursor = "default";
      }
    });

    // Disable context menu on canvas
    canvas.addEventListener("contextmenu", (e) => e.preventDefault());

    // Register click handler (for node selection etc.)
    canvas.addEventListener("click", (e) => {
      if (didDrag) {
        didDrag = false;
        return; // skip click after drag
      }
      handleCanvasClick(e);
    });
  }

  /* ----------------------------------------------------------
     WASM Init
     ---------------------------------------------------------- */
  function setAlgoButtonsEnabled(enabled) {
    [btnKruskal, btnPrim, btnDijkstra, btnCompare, btnSendPacket].forEach(
      (b) => {
        if (b) b.disabled = !enabled;
      },
    );
  }

  async function initializeWasm() {
    log("Initializing WASM…", "info");
    setAlgoButtonsEnabled(false);
    try {
      await NetRouteWasmBridge.initWasm();
      wasmReady = true;
      setAlgoButtonsEnabled(true);
      log("WASM ready ✓", "success");
      const s = document.querySelector(".header__status");
      if (s)
        s.innerHTML =
          '<span class="header__status-dot"></span> Network Status: Optimal';
    } catch (err) {
      log(`WASM init failed: ${err.message}`, "error");
      setAlgoButtonsEnabled(false);
      const s = document.querySelector(".header__status");
      if (s) {
        s.style.background = "#fef2f2";
        s.style.color = "#ef4444";
        s.innerHTML =
          '<span class="header__status-dot" style="background:#ef4444"></span> WASM Error';
      }
    }
  }

  /* ----------------------------------------------------------
      Sliders — Live Generation
      ---------------------------------------------------------- */
  function setupSliders() {
    // Track previous values to detect which slider changed
    let prevNodeCount = parseInt(sliderNodes.value, 10);
    let prevDensity = parseInt(sliderDensity.value, 10);
    let prevMaxWeight = parseInt(sliderWeight.value, 10);

    function onSliderChange() {
      const curNodeCount = parseInt(sliderNodes.value, 10);
      const curDensity = parseInt(sliderDensity.value, 10);
      const curMaxWeight = parseInt(sliderWeight.value, 10);

      // Update display values
      valNodes.textContent = sliderNodes.value;
      valDensity.textContent = sliderDensity.value + "%";
      valWeight.textContent = sliderWeight.value;

      if (sliderDebounce) clearTimeout(sliderDebounce);

      // Determine which slider changed and call appropriate update function
      sliderDebounce = setTimeout(() => {
        if (curNodeCount !== prevNodeCount) {
          prevNodeCount = curNodeCount;
          updateNodeCount();
        } else if (curDensity !== prevDensity) {
          prevDensity = curDensity;
          updateDensity();
        } else if (curMaxWeight !== prevMaxWeight) {
          prevMaxWeight = curMaxWeight;
          updateMaxWeight();
        }
      }, 150);
    }

    sliderNodes.addEventListener("input", onSliderChange);
    sliderDensity.addEventListener("input", onSliderChange);
    sliderWeight.addEventListener("input", onSliderChange);

    sliderSpeed.addEventListener("input", () => {
      valSpeed.textContent = sliderSpeed.value + "×";
    });
  }

  /* ----------------------------------------------------------
     Theme Toggle — persisted in localStorage
     ---------------------------------------------------------- */
  const btnThemeToggle = document.getElementById("btn-theme-toggle");

  function applyTheme(isLight) {
    document.body.classList.toggle("light-theme", isLight);
    if (btnThemeToggle) {
      btnThemeToggle.textContent = isLight ? "[☾] DARK_MODE" : "[☼] LIGHT_MODE";
    }
  }

  // Restore saved theme on load
  (function restoreSavedTheme() {
    const saved = localStorage.getItem("netroute-theme");
    // Default is dark; only apply light if explicitly saved
    applyTheme(saved === "light");
  })();

  if (btnThemeToggle) {
    btnThemeToggle.addEventListener("click", () => {
      const isNowLight = document.body.classList.toggle("light-theme");
      localStorage.setItem("netroute-theme", isNowLight ? "light" : "dark");
      applyTheme(isNowLight);
      redrawAll();
    });
  }


  /* --- Compact Mode — migrate stats/logs into side panels when bottom bar collapses --- */
  const COMPACT_THRESHOLD = 130;
  const appDiv = document.getElementById("app");
  const statsRow  = document.querySelector(".stats-row");
  const loggerCard = document.querySelector(".logger-card");
  const sideStatsSlot = document.getElementById("side-stats-slot");
  const sideLogsSlot  = document.getElementById("side-logs-slot");
  let isCompact = false;

  function updateCompactMode(bottomBarHeight) {
    const shouldBeCompact = bottomBarHeight < COMPACT_THRESHOLD;
    if (shouldBeCompact === isCompact) return;
    isCompact = shouldBeCompact;
    if (isCompact) {
      // Move nodes into side panels
      sideStatsSlot.appendChild(statsRow);
      sideLogsSlot.appendChild(loggerCard);
      appDiv.classList.add("layout--compact");
    } else {
      // Move nodes back into the bottom bar (original order: stats first, logs second)
      const bottomBarEl = document.getElementById("bottom-bar");
      bottomBarEl.insertBefore(statsRow, bottomBarEl.firstChild);
      bottomBarEl.appendChild(loggerCard);
      appDiv.classList.remove("layout--compact");
    }
    // Let layout settle then redraw so canvas picks up its new dimensions
    requestAnimationFrame(redrawAll);
  }

  /* --- Resizer Mechanics --- */
  const resizerBottom = document.getElementById("resizer-bottom");
  const bottomBar = document.getElementById("bottom-bar");
  if (resizerBottom && bottomBar) {
    let isResizing = false;
    let startY = 0;
    let startHeight = 0;

    resizerBottom.addEventListener("mousedown", (e) => {
      isResizing = true;
      startY = e.clientY;
      startHeight = parseInt(window.getComputedStyle(bottomBar).height, 10);
      document.body.style.cursor = "ns-resize";
      document.body.style.userSelect = "none";
      e.preventDefault();
    });

    window.addEventListener("mousemove", (e) => {
      if (!isResizing) return;
      const dy = e.clientY - startY;
      let newHeight = startHeight - dy;

      if (newHeight < 40) newHeight = 40;
      if (newHeight > window.innerHeight * 0.6)
        newHeight = window.innerHeight * 0.6;

      bottomBar.style.height = newHeight + "px";
      updateCompactMode(newHeight);
      redrawAll();
    });

    window.addEventListener("mouseup", () => {
      if (isResizing) {
        isResizing = false;
        document.body.style.cursor = "default";
        document.body.style.userSelect = "auto";
      }
    });
  }

  /* ----------------------------------------------------------
     Boot
     ---------------------------------------------------------- */
  function init() {
    // --- Theme: default light, persist via localStorage ---
    const savedTheme = localStorage.getItem("netroute-theme");
    const themeToggleBtn = document.getElementById("btn-theme-toggle");

    function applyTheme(theme) {
      if (theme === "light") {
        document.body.classList.add("light-theme");
        if (themeToggleBtn) themeToggleBtn.textContent = "[☽] DARK_MODE";
      } else {
        document.body.classList.remove("light-theme");
        if (themeToggleBtn) themeToggleBtn.textContent = "[☼] LIGHT_MODE";
      }
      localStorage.setItem("netroute-theme", theme);
      redrawAll();
    }

    // Default to light if no preference saved
    applyTheme(savedTheme || "light");

    if (themeToggleBtn) {
      themeToggleBtn.addEventListener("click", () => {
        const isCurrentlyLight = document.body.classList.contains("light-theme");
        applyTheme(isCurrentlyLight ? "dark" : "light");
      });
    }

    setupSliders();

    btnAddRouter.addEventListener("click", () =>
      setAddRouterMode(!addRouterMode),
    );
    btnConnect.addEventListener("click", () => setConnectMode(!connectMode));
    btnClear.addEventListener("click", clearAll);
    if (btnGenerate) btnGenerate.addEventListener("click", generateRandomGraph);
    btnKruskal.addEventListener("click", runKruskal);
    btnPrim.addEventListener("click", runPrim);
    btnDijkstra.addEventListener("click", openDijkstraModal);
    btnCompare.addEventListener("click", runCompare);
    btnSendPacket.addEventListener("click", sendPacket);
    btnClearSel.addEventListener("click", clearNodeSelection);

    // Run Again button
    const btnRunAgain = document.getElementById("btn-run-again");
    if (btnRunAgain) btnRunAgain.addEventListener("click", runAgain);

    modalRun.addEventListener("click", runDijkstra);
    modalCancel.addEventListener("click", closeDijkstraModal);
    modalOverlay.addEventListener("click", (e) => {
      if (e.target === modalOverlay) closeDijkstraModal();
    });

    // Setup zoom/pan/drag for both canvases
    setupCanvasInteraction(mainCanvas, "main");
    setupCanvasInteraction(compareCanvas, "compare");

    window.addEventListener("resize", () => redrawAll());

    // ResizeObserver: redraw canvas whenever its container changes size
    // (e.g. from the resizer drag — window resize event alone isn't enough)
    if (typeof ResizeObserver !== "undefined") {
      const canvasObserver = new ResizeObserver(() => {
        requestAnimationFrame(redrawAll);
      });
      document.querySelectorAll(".canvas-panel__body").forEach((el) => {
        canvasObserver.observe(el);
      });
    }

    log("NetRoute Simulator v3.0", "info");
    log("—————————————————————————————", "info");
    log("🔍 Scroll to zoom, Ctrl+drag or right-drag to pan", "info");
    log("✋ Drag any node to reposition it", "info");
    initializeWasm();
    generateRandomGraph();
  }

  if (document.readyState === "loading") {
    document.addEventListener("DOMContentLoaded", init);
  } else {
    init();
  }
})();
