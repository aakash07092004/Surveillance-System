import { useState, useEffect, useRef, useCallback } from 'react';

const DB_NAME = "black-eye-db";
const STORE = "events";
const DETECT_W = 160;
const DETECT_H = 90;

// --- IndexedDB Utilities ---
function openDb() {
  return new Promise((resolve, reject) => {
    const request = indexedDB.open(DB_NAME, 1);
    request.onupgradeneeded = () => {
      const db = request.result;
      if (!db.objectStoreNames.contains(STORE)) {
        const store = db.createObjectStore(STORE, { keyPath: "id" });
        store.createIndex("createdAt", "createdAt");
      }
    };
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error);
  });
}

function tx(db, mode = "readonly") {
  return db.transaction(STORE, mode).objectStore(STORE);
}

export function formatTime(ms, withDate = false) {
  const date = new Date(ms);
  return new Intl.DateTimeFormat(undefined, {
    month: withDate ? "short" : undefined,
    day: withDate ? "numeric" : undefined,
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit"
  }).format(date);
}

export function downloadUrl(url, filename) {
  const anchor = document.createElement("a");
  anchor.href = url;
  anchor.download = filename;
  document.body.append(anchor);
  anchor.click();
  anchor.remove();
}

function beep() {
  try {
    const AudioContext = window.AudioContext || window.webkitAudioContext;
    const audio = new AudioContext();
    const oscillator = audio.createOscillator();
    const gain = audio.createGain();
    oscillator.type = "sine";
    oscillator.frequency.value = 880;
    gain.gain.setValueAtTime(.0001, audio.currentTime);
    gain.gain.exponentialRampToValueAtTime(.14, audio.currentTime + .02);
    gain.gain.exponentialRampToValueAtTime(.0001, audio.currentTime + .22);
    oscillator.connect(gain).connect(audio.destination);
    oscillator.start();
    oscillator.stop(audio.currentTime + .24);
  } catch (_) { }
}

// --- Main Surveillance Hook ---
export function useSurveillance() {
  // State
  const [db, setDb] = useState(null);
  const [cameras, setCameras] = useState([]);
  const [selectedCamera, setSelectedCamera] = useState("");
  const [hasCamera, setHasCamera] = useState(false);
  const [armed, setArmed] = useState(false);
  const [events, setEvents] = useState([]);
  const [peakMotion, setPeakMotion] = useState(0);
  const [isMotionRecent, setIsMotionRecent] = useState(false);
  const [toastMessage, setToastMessage] = useState({ text: "", show: false });

  // Settings state
  const [settings, setSettings] = useState({
    threshold: 2.0,
    sensitivity: 35,
    cooldown: 8,
    retention: 60,
    soundAlert: true,
    notifyAlert: false,
    privacyMode: false
  });

  // Mutable Refs (Used for animation loop performance)
  const videoRef = useRef(null);
  const overlayRef = useRef(null);
  const analysisRef = useRef(null);
  const captureRef = useRef(null);
  const motionScoreRef = useRef(null);
  const motionBarRef = useRef(null);
  
  const streamRef = useRef(null);
  const prevFrameRef = useRef(null);
  const rafRef = useRef(0);
  
  // ADDED 'armed' TO THE REF SO THE LOOP CAN ALWAYS READ THE LATEST VALUE
  const stateRef = useRef({ lastCaptureAt: 0, lastMotionAt: 0, currentScore: 0, armed: false });

  // Custom handler to sync React state and our Ref synchronously
  const handleSetArmed = (isArmed) => {
    setArmed(isArmed);
    stateRef.current.armed = isArmed;
    if (isArmed) {
      stateRef.current.lastCaptureAt = 0; // Reset cooldown so it fires immediately on next motion
    }
  };

  // Initialize DB and fetch existing events
  useEffect(() => {
    openDb().then(database => {
      setDb(database);
      const request = tx(database).getAll();
      request.onsuccess = () => {
        setEvents(request.result.sort((a, b) => b.createdAt - a.createdAt));
      };
    }).catch(() => showToast("Local event storage is unavailable."));
  }, []);

  const showToast = useCallback((text) => {
    setToastMessage({ text, show: true });
    setTimeout(() => setToastMessage({ text, show: false }), 2800);
  }, []);

  const getActiveSettings = () => settings;

  const enumerateCameras = async () => {
    if (!navigator.mediaDevices?.enumerateDevices) return;
    const devices = await navigator.mediaDevices.enumerateDevices();
    const videoInputs = devices.filter(device => device.kind === "videoinput");
    setCameras(videoInputs);
  };

  useEffect(() => {
    enumerateCameras();
  }, [hasCamera]);

  const resizeOverlay = () => {
    if (!videoRef.current || !overlayRef.current) return;
    const rect = videoRef.current.getBoundingClientRect();
    const ratio = window.devicePixelRatio || 1;
    overlayRef.current.width = Math.max(1, Math.floor(rect.width * ratio));
    overlayRef.current.height = Math.max(1, Math.floor(rect.height * ratio));
    const ctx = overlayRef.current.getContext("2d");
    ctx.setTransform(ratio, 0, 0, ratio, 0, 0);
  };

  const drawOverlay = (activeCells, score, threshold) => {
    if (!overlayRef.current) return;
    const ctx = overlayRef.current.getContext("2d");
    const rect = overlayRef.current.getBoundingClientRect();
    ctx.clearRect(0, 0, rect.width, rect.height);
    
    if (!activeCells.length) return;

    const isTriggered = score >= threshold;
    ctx.lineWidth = isTriggered ? 2 : 1;
    ctx.strokeStyle = isTriggered ? "rgba(255, 90, 98, .78)" : "rgba(255, 184, 79, .58)";
    ctx.fillStyle = isTriggered ? "rgba(255, 90, 98, .12)" : "rgba(255, 184, 79, .10)";

    const cellW = rect.width / 16;
    const cellH = rect.height / 9;
    activeCells.forEach(cell => {
      const x = cell.x * cellW;
      const y = cell.y * cellH;
      ctx.fillRect(x, y, cellW, cellH);
      ctx.strokeRect(x + .5, y + .5, cellW - 1, cellH - 1);
    });
  };

  const analyzeMotion = () => {
    const video = videoRef.current;
    if (!streamRef.current || video.readyState < 2) return { score: 0, cells: [] };

    const ctx = analysisRef.current.getContext("2d", { willReadFrequently: true });
    ctx.drawImage(video, 0, 0, DETECT_W, DETECT_H);
    const frame = ctx.getImageData(0, 0, DETECT_W, DETECT_H);
    const data = frame.data;
    const previous = prevFrameRef.current;
    prevFrameRef.current = new Uint8ClampedArray(data);

    if (!previous) return { score: 0, cells: [] };

    const currentSettings = getActiveSettings();
    let changed = 0;
    const cellCounts = Array.from({ length: 16 * 9 }, () => 0);

    for (let i = 0; i < data.length; i += 4) {
      const gray = data[i] * .299 + data[i + 1] * .587 + data[i + 2] * .114;
      const oldGray = previous[i] * .299 + previous[i + 1] * .587 + previous[i + 2] * .114;
      if (Math.abs(gray - oldGray) > currentSettings.sensitivity) {
        changed += 1;
        const pixel = i / 4;
        const x = pixel % DETECT_W;
        const y = Math.floor(pixel / DETECT_W);
        const cellX = Math.min(15, Math.floor(x / (DETECT_W / 16)));
        const cellY = Math.min(8, Math.floor(y / (DETECT_H / 9)));
        cellCounts[cellY * 16 + cellX] += 1;
      }
    }

    const score = (changed / (DETECT_W * DETECT_H)) * 100;
    const cells = cellCounts
      .map((count, index) => ({ x: index % 16, y: Math.floor(index / 16), count }))
      .filter(cell => cell.count > 12);

    return { score, cells };
  };

  const loop = useCallback(() => {
    const { score, cells } = analyzeMotion();
    stateRef.current.currentScore = score;
    
    // Fast DOM updates for Performance
    if (motionScoreRef.current) motionScoreRef.current.textContent = `${score.toFixed(2)}%`;
    if (motionBarRef.current) motionBarRef.current.style.width = `${Math.min(100, score * 6)}%`;

    setPeakMotion(prev => Math.max(prev, score));

    const currentSettings = getActiveSettings();
    if (score >= currentSettings.threshold) {
      stateRef.current.lastMotionAt = performance.now();
      setIsMotionRecent(true);
      
      const now = Date.now();
      const cooldownMs = currentSettings.cooldown * 1000;
      
      // FIX: Use the synchronous ref to check if armed, instead of state callbacks
      if (stateRef.current.armed && now - stateRef.current.lastCaptureAt >= cooldownMs) {
        stateRef.current.lastCaptureAt = now;
        captureEvent("Motion detected", score);
      }
    } else {
      if (performance.now() - stateRef.current.lastMotionAt > 900) {
        setIsMotionRecent(false);
      }
    }

    drawOverlay(cells, score, currentSettings.threshold);
    rafRef.current = requestAnimationFrame(loop);
  }, [settings]);

  const startCamera = async () => {
    if (!navigator.mediaDevices?.getUserMedia) {
      showToast("Camera access is not available in this browser.");
      return;
    }
    await stopCamera(false);
    
    const constraints = {
      audio: false,
      video: selectedCamera 
        ? { deviceId: { exact: selectedCamera }, width: { ideal: 1280 }, height: { ideal: 720 } }
        : { width: { ideal: 1280 }, height: { ideal: 720 }, facingMode: "environment" }
    };

    try {
      const stream = await navigator.mediaDevices.getUserMedia(constraints);
      streamRef.current = stream;
      if (videoRef.current) {
          videoRef.current.srcObject = stream;
          await videoRef.current.play();
      }
      prevFrameRef.current = null;
      resizeOverlay();
      setHasCamera(true);
      showToast("Camera started.");
      rafRef.current = requestAnimationFrame(loop);
    } catch (error) {
      streamRef.current = null;
      showToast(error.name === "NotAllowedError" ? "Camera permission blocked." : "Could not start camera.");
    }
  };

  const stopCamera = async (toast = true) => {
    if (rafRef.current) cancelAnimationFrame(rafRef.current);
    rafRef.current = 0;
    
    // Sync both state and ref when stopping
    setArmed(false);
    stateRef.current.armed = false;
    
    prevFrameRef.current = null;
    
    if (streamRef.current) {
      streamRef.current.getTracks().forEach(track => track.stop());
    }
    streamRef.current = null;
    setHasCamera(false);
    
    if (videoRef.current) videoRef.current.srcObject = null;
    if (overlayRef.current) overlayRef.current.getContext("2d").clearRect(0, 0, overlayRef.current.width, overlayRef.current.height);
    if (toast) showToast("Camera stopped.");
  };

  const captureDataUrl = () => {
    const video = videoRef.current;
    const canvas = captureRef.current;
    const ctx = canvas.getContext("2d");
    const videoW = video.videoWidth || 1280;
    const videoH = video.videoHeight || 720;
    const scale = Math.min(1, 1280 / videoW);
    canvas.width = Math.round(videoW * scale);
    canvas.height = Math.round(videoH * scale);
    ctx.drawImage(video, 0, 0, canvas.width, canvas.height);
    return canvas.toDataURL("image/jpeg", 0.82);
  };

  const captureEvent = async (reason = "Manual snapshot", score = stateRef.current.currentScore) => {
    if (!streamRef.current || videoRef.current.readyState < 2) return;
    const image = captureDataUrl();
    const now = Date.now();
    const camLabel = cameras.find(c => c.deviceId === selectedCamera)?.label || "Default camera";
    
    const newEvent = {
      id: `${now}-${crypto.randomUUID ? crypto.randomUUID() : Math.random().toString(16).slice(2)}`,
      reason,
      score: Number(score.toFixed(3)),
      camera: camLabel,
      createdAt: now,
      image
    };

    if (db) {
      const request = tx(db, "readwrite").put(newEvent);
      request.onsuccess = () => {
        setEvents(prev => {
          const updated = [newEvent, ...prev];
          // Prune
          const limit = Math.max(5, getActiveSettings().retention);
          if (updated.length > limit) {
             const extras = updated.slice(limit);
             extras.forEach(ext => tx(db, "readwrite").delete(ext.id));
             return updated.slice(0, limit);
          }
          return updated;
        });
      };
    }

    if (settings.soundAlert) beep();
    if (settings.notifyAlert && "Notification" in window && Notification.permission === "granted") {
      new Notification("Black Eye", { body: `${reason} at ${formatTime(now)}`, image });
    }
    showToast(`${reason}: ${score.toFixed(2)}% motion`);
  };

  const clearEvents = () => {
    if (!db) return;
    if (confirm("Delete all saved surveillance events?")) {
        const request = tx(db, "readwrite").clear();
        request.onsuccess = () => {
            setEvents([]);
            showToast("Saved events cleared.");
        }
    }
  };

  const exportLog = () => {
    const payload = { exportedAt: new Date().toISOString(), eventCount: events.length, events };
    const blob = new Blob([JSON.stringify(payload, null, 2)], { type: "application/json" });
    const url = URL.createObjectURL(blob);
    downloadUrl(url, `black-eye-log-${new Date().toISOString().slice(0, 10)}.json`);
    setTimeout(() => URL.revokeObjectURL(url), 1000);
  };

  const requestNotifications = async (checked) => {
    setSettings(s => ({ ...s, notifyAlert: checked }));
    if (checked && "Notification" in window) {
      if (Notification.permission === "default") {
        const perm = await Notification.requestPermission();
        if (perm !== "granted") {
          setSettings(s => ({ ...s, notifyAlert: false }));
          showToast("Desktop notifications are blocked.");
        }
      } else if (Notification.permission !== "granted") {
        setSettings(s => ({ ...s, notifyAlert: false }));
        showToast("Desktop notifications are blocked.");
      }
    }
  };

  useEffect(() => {
      window.addEventListener("resize", resizeOverlay);
      return () => window.removeEventListener("resize", resizeOverlay);
  }, []);

  useEffect(() => {
      return () => {
          if (rafRef.current) cancelAnimationFrame(rafRef.current);
          if (streamRef.current) streamRef.current.getTracks().forEach(t => t.stop());
      };
  }, []);

  return {
    refs: { videoRef, overlayRef, analysisRef, captureRef, motionScoreRef, motionBarRef },
    state: { hasCamera, armed, events, peakMotion, isMotionRecent, cameras, selectedCamera, toastMessage, settings },
    actions: { 
        startCamera, stopCamera, setArmed: handleSetArmed, captureEvent, clearEvents, exportLog, 
        setSelectedCamera, setSettings, requestNotifications 
    }
  };
}