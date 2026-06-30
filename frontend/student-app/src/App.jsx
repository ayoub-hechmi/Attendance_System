import { useRef, useState, useEffect } from 'react'

const API = '/api/v1'
const AUTO_CHECKIN_SECS = 2

const ENROLL_POSES = [
  { label: 'Look straight at the camera', sub: 'Keep your face centered and still' },
  { label: 'Turn slightly LEFT',           sub: 'About 30° to the left' },
  { label: 'Turn slightly RIGHT',          sub: 'About 30° to the right' },
  { label: 'Tilt slightly UP',             sub: 'Look a little toward the ceiling' },
  { label: 'Tilt slightly DOWN',           sub: 'Look a little toward the floor' },
]

export default function App() {
  const videoRef    = useRef(null)
  const displayRef  = useRef(null)
  const captureRef  = useRef(null)
  const streamRef   = useRef(null)
  const lastGoodBlobRef = useRef(null)

  const fastBboxRef   = useRef(null)
  const identifiedRef = useRef(null)
  const lerpBboxRef   = useRef(null)
  const enrollVideoRef   = useRef(null)
  const enrollStreamRef  = useRef(null)

  const [step, setStep]         = useState('enter')
  const [windowId, setWindowId] = useState('')
  const [windowInfo, setWindowInfo] = useState(null)
  const [timeLeft, setTimeLeft]   = useState(null)
  const [message, setMessage]     = useState('')
  const [checkedInName, setCheckedInName] = useState('')
  const [fastBbox, setFastBbox]   = useState(null)
  const [identified, setIdentified] = useState(null)
  const [detecting, setDetecting] = useState(false)
  const [checkInCountdown, setCheckInCountdown] = useState(null) // 2, 1, null
  const [notRecognised, setNotRecognised] = useState(false)
  const [enrollName,    setEnrollName]    = useState('')
  const [enrollNumber,  setEnrollNumber]  = useState('')
  const [enrollPhotos,  setEnrollPhotos]  = useState([])   // rendered progress only
  const [enrollPoseStep,  setEnrollPoseStep]  = useState(0)
  const [enrollCountdown, setEnrollCountdown] = useState(3)
  const [enrollFlash,     setEnrollFlash]     = useState(false)

  // ── Read window ID from URL ────────────────────────────────────────────────
  useEffect(() => {
    const wid = new URLSearchParams(location.search).get('window')
    if (wid) setWindowId(wid)
  }, [])

  // ── Fetch window status ────────────────────────────────────────────────────
  useEffect(() => {
    if (!windowId) return
    fetch(`${API}/attendance/window/${windowId}/status`)
      .then(r => r.json())
      .then(d => { if (!d.detail) { setWindowInfo(d); setTimeLeft(d.remaining_seconds) } })
      .catch(() => {})
  }, [windowId])

  // ── Countdown ──────────────────────────────────────────────────────────────
  useEffect(() => {
    if (timeLeft === null || timeLeft <= 0) return
    const id = setTimeout(() => setTimeLeft(t => Math.max(0, t - 1)), 1000)
    return () => clearTimeout(id)
  }, [timeLeft])

  // ── Attach stream ──────────────────────────────────────────────────────────
  useEffect(() => {
    if (step === 'camera' && videoRef.current && streamRef.current) {
      videoRef.current.srcObject = streamRef.current
    }
    if (step === 'enroll_camera' && enrollVideoRef.current && enrollStreamRef.current) {
      enrollVideoRef.current.srcObject = enrollStreamRef.current
    }
  }, [step])

  // ── Guided enrollment auto-capture ─────────────────────────────────────────
  useEffect(() => {
    if (step !== 'enroll_camera') return
    let cancelled = false
    const sleep = ms => new Promise(r => setTimeout(r, ms))
    const blobs = []

    ;(async () => {
      // Wait for the video element to start playing
      await sleep(1200)
      for (let i = 0; i < ENROLL_POSES.length; i++) {
        if (cancelled) return
        setEnrollPoseStep(i)
        for (let c = 3; c >= 1; c--) {
          if (cancelled) return
          setEnrollCountdown(c)
          await sleep(1000)
        }
        if (cancelled) return

        // Capture frame
        const video = enrollVideoRef.current
        if (video && video.videoWidth > 0) {
          const canvas = document.createElement('canvas')
          canvas.width  = video.videoWidth
          canvas.height = video.videoHeight
          canvas.getContext('2d').drawImage(video, 0, 0)
          setEnrollFlash(true)
          setTimeout(() => setEnrollFlash(false), 220)
          const blob = await new Promise(r => canvas.toBlob(r, 'image/jpeg', 0.92))
          if (blob) { blobs.push(blob); setEnrollPhotos([...blobs]) }
        }
        await sleep(600)
      }
      if (!cancelled && blobs.length > 0) {
        stopEnrollCamera()
        setStep('enrolling')
        const form = new FormData()
        form.append('name',           enrollName.trim())
        form.append('student_number', enrollNumber.trim())
        form.append('window_id',      windowId)
        blobs.forEach((b, i) => form.append('images', b, `pose_${i}.jpg`))
        try {
          const res  = await fetch(`${API}/attendance/self-enroll`, { method: 'POST', body: form })
          const data = await res.json()
          if (res.ok) { setCheckedInName(data.student_name); setStep('done') }
          else        { setMessage(data.detail || 'Enrollment failed'); setStep('error') }
        } catch (err) {
          setMessage(`Network error: ${err.message}`); setStep('error')
        }
      }
    })()
    return () => { cancelled = true }
  }, [step]) // eslint-disable-line

  // ── Auto check-in countdown ────────────────────────────────────────────────
  // Starts when recognition is confirmed; cancels if recognition is lost
  useEffect(() => {
    const recognized = identified?.found === true
    if (!recognized || step !== 'camera') {
      setCheckInCountdown(null)
      return
    }
    setCheckInCountdown(AUTO_CHECKIN_SECS)
    const timers = []
    for (let i = 1; i < AUTO_CHECKIN_SECS; i++) {
      timers.push(setTimeout(() => setCheckInCountdown(AUTO_CHECKIN_SECS - i), i * 1000))
    }
    timers.push(setTimeout(() => {
      setCheckInCountdown(null)
      doCheckIn()
    }, AUTO_CHECKIN_SECS * 1000))
    return () => timers.forEach(clearTimeout)
  }, [identified, step]) // eslint-disable-line

  // ── RAF render loop ────────────────────────────────────────────────────────
  useEffect(() => {
    if (step !== 'camera') return
    let active = true
    let rafId

    function drawRoundRect(ctx, x, y, w, h, r) {
      ctx.beginPath()
      ctx.moveTo(x + r, y); ctx.lineTo(x + w - r, y); ctx.quadraticCurveTo(x + w, y, x + w, y + r)
      ctx.lineTo(x + w, y + h - r); ctx.quadraticCurveTo(x + w, y + h, x + w - r, y + h)
      ctx.lineTo(x + r, y + h); ctx.quadraticCurveTo(x, y + h, x, y + h - r)
      ctx.lineTo(x, y + r); ctx.quadraticCurveTo(x, y, x + r, y)
      ctx.closePath()
    }

    function render() {
      if (!active) return
      const canvas = displayRef.current
      const video  = videoRef.current
      if (canvas && video && video.videoWidth) {
        const vw = video.videoWidth
        const vh = video.videoHeight
        if (canvas.width !== vw)  canvas.width  = vw
        if (canvas.height !== vh) canvas.height = vh
        const ctx = canvas.getContext('2d')
        ctx.save()
        ctx.transform(-1, 0, 0, 1, vw, 0)
        ctx.drawImage(video, 0, 0)
        ctx.restore()

        const target = fastBboxRef.current
        if (!target) {
          lerpBboxRef.current = null
        } else if (!lerpBboxRef.current) {
          lerpBboxRef.current = [...target]
        } else {
          const t = 0.18
          lerpBboxRef.current = target.map((v, i) => lerpBboxRef.current[i] + (v - lerpBboxRef.current[i]) * t)
        }

        const bbox = lerpBboxRef.current
        if (bbox) {
          const [rx1, ry1, rx2, ry2] = bbox
          const x1 = vw - rx2
          const x2 = vw - rx1
          const y1 = ry1
          const y2 = ry2
          const idf = identifiedRef.current
          const found = idf?.found
          const color = found ? '#22c55e' : '#ef4444'
          const lw = Math.max(2, vw / 250)

          ctx.strokeStyle = color
          ctx.lineWidth = lw
          ctx.strokeRect(x1, y1, x2 - x1, y2 - y1)

          const cs = Math.min((x2 - x1) * 0.18, 22)
          ctx.lineWidth = lw * 2.5
          ;[[x1, y1, 1, 1], [x2, y1, -1, 1], [x1, y2, 1, -1], [x2, y2, -1, -1]].forEach(([cx, cy, dx, dy]) => {
            ctx.beginPath(); ctx.moveTo(cx + dx * cs, cy); ctx.lineTo(cx, cy); ctx.lineTo(cx, cy + dy * cs); ctx.stroke()
          })

          if (idf !== null) {
            const label = found ? `${idf.name} (${idf.score}%)` : 'Not recognised'
            const fs = Math.max(13, vw / 38)
            ctx.font = `600 ${fs}px system-ui, sans-serif`
            const labelW = ctx.measureText(label).width + 16
            const labelH = fs + 12
            const labelY = y1 > labelH + 4 ? y1 - 4 : y2 + 4
            ctx.fillStyle = color + 'dd'
            drawRoundRect(ctx, x1, labelY - labelH, labelW, labelH, 5)
            ctx.fill()
            ctx.fillStyle = '#fff'
            ctx.fillText(label, x1 + 8, labelY - (labelH - fs) / 2 - 2)
          }
        }
      }
      rafId = requestAnimationFrame(render)
    }
    render()
    return () => { active = false; cancelAnimationFrame(rafId) }
  }, [step])

  // ── FAST loop: bbox position ───────────────────────────────────────────────
  useEffect(() => {
    if (step !== 'camera') return
    let active = true

    async function fastLoop() {
      if (!active) return
      const video = videoRef.current
      if (!video || video.videoWidth === 0) {
        if (active) setTimeout(fastLoop, 150)
        return
      }
      try {
        const tmp = document.createElement('canvas')
        tmp.width = video.videoWidth
        tmp.height = video.videoHeight
        tmp.getContext('2d').drawImage(video, 0, 0)
        const blob = await new Promise(r => tmp.toBlob(r, 'image/jpeg', 0.45))
        const form = new FormData()
        form.append('image', blob, 'f.jpg')
        const res = await fetch(`${API}/attendance/detect-only`, { method: 'POST', body: form })
        if (res.ok && active) {
          const data = await res.json()
          fastBboxRef.current = data.bbox
          setFastBbox(data.bbox)
        }
      } catch {}
      if (active) fastLoop()
    }
    fastLoop()
    return () => { active = false; fastBboxRef.current = null; setFastBbox(null) }
  }, [step])

  // ── SLOW loop: full identify ───────────────────────────────────────────────
  useEffect(() => {
    if (step !== 'camera' || !windowId) return
    let active = true

    async function identifyLoop() {
      if (!active) return
      const video = videoRef.current
      if (!video || video.videoWidth === 0) {
        if (active) setTimeout(identifyLoop, 500)
        return
      }
      try {
        const tmp = document.createElement('canvas')
        tmp.width = video.videoWidth
        tmp.height = video.videoHeight
        tmp.getContext('2d').drawImage(video, 0, 0)
        const blob = await new Promise(r => tmp.toBlob(r, 'image/jpeg', 0.8))
        const form = new FormData()
        form.append('image', blob, 'id.jpg')
        form.append('window_id', windowId)
        if (active) setDetecting(true)
        const res = await fetch(`${API}/attendance/identify`, { method: 'POST', body: form })
        if (res.ok && active) {
          const data = await res.json()
          identifiedRef.current = data
          setIdentified(data)
          if (data.found) lastGoodBlobRef.current = blob
        }
      } catch {}
      if (active) { setDetecting(false); setTimeout(identifyLoop, 2000) }
    }
    identifyLoop()
    return () => { active = false; identifiedRef.current = null; setIdentified(null); setDetecting(false) }
  }, [step, windowId])

  // ── Enrollment helpers ─────────────────────────────────────────────────────
  async function startEnrollCamera() {
    try {
      const stream = await navigator.mediaDevices.getUserMedia({
        video: { facingMode: { ideal: 'user' }, width: { ideal: 1280 }, height: { ideal: 720 } },
      })
      enrollStreamRef.current = stream
      setEnrollPhotos([])
      setEnrollPoseStep(0)
      setEnrollCountdown(3)
      setEnrollFlash(false)
      setStep('enroll_camera')
    } catch (err) {
      setMessage(`Camera error: ${err.name}`)
      setStep('error')
    }
  }

  function stopEnrollCamera() {
    enrollStreamRef.current?.getTracks().forEach(t => t.stop())
  }

  // ── Camera controls ────────────────────────────────────────────────────────
  function stopCamera() {
    streamRef.current?.getTracks().forEach(t => t.stop())
  }

  async function startCamera() {
    try {
      const stream = await navigator.mediaDevices.getUserMedia({
        video: { facingMode: { ideal: 'user' }, width: { ideal: 1280 }, height: { ideal: 720 } },
      })
      streamRef.current = stream
      setStep('camera')
    } catch (err) {
      if (location.protocol !== 'https:' && location.hostname !== 'localhost') {
        setMessage('Camera requires HTTPS. Open the link using https:// not http://')
      } else if (err.name === 'NotAllowedError') {
        setMessage('Camera permission denied. Tap "Allow" when your browser asks.')
      } else if (err.name === 'NotFoundError') {
        setMessage('No camera found on this device.')
      } else {
        setMessage(`Camera error: ${err.name}`)
      }
      setStep('error')
    }
  }

  // ── Check In ───────────────────────────────────────────────────────────────
  async function doCheckIn() {
    const blob = lastGoodBlobRef.current
    if (!blob) return
    stopCamera()
    setStep('scanning')

    const form = new FormData()
    form.append('image', blob, 'scan.jpg')
    form.append('window_id', windowId)

    try {
      const res  = await fetch(`${API}/attendance/scan-sync`, { method: 'POST', body: form })
      if (res.status === 429) {
        setMessage('Please wait a moment before trying again.')
        setStep('error')
        return
      }
      if (res.status === 503) {
        setMessage('The face recognition service is temporarily unavailable. Please ask your teacher for assistance.')
        setStep('error')
        return
      }
      const text = await res.text()
      let data
      try { data = JSON.parse(text) } catch { data = { status: 'error', message: text } }

      const msg = data.message || 'Unknown response'
      setMessage(msg)
      if (data.student_name) setCheckedInName(data.student_name)
      setNotRecognised(data.status === 'not_recognised')

      if (data.status === 'present') {
        setStep('done')
      } else if (data.status === 'already_present') {
        // Show success if they're already marked present
        if (data.student_name) setCheckedInName(data.student_name)
        setStep('done')
      } else {
        setStep('error')
      }
    } catch (err) {
      setMessage(`Network error: ${err.message}`)
      setStep('error')
    }
  }

  // ── Helpers ────────────────────────────────────────────────────────────────
  const mins = timeLeft != null ? String(Math.floor(timeLeft / 60)).padStart(2, '0') : '--'
  const secs = timeLeft != null ? String(timeLeft % 60).padStart(2, '0') : '--'
  const expired = timeLeft === 0 && windowInfo != null
  const recognized = identified?.found === true

  // ── Render ─────────────────────────────────────────────────────────────────
  return (
    <div className="min-h-screen bg-gray-950 text-white flex flex-col items-center justify-center p-4">
      <div className="w-full max-w-md space-y-4">

        <h1 className="text-2xl font-bold text-center text-indigo-400 tracking-tight">
          Face Attendance
        </h1>

        {/* Session countdown */}
        {windowInfo && (
          <div className={`flex items-center justify-between rounded-xl px-4 py-3 ${
            expired ? 'bg-red-950 border border-red-700'
              : timeLeft < 60 ? 'bg-yellow-950 border border-yellow-700'
              : 'bg-gray-800 border border-gray-700'
          }`}>
            <span className="text-gray-400 text-sm">Session closes in</span>
            <span className={`font-mono text-2xl font-bold tabular-nums ${
              expired ? 'text-red-400' : timeLeft < 60 ? 'text-yellow-400' : 'text-green-400'
            }`}>{mins}:{secs}</span>
          </div>
        )}

        {/* ── SESSION CLOSED (expired while in-flow) ── */}
        {expired && step !== 'done' && step !== 'enter' && (
          <div className="bg-red-950 border border-red-700 rounded-2xl p-8 text-center space-y-3">
            <p className="text-red-300 font-semibold text-lg">Session Closed</p>
            <p className="text-gray-400 text-sm">The attendance window has ended. Contact your teacher if you need to be marked present.</p>
            <button
              onClick={() => { stopCamera(); setStep('enter') }}
              className="bg-gray-700 hover:bg-gray-600 rounded-xl px-6 py-2.5 text-sm font-medium transition-colors"
            >
              Back to Start
            </button>
          </div>
        )}

        {/* ── ENTER ── */}
        {step === 'enter' && (
          <div className="bg-gray-800 border border-gray-700 rounded-2xl p-6 space-y-3">
            {!windowId && (
              <>
                <p className="text-gray-400 text-sm text-center">Enter your session ID to continue.</p>
                <input
                  className="w-full bg-gray-700 rounded-lg px-4 py-3 placeholder-gray-400 focus:outline-none focus:ring-2 focus:ring-indigo-500"
                  placeholder="Session ID (from QR / link)"
                  value={windowId}
                  onChange={e => setWindowId(e.target.value)}
                />
              </>
            )}

            {expired ? (
              <div className="text-center py-2 space-y-2">
                <p className="text-red-400 text-sm font-medium">This attendance session has closed.</p>
                <p className="text-gray-500 text-xs">Contact your teacher if you need to be marked present.</p>
              </div>
            ) : windowId ? (
              <>
                <p className="text-gray-400 text-sm text-center pb-1">How would you like to check in?</p>

                <button
                  onClick={startCamera}
                  className="w-full bg-indigo-600 hover:bg-indigo-500 rounded-xl px-5 py-4 flex items-center gap-4 text-left transition-colors"
                >
                  <span className="text-3xl">🙂</span>
                  <div>
                    <p className="font-semibold text-white">Scan My Face</p>
                    <p className="text-indigo-200 text-xs mt-0.5">I'm already enrolled in this class</p>
                  </div>
                </button>

                <button
                  onClick={() => { setEnrollName(''); setEnrollNumber(''); setEnrollPhotos([]); setStep('enroll_form') }}
                  className="w-full bg-gray-700 hover:bg-gray-600 rounded-xl px-5 py-4 flex items-center gap-4 text-left transition-colors"
                >
                  <span className="text-3xl">📝</span>
                  <div>
                    <p className="font-semibold text-white">Register &amp; Check In</p>
                    <p className="text-gray-400 text-xs mt-0.5">First time — enroll your face now</p>
                  </div>
                </button>
              </>
            ) : null}
          </div>
        )}

        {/* ── CAMERA ── */}
        {step === 'camera' && (
          <div className="space-y-3">
            <video ref={videoRef} autoPlay playsInline muted className="hidden" />
            <canvas ref={displayRef} className="w-full block rounded-2xl bg-black" />
            <canvas ref={captureRef} className="hidden" />

            {/* Status pill */}
            <div className={`flex items-center gap-2 rounded-xl px-4 py-2.5 text-sm font-medium ${
              recognized
                ? 'bg-green-900/50 border border-green-700 text-green-300'
                : detecting && fastBbox
                ? 'bg-indigo-900/50 border border-indigo-700 text-indigo-300'
                : fastBbox && identified && !identified.found
                ? 'bg-red-900/50 border border-red-700 text-red-300'
                : 'bg-gray-800 border border-gray-700 text-gray-400'
            }`}>
              <span className={`w-2 h-2 rounded-full flex-shrink-0 ${
                recognized ? 'bg-green-400 animate-pulse'
                  : detecting && fastBbox ? 'bg-indigo-400 animate-pulse'
                  : fastBbox && identified && !identified.found ? 'bg-red-400'
                  : 'bg-gray-500 animate-pulse'
              }`} />
              {recognized && checkInCountdown !== null
                ? `Recognised: ${identified.name} — checking in in ${checkInCountdown}s…`
                : recognized
                ? `Recognised: ${identified.name}`
                : detecting && fastBbox
                ? 'Hold still — scanning…'
                : fastBbox && identified && !identified.found
                ? 'Not recognised — try adjusting your angle or lighting'
                : fastBbox
                ? 'Face detected — scanning…'
                : 'Point your camera at your face'}
            </div>

            {/* Check In button shows countdown or normal state */}
            <button
              onClick={doCheckIn}
              disabled={!recognized}
              className={`w-full rounded-xl py-3.5 font-bold text-lg transition-colors ${
                recognized
                  ? 'bg-green-600 hover:bg-green-500'
                  : 'bg-green-600 opacity-40 cursor-not-allowed'
              }`}
            >
              {checkInCountdown !== null
                ? `Auto check-in in ${checkInCountdown}s — tap to skip`
                : 'Check In'}
            </button>

            <button
              onClick={() => { stopCamera(); setStep('enter') }}
              className="w-full text-gray-500 hover:text-gray-300 text-sm transition-colors py-1"
            >
              Cancel
            </button>
          </div>
        )}

        {/* ── SCANNING ── */}
        {step === 'scanning' && (
          <div className="bg-gray-800 border border-gray-700 rounded-2xl p-10 text-center space-y-5">
            <div className="w-14 h-14 mx-auto border-4 border-indigo-500 border-t-transparent rounded-full animate-spin" />
            <div>
              <p className="text-white font-semibold">Verifying identity…</p>
              <p className="text-gray-400 text-sm mt-1">Please wait, do not close this tab</p>
            </div>
          </div>
        )}

        {/* ── DONE ── */}
        {step === 'done' && (
          <div className="bg-green-950 border border-green-600 rounded-2xl p-10 text-center space-y-5">
            <div className="w-20 h-20 mx-auto rounded-full bg-green-600 flex items-center justify-center shadow-lg shadow-green-900/50">
              <svg className="w-11 h-11 text-white" fill="none" stroke="currentColor" strokeWidth="3" viewBox="0 0 24 24">
                <path strokeLinecap="round" strokeLinejoin="round" d="M5 13l4 4L19 7" />
              </svg>
            </div>
            {checkedInName && (
              <p className="text-white text-3xl font-bold tracking-tight">
                Welcome,<br />{checkedInName}!
              </p>
            )}
            <p className="text-green-400 font-semibold text-lg">
              {message.includes('already') ? 'Already Checked In' : 'Attendance Recorded'}
            </p>
            <p className="text-gray-500 text-sm pt-2">You can close this tab.</p>
          </div>
        )}

        {/* ── ERROR ── */}
        {step === 'error' && (
          <div className="bg-red-950 border border-red-700 rounded-2xl p-8 text-center space-y-4">
            <div className="w-14 h-14 mx-auto rounded-full bg-red-700/50 flex items-center justify-center">
              <svg className="w-8 h-8 text-red-300" fill="none" stroke="currentColor" strokeWidth="2.5" viewBox="0 0 24 24">
                <path strokeLinecap="round" strokeLinejoin="round" d="M6 18L18 6M6 6l12 12" />
              </svg>
            </div>
            <p className="text-red-300 font-medium">{message}</p>
            {message.includes('already') ? (
              <p className="text-gray-500 text-sm">You can close this tab.</p>
            ) : (
              <button
                onClick={() => {
                  setStep('enter')
                  setNotRecognised(false)
                  setIdentified(null); identifiedRef.current = null
                  setFastBbox(null); fastBboxRef.current = null
                  lastGoodBlobRef.current = null
                  setCheckInCountdown(null)
                }}
                className="bg-gray-700 hover:bg-gray-600 rounded-xl px-6 py-2.5 text-sm font-medium transition-colors"
              >
                Back to Start
              </button>
            )}
          </div>
        )}

        {/* ── ENROLL FORM ── */}
        {step === 'enroll_form' && (
          <div className="bg-gray-800 border border-gray-700 rounded-2xl p-6 space-y-4">
            <div>
              <p className="text-white font-semibold text-lg">Register &amp; Check In</p>
              <p className="text-gray-400 text-sm mt-1">Enter your details, then take 3 photos to enroll.</p>
            </div>
            <input
              className="w-full bg-gray-700 rounded-lg px-4 py-3 placeholder-gray-400 focus:outline-none focus:ring-2 focus:ring-indigo-500"
              placeholder="Full Name"
              maxLength={100}
              value={enrollName}
              onChange={e => setEnrollName(e.target.value.replace(/[<>]/g, ''))}
            />
            <input
              className="w-full bg-gray-700 rounded-lg px-4 py-3 placeholder-gray-400 focus:outline-none focus:ring-2 focus:ring-indigo-500"
              placeholder="Student ID (letters, digits, - or _)"
              maxLength={50}
              value={enrollNumber}
              onChange={e => setEnrollNumber(e.target.value.replace(/[^A-Za-z0-9\-_]/g, ''))}
            />
            {enrollNumber && !/^[A-Za-z0-9\-_]{2,}$/.test(enrollNumber) && (
              <p className="text-yellow-400 text-xs -mt-2">Student ID must be at least 2 characters: letters, digits, - or _</p>
            )}
            <button
              onClick={startEnrollCamera}
              disabled={enrollName.trim().length < 2 || !/^[A-Za-z0-9\-_]{2,}$/.test(enrollNumber)}
              className="w-full bg-indigo-600 hover:bg-indigo-500 disabled:opacity-40 disabled:cursor-not-allowed rounded-xl py-3 font-semibold transition-colors"
            >
              Continue to Camera
            </button>
            <button
              onClick={() => setStep('enter')}
              className="w-full text-gray-500 hover:text-gray-300 text-sm transition-colors py-1"
            >
              Back
            </button>
          </div>
        )}

        {/* ── ENROLL CAMERA ── */}
        {step === 'enroll_camera' && (
          <div className="space-y-3">
            {/* Camera feed */}
            <div className="relative rounded-2xl overflow-hidden bg-black">
              <video
                ref={enrollVideoRef}
                autoPlay playsInline muted
                className="w-full block"
                style={{ transform: 'scaleX(-1)' }}
              />
              {/* Face guide oval */}
              <div className="absolute inset-0 flex items-center justify-center pointer-events-none">
                <div className="border-4 border-white/40 rounded-full" style={{ width: '52%', paddingTop: '68%', borderStyle: 'dashed' }} />
              </div>
              {/* Flash effect */}
              {enrollFlash && <div className="absolute inset-0 bg-white/50 pointer-events-none" />}
              {/* Countdown badge */}
              <div className="absolute top-3 right-3 w-12 h-12 rounded-full bg-black/60 flex items-center justify-center">
                <span className="text-white font-bold text-2xl">{enrollCountdown}</span>
              </div>
            </div>

            {/* Pose instruction */}
            <div className="bg-gray-800 border border-gray-700 rounded-xl px-4 py-3 text-center">
              <p className="text-white font-semibold">{ENROLL_POSES[enrollPoseStep]?.label}</p>
              <p className="text-gray-400 text-sm mt-0.5">{ENROLL_POSES[enrollPoseStep]?.sub}</p>
            </div>

            {/* Progress dots */}
            <div className="flex justify-center gap-3">
              {ENROLL_POSES.map((_, i) => (
                <div key={i} className={`w-3 h-3 rounded-full transition-all duration-300 ${
                  i < enrollPhotos.length ? 'bg-green-400 scale-110'
                    : i === enrollPoseStep ? 'bg-white animate-pulse'
                    : 'bg-gray-600'
                }`} />
              ))}
            </div>
            <p className="text-gray-500 text-xs text-center">{enrollPhotos.length} / {ENROLL_POSES.length} photos captured — hold still</p>

            <button
              onClick={() => { stopEnrollCamera(); setEnrollPhotos([]); setStep('enroll_form') }}
              className="w-full text-gray-500 hover:text-gray-300 text-sm transition-colors py-1"
            >
              Cancel
            </button>
          </div>
        )}

        {/* ── ENROLLING ── */}
        {step === 'enrolling' && (
          <div className="bg-gray-800 border border-gray-700 rounded-2xl p-10 text-center space-y-5">
            <div className="w-14 h-14 mx-auto border-4 border-indigo-500 border-t-transparent rounded-full animate-spin" />
            <div>
              <p className="text-white font-semibold">Enrolling your face…</p>
              <p className="text-gray-400 text-sm mt-1">This may take a few seconds</p>
            </div>
          </div>
        )}

      </div>
    </div>
  )
}
