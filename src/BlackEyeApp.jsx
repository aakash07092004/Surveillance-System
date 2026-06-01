// BlackEyeApp.jsx
import React, { useState, useEffect } from 'react';
import './BlackEye.css';

import { useSurveillance, formatTime, downloadUrl } from './surveillanceLogic';

export default function BlackEyeApp() {
  const { refs, state, actions } = useSurveillance();
  const [clock, setClock] = useState("--:--:--");
  const [modalEvent, setModalEvent] = useState(null);

  // Clock interval
  useEffect(() => {
    const timer = setInterval(() => {
      setClock(new Intl.DateTimeFormat(undefined, {
        hour: "2-digit", minute: "2-digit", second: "2-digit"
      }).format(new Date()));
    }, 1000);
    return () => clearInterval(timer);
  }, []);

  // Modal Keyboard Support
  useEffect(() => {
    const handleKeyDown = (e) => {
        if (e.key === "Escape") setModalEvent(null);
    }
    window.addEventListener("keydown", handleKeyDown);
    return () => window.removeEventListener("keydown", handleKeyDown);
  }, []);

  const handleSettingChange = (key, value) => {
      actions.setSettings(prev => ({ ...prev, [key]: value }));
  };

  return (
    <>
      <main className="shell">
        <header className="topbar">
          <div className="brand">
            <div className="mark" aria-hidden="true"></div>
            <div>
              <h1>Black Eye</h1>
              <p className="sub">Private motion monitoring</p>
            </div>
          </div>
          <div className="status-strip" aria-live="polite">
            <span className="pill">
                <span className={`dot ${state.hasCamera ? "green" : ""}`}></span>
                {state.hasCamera ? "Camera live" : "Camera off"}
            </span>
            <span className="pill">
                <span className={`dot ${state.armed ? "red" : ""}`}></span>
                {state.armed ? "Armed" : "Disarmed"}
            </span>
            <span className="pill">
                <span className={`dot ${state.isMotionRecent ? "amber" : ""}`}></span>
                {state.isMotionRecent ? "Motion" : "Idle"}
            </span>
          </div>
        </header>

        <section className="layout">
          <div>
            <section className="stage" aria-label="Live monitor">
              <div className="video-wrap">
                <video 
                    ref={refs.videoRef} 
                    className={state.settings.privacyMode ? "hidden-feed" : ""}
                    playsInline 
                    muted 
                />
                <canvas ref={refs.overlayRef} id="overlay"></canvas>
                
                {!state.hasCamera && (
                    <div className="empty-feed">
                      <div>
                        <strong>No camera stream</strong>
                        <span>Start a local camera feed to begin monitoring.</span>
                      </div>
                    </div>
                )}

                <div className="hud">
                  <div className="meter-box">
                    <div className="meter-label">
                      <span>Motion score</span>
                      <span ref={refs.motionScoreRef}>0.00%</span>
                    </div>
                    <div className="bar"><span ref={refs.motionBarRef}></span></div>
                  </div>
                  <div className="clock">{clock}</div>
                </div>
              </div>

              <div className="stage-footer">
                <div className="metric">
                  <span>Events</span>
                  <strong>{state.events.length}</strong>
                </div>
                <div className="metric">
                  <span>Last capture</span>
                  <strong>{state.events[0] ? formatTime(state.events[0].createdAt) : "None"}</strong>
                </div>
                <div className="metric">
                  <span>Peak motion</span>
                  <strong>{state.peakMotion.toFixed(2)}%</strong>
                </div>
                <div className="metric">
                  <span>Storage</span>
                  <strong>{state.events.length} saved</strong>
                </div>
              </div>
            </section>

            <section className="events" aria-label="Motion events">
              <div className="events-head">
                <h2>Event Timeline</h2>
                <button className="ghost" type="button" onClick={actions.exportLog}>Export Log</button>
              </div>
              
              {state.events.length === 0 ? (
                  <div className="empty-events">No motion events captured.</div>
              ) : (
                  <div className="events-grid">
                    {state.events.map(ev => (
                      <article key={ev.id} className="event-card">
                        <img src={ev.image} alt="Motion event" />
                        <div className="event-body">
                          <div className="event-meta">
                            <strong>{formatTime(ev.createdAt, true)}</strong>
                            <span>{ev.reason} - {ev.score.toFixed(2)}% motion</span>
                          </div>
                          <div className="event-actions">
                            <button type="button" onClick={() => setModalEvent(ev)}>View</button>
                            <button type="button" onClick={() => downloadUrl(ev.image, `event-${ev.id}.jpg`)}>Save</button>
                          </div>
                        </div>
                      </article>
                    ))}
                  </div>
              )}
            </section>
          </div>

          <aside className="rail" aria-label="Controls and settings">
            <section className="panel">
              <h2>Controls</h2>
              <div className="control-grid">
                <button className="primary" type="button" disabled={state.hasCamera} onClick={actions.startCamera}>Start Camera</button>
                <button type="button" disabled={!state.hasCamera} onClick={actions.stopCamera}>Stop</button>
                <button type="button" disabled={!state.hasCamera || state.armed} onClick={() => actions.setArmed(true)}>Arm</button>
                <button type="button" disabled={!state.armed} onClick={() => actions.setArmed(false)}>Disarm</button>
                <button type="button" disabled={!state.hasCamera} onClick={() => actions.captureEvent()}>Snapshot</button>
                <button className="danger" type="button" onClick={actions.clearEvents}>Clear Data</button>
              </div>

              <div className="field">
                <label htmlFor="cameraSelect">Camera</label>
                <select 
                    id="cameraSelect" 
                    value={state.selectedCamera} 
                    onChange={e => {
                        actions.setSelectedCamera(e.target.value);
                        if (state.hasCamera) setTimeout(actions.startCamera, 100);
                    }}
                >
                  <option value="">Default camera</option>
                  {state.cameras.map((cam, idx) => (
                    <option key={cam.deviceId} value={cam.deviceId}>{cam.label || `Camera ${idx + 1}`}</option>
                  ))}
                </select>
              </div>
            </section>

            <section className="panel">
              <h2>Detection</h2>
              <div className="field">
                <div className="range-line">
                  <label htmlFor="motionThreshold">Motion threshold</label>
                  <output>{Number(state.settings.threshold).toFixed(1)}%</output>
                </div>
                <input 
                    id="motionThreshold" type="range" min="0.2" max="16" step="0.1" 
                    value={state.settings.threshold} 
                    onChange={e => handleSettingChange('threshold', Number(e.target.value))} 
                />
              </div>

              <div className="field">
                <div className="range-line">
                  <label htmlFor="pixelSensitivity">Pixel sensitivity</label>
                  <output>{state.settings.sensitivity}</output>
                </div>
                <input 
                    id="pixelSensitivity" type="range" min="8" max="80" step="1" 
                    value={state.settings.sensitivity} 
                    onChange={e => handleSettingChange('sensitivity', Number(e.target.value))} 
                />
              </div>

              <div className="field">
                <label htmlFor="cooldown">Capture cooldown seconds</label>
                <input 
                    id="cooldown" type="number" min="2" max="120" step="1" 
                    value={state.settings.cooldown} 
                    onChange={e => handleSettingChange('cooldown', Number(e.target.value))} 
                />
              </div>

              <div className="field">
                <label htmlFor="retention">Saved event limit</label>
                <input 
                    id="retention" type="number" min="5" max="250" step="1" 
                    value={state.settings.retention} 
                    onChange={e => handleSettingChange('retention', Number(e.target.value))} 
                />
              </div>
            </section>

            <section className="panel">
              <h2>Alerts</h2>
              <div className="toggles">
                <label className="toggle-row" htmlFor="soundToggle">
                  <span>Alarm tone</span>
                  <input 
                      id="soundToggle" type="checkbox" 
                      checked={state.settings.soundAlert}
                      onChange={e => handleSettingChange('soundAlert', e.target.checked)} 
                  />
                </label>
                <label className="toggle-row" htmlFor="notifyToggle">
                  <span>Desktop notification</span>
                  <input 
                      id="notifyToggle" type="checkbox" 
                      checked={state.settings.notifyAlert}
                      onChange={e => actions.requestNotifications(e.target.checked)} 
                  />
                </label>
                <label className="toggle-row" htmlFor="privacyToggle">
                  <span>Hide live feed</span>
                  <input 
                      id="privacyToggle" type="checkbox" 
                      checked={state.settings.privacyMode}
                      onChange={e => handleSettingChange('privacyMode', e.target.checked)} 
                  />
                </label>
              </div>
            </section>
          </aside>
        </section>
      </main>

      {/* Hidden processing canvases */}
      <canvas ref={refs.analysisRef} width="160" height="90" hidden></canvas>
      <canvas ref={refs.captureRef} hidden></canvas>

      <div className={`toast ${state.toastMessage.show ? "show" : ""}`} role="status" aria-live="polite">
          {state.toastMessage.text}
      </div>

      <div 
          className={`modal ${modalEvent ? "open" : ""}`} 
          role="dialog" 
          aria-modal="true" 
          aria-label="Event preview"
          onClick={(e) => { if(e.target.classList.contains("modal")) setModalEvent(null) }}
      >
        <div className="modal-inner">
          {modalEvent && <img src={modalEvent.image} alt="Captured motion event" />}
          <div className="modal-bar">
            <span>{modalEvent ? `${formatTime(modalEvent.createdAt, true)} - ${modalEvent.score.toFixed(2)}% motion` : ""}</span>
            <button type="button" onClick={() => setModalEvent(null)}>Close</button>
          </div>
        </div>
      </div>
    </>
  );
}