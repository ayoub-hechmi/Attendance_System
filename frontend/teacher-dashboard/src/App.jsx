import { useState, useEffect, useRef, useCallback } from 'react'
import * as XLSX from 'xlsx'
import { QRCodeSVG } from 'qrcode.react'

const API = '/api/v1'
const WS_BASE = `ws://${window.location.hostname}:8000/api/v1`

const POSES = [
  { label: 'Look straight at the camera',  sub: 'Keep your face centered and still' },
  { label: 'Turn your head slightly LEFT',  sub: 'About 30° to the left' },
  { label: 'Turn your head slightly RIGHT', sub: 'About 30° to the right' },
  { label: 'Tilt your head slightly UP',    sub: 'Look a little toward the ceiling' },
  { label: 'Tilt your head slightly DOWN',  sub: 'Look a little toward the floor' },
]
const BONUS_FRAMES = 5

// ── FaceCaptureModal ──────────────────────────────────────────────────────────
function FaceCaptureModal({ onDone, onClose }) {
  const videoRef  = useRef(null)
  const canvasRef = useRef(null)
  const [phase, setPhase]         = useState('loading')
  const [step, setStep]           = useState(0)
  const [countdown, setCountdown] = useState(3)
  const [captured, setCaptured]   = useState(0)
  const [flash, setFlash]         = useState(false)
  const [bonus, setBonus]         = useState(false)

  useEffect(() => {
    let cancelled = false
    let stream
    ;(async () => {
      try {
        stream = await navigator.mediaDevices.getUserMedia({
          video: { facingMode: 'user', width: { ideal: 640 }, height: { ideal: 480 } },
        })
        if (cancelled) { stream.getTracks().forEach(t => t.stop()); return }
        const video = videoRef.current
        if (!video) { stream.getTracks().forEach(t => t.stop()); return }
        video.srcObject = stream
        await video.play()
        if (!cancelled) setPhase('capturing')
      } catch (e) {
        if (!cancelled) console.error('Camera error:', e)
      }
    })()
    return () => { cancelled = true; stream?.getTracks().forEach(t => t.stop()) }
  }, [])

  useEffect(() => {
    if (phase !== 'capturing') return
    let cancelled = false
    const sleep = ms => new Promise(r => setTimeout(r, ms))
    const blobs = []
    ;(async () => {
      for (let i = 0; i < POSES.length; i++) {
        if (cancelled) return
        setStep(i)
        for (let c = 3; c >= 1; c--) {
          if (cancelled) return
          setCountdown(c)
          await sleep(1000)
        }
        if (cancelled) return
        setFlash(true)
        setTimeout(() => setFlash(false), 250)
        const video  = videoRef.current
        const canvas = canvasRef.current
        if (!video || !canvas) continue
        canvas.width  = video.videoWidth  || 640
        canvas.height = video.videoHeight || 480
        canvas.getContext('2d').drawImage(video, 0, 0)
        const blob = await new Promise(r => canvas.toBlob(r, 'image/jpeg', 0.92))
        blobs.push(blob)
        setCaptured(blobs.length)
        await sleep(500)
      }

      // Bonus frames — silent captures after the guided poses
      if (!cancelled && blobs.length > 0) {
        setBonus(true)
        for (let b = 0; b < BONUS_FRAMES; b++) {
          if (cancelled) return
          const video  = videoRef.current
          const canvas = canvasRef.current
          if (video && canvas) {
            canvas.width  = video.videoWidth  || 640
            canvas.height = video.videoHeight || 480
            canvas.getContext('2d').drawImage(video, 0, 0)
            setFlash(true)
            setTimeout(() => setFlash(false), 120)
            const blob = await new Promise(r => canvas.toBlob(r, 'image/jpeg', 0.92))
            blobs.push(blob)
            setCaptured(blobs.length)
          }
          await sleep(400)
        }
        setBonus(false)
      }

      if (!cancelled) { setPhase('done'); onDone(blobs) }
    })()
    return () => { cancelled = true }
  }, [phase]) // eslint-disable-line

  return (
    <div className="fixed inset-0 bg-black/80 flex items-center justify-center z-50 p-4">
      <div className="bg-gray-900 border border-gray-700 rounded-2xl w-full max-w-md overflow-hidden shadow-2xl">
        <div className="flex items-center justify-between px-5 py-4 border-b border-gray-800">
          <h3 className="font-semibold text-white">Face Enrollment</h3>
          <button onClick={onClose} className="text-gray-400 hover:text-white text-xl leading-none">✕</button>
        </div>
        <div className="relative bg-black" style={{ aspectRatio: '4/3' }}>
          <video ref={videoRef} className="w-full h-full object-cover" style={{ transform: 'scaleX(-1)' }} muted playsInline />
          <canvas ref={canvasRef} className="hidden" />
          {phase === 'loading' && (
            <div className="absolute inset-0 flex items-center justify-center text-gray-400 text-sm">Starting camera…</div>
          )}
          {phase === 'capturing' && (
            <>
              <div className="absolute inset-0 flex items-center justify-center pointer-events-none">
                <div className="border-4 border-white/50 rounded-full" style={{ width: '52%', paddingTop: '68%', borderStyle: 'dashed' }} />
              </div>
              {countdown > 0 && (
                <div className="absolute top-3 right-3 w-11 h-11 rounded-full bg-black/60 flex items-center justify-center">
                  <span className="text-white font-bold text-xl">{countdown}</span>
                </div>
              )}
              {flash && <div className="absolute inset-0 bg-white/40 pointer-events-none" />}
            </>
          )}
          {phase === 'done' && (
            <div className="absolute inset-0 bg-green-900/70 flex items-center justify-center">
              <div className="text-center text-white"><div className="text-6xl mb-2">✓</div><p className="font-semibold text-lg">All photos captured!</p></div>
            </div>
          )}
        </div>
        <div className="px-5 py-5 space-y-4">
          {phase === 'loading' && <p className="text-gray-400 text-sm text-center">Allow camera access to begin enrollment.</p>}
          {phase === 'capturing' && (
            <>
              <div className="text-center">
                {bonus ? (
                  <>
                    <p className="text-white font-semibold text-base">Hold still for a moment</p>
                    <p className="text-gray-400 text-sm mt-0.5">Getting a few extra angles…</p>
                  </>
                ) : (
                  <>
                    <p className="text-white font-semibold text-base">{POSES[step].label}</p>
                    <p className="text-gray-400 text-sm mt-0.5">{POSES[step].sub}</p>
                  </>
                )}
              </div>
              <div className="flex justify-center gap-3">
                {POSES.map((_, i) => (
                  <div key={i} className={`w-3 h-3 rounded-full transition-all duration-300 ${
                    i < Math.min(captured, POSES.length) ? 'bg-green-400 scale-110'
                      : i === step && !bonus ? 'bg-white animate-pulse'
                      : 'bg-gray-600'
                  }`} />
                ))}
              </div>
              <p className="text-gray-500 text-xs text-center">{captured} / {POSES.length + BONUS_FRAMES} photos captured</p>
            </>
          )}
          {phase === 'done' && <p className="text-green-400 text-sm text-center font-medium">Uploading to the system…</p>}
        </div>
      </div>
    </div>
  )
}

// ── QR Modal ──────────────────────────────────────────────────────────────────
function QRModal({ link, onClose }) {
  return (
    <div className="fixed inset-0 bg-black/80 flex items-center justify-center z-50 p-4" onClick={onClose}>
      <div className="bg-gray-900 border border-gray-700 rounded-2xl p-8 flex flex-col items-center gap-5 shadow-2xl" onClick={e => e.stopPropagation()}>
        <h3 className="font-semibold text-white text-lg">Scan to Check In</h3>
        <div className="bg-white p-4 rounded-xl">
          <QRCodeSVG value={link} size={220} />
        </div>
        <p className="text-gray-400 text-xs text-center max-w-xs break-all">{link}</p>
        <button onClick={onClose} className="bg-gray-700 hover:bg-gray-600 rounded-xl px-6 py-2 text-sm font-medium transition">Close</button>
      </div>
    </div>
  )
}

// ── Main App ──────────────────────────────────────────────────────────────────
export default function App() {
  const [token, setToken]       = useState(localStorage.getItem('token') || '')
  const [email, setEmail]       = useState('')
  const [password, setPassword] = useState('')
  const [loginError, setLoginError] = useState('')
  const [tab, setTab] = useState('session')

  // Registration
  const [isRegistering, setIsRegistering] = useState(false)
  const [regName, setRegName]             = useState('')
  const [regEmail, setRegEmail]           = useState('')
  const [regPassword, setRegPassword]     = useState('')
  const [regError, setRegError]           = useState('')
  const [regLoading, setRegLoading]       = useState(false)

  // Queue depth (system health)
  const [queueDepth, setQueueDepth]       = useState(null)

  // Server IP for share links (fetched once — localhost is wrong for student devices)
  const [serverIp, setServerIp] = useState(window.location.hostname)

  useEffect(() => {
    fetch('/api/v1/server-ip')
      .then(r => r.json())
      .then(d => { if (d.ip && d.ip !== 'localhost') setServerIp(d.ip) })
      .catch(() => {})
  }, [])

  // Class management
  const [classes, setClasses]                 = useState([])
  const [selectedClass, setSelectedClass]     = useState(null)
  const [showCreateClass, setShowCreateClass] = useState(false)
  const [newClassName, setNewClassName]       = useState('')

  // Session state
  const [windowId, setWindowId]   = useState(null)
  const [closesAt, setClosesAt]   = useState(null)
  const [timeLeft, setTimeLeft]   = useState(0)
  const [roster, setRoster]       = useState([])
  const [opening, setOpening]     = useState(false)
  const [sessionDuration, setSessionDuration] = useState(10)
  const [showQR, setShowQR]       = useState(false)
  const [lastRoster, setLastRoster] = useState([])
  const wsRef          = useRef(null)
  const wsReconnectRef = useRef(null)
  const wsRetriesRef   = useRef(0)

  // History
  const [history, setHistory]           = useState([])
  const [historyLoading, setHistoryLoading] = useState(false)

  // Students state
  const [students, setStudents]               = useState([])
  const [studentsLoading, setStudentsLoading] = useState(false)
  const [addMode, setAddMode]                 = useState('new')   // 'new' | 'search'
  const [addForm, setAddForm]                 = useState({ name: '', student_number: '' })
  const [showCapture, setShowCapture]         = useState(false)
  const [capturedBlobs, setCapturedBlobs]     = useState([])
  const [enrollMode, setEnrollMode]           = useState('camera')
  const fileInputRef                          = useRef(null)
  const [addStep, setAddStep]                 = useState('idle')
  const [uploadProgress, setUploadProgress]   = useState({ done: 0, total: 0 })
  const [addError, setAddError]               = useState('')
  const [addedStudent, setAddedStudent]       = useState(null)
  const [confirmDeleteId, setConfirmDeleteId] = useState(null)
  const [deleting, setDeleting]               = useState(false)
  const [editingStudent, setEditingStudent]   = useState(null) // { id, name, student_number }
  const [editSaving, setEditSaving]           = useState(false)

  // Student search (for "add existing")
  const [searchQuery, setSearchQuery]     = useState('')
  const [searchResults, setSearchResults] = useState([])
  const [searchLoading, setSearchLoading] = useState(false)
  const searchTimerRef = useRef(null)

  // Add-photos-to-existing-student
  const [addingPhotosFor, setAddingPhotosFor]     = useState(null)
  const [addPhotosBlobs, setAddPhotosBlobs]       = useState([])
  const [addPhotosMode, setAddPhotosMode]         = useState('camera')
  const [addPhotosStep, setAddPhotosStep]         = useState('idle')
  const [addPhotosProgress, setAddPhotosProgress] = useState({ done: 0, total: 0 })
  const [showAddCapture, setShowAddCapture]       = useState(false)
  const addPhotosFileRef = useRef(null)

  const auth = { Authorization: `Bearer ${token}` }

  // ── Auth ───────────────────────────────────────────────────────────────────
  async function login() {
    setLoginError('')
    const form = new FormData()
    form.append('username', email)
    form.append('password', password)
    const res  = await fetch(`${API}/auth/token`, { method: 'POST', body: form })
    const data = await res.json()
    if (res.ok) {
      localStorage.setItem('token', data.access_token)
      setToken(data.access_token)
    } else {
      setLoginError('Invalid email or password')
    }
  }

  function logout() {
    localStorage.removeItem('token')
    setToken('')
    wsRef.current?.close()
    clearTimeout(wsReconnectRef.current)
    setSelectedClass(null)
    setClasses([])
  }

  async function register() {
    setRegError('')
    if (!regName.trim() || !regEmail.trim() || !regPassword) {
      setRegError('All fields are required.')
      return
    }
    if (regPassword.length < 8) {
      setRegError('Password must be at least 8 characters.')
      return
    }
    setRegLoading(true)
    const res = await fetch(`${API}/auth/register`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ name: regName.trim(), email: regEmail.trim(), password: regPassword }),
    })
    const data = await res.json()
    setRegLoading(false)
    if (res.ok) {
      // Auto-login after registration
      const form = new FormData()
      form.append('username', regEmail.trim())
      form.append('password', regPassword)
      const loginRes = await fetch(`${API}/auth/token`, { method: 'POST', body: form })
      const loginData = await loginRes.json()
      if (loginRes.ok) {
        localStorage.setItem('token', loginData.access_token)
        setToken(loginData.access_token)
      } else {
        setIsRegistering(false)
        setEmail(regEmail.trim())
      }
    } else {
      setRegError(data.detail || 'Registration failed.')
    }
  }

  // ── Queue depth poll ───────────────────────────────────────────────────────
  useEffect(() => {
    if (!token) return
    const poll = async () => {
      try {
        const res = await fetch(`${API}/attendance/queue-depth`, { headers: auth })
        if (res.ok) { const d = await res.json(); setQueueDepth(d.depth) }
      } catch {}
    }
    poll()
    const id = setInterval(poll, 30_000)
    return () => clearInterval(id)
  }, [token]) // eslint-disable-line

  // ── Classes ────────────────────────────────────────────────────────────────
  async function fetchClasses() {
    const res = await fetch(`${API}/enrollment/classes`, { headers: auth })
    if (res.ok) {
      const data = await res.json()
      setClasses(data)
      if (data.length === 1 && !selectedClass) {
        setSelectedClass(data[0])
      }
    }
  }

  useEffect(() => {
    if (token) fetchClasses()
  }, [token]) // eslint-disable-line

  async function createClass() {
    if (!newClassName.trim()) return
    const res  = await fetch(`${API}/enrollment/classes`, {
      method: 'POST',
      headers: { ...auth, 'Content-Type': 'application/json' },
      body: JSON.stringify({ name: newClassName.trim() }),
    })
    if (res.ok) {
      const cls = await res.json()
      setClasses(prev => [...prev, cls])
      setSelectedClass(cls)
      setNewClassName('')
      setShowCreateClass(false)
    }
  }

  // ── WebSocket ──────────────────────────────────────────────────────────────
  const connectWs = useCallback((cid) => {
    clearTimeout(wsReconnectRef.current)
    wsRef.current?.close()
    const ws = new WebSocket(`${WS_BASE}/attendance/ws/${cid}`)
    ws.onmessage = (e) => {
      const msg = JSON.parse(e.data)
      if (msg.event === 'student_present') {
        setRoster(prev => prev.map(s =>
          s.student_number === msg.student_number
            ? { ...s, status: 'present', scanned_at: msg.scanned_at }
            : s
        ))
      }
      if (msg.event === 'window_opened') {
        setWindowId(msg.window_id)
        setClosesAt(new Date(msg.closes_at))
      }
      if (msg.event === 'window_closed') setWindowId(null)
    }
    ws.onopen  = () => { wsRetriesRef.current = 0 }
    ws.onclose = () => {
      if (wsRetriesRef.current < 10) {
        wsRetriesRef.current += 1
        wsReconnectRef.current = setTimeout(() => connectWs(cid), 3000)
      }
    }
    ws.onerror = () => ws.close()
    wsRef.current = ws
  }, [])

  useEffect(() => {
    if (!token || !selectedClass) return
    connectWs(selectedClass.id)
    return () => { wsRef.current?.close(); clearTimeout(wsReconnectRef.current) }
  }, [token, selectedClass, connectWs])

  // ── Roster polling ─────────────────────────────────────────────────────────
  useEffect(() => {
    if (!windowId || !token) return
    const id = setInterval(() => fetchRoster(windowId), 10000)
    return () => clearInterval(id)
  }, [windowId, token])

  // ── Countdown ──────────────────────────────────────────────────────────────
  useEffect(() => {
    if (!closesAt) return
    const id = setInterval(() => {
      const secs = Math.max(0, Math.round((new Date(closesAt) - Date.now()) / 1000))
      setTimeLeft(secs)
      if (secs === 0) { setWindowId(null); clearInterval(id) }
    }, 1000)
    return () => clearInterval(id)
  }, [closesAt])

  // ── Restore active window on load/class-switch ────────────────────────────
  async function restoreActiveWindow(classId) {
    try {
      const res = await fetch(`${API}/attendance/history?class_id=${classId}`, { headers: auth })
      if (!res.ok) return
      const sessions = await res.json()
      const active = sessions.find(s => s.is_open && new Date(s.closes_at) > new Date())
      if (active) {
        setWindowId(active.id)
        setClosesAt(new Date(active.closes_at))
        await fetchRoster(active.id)
      }
    } catch {}
  }

  useEffect(() => {
    if (!token || !selectedClass) return
    restoreActiveWindow(selectedClass.id)
  }, [token, selectedClass]) // eslint-disable-line

  // ── Session actions ────────────────────────────────────────────────────────
  async function openWindow() {
    if (!selectedClass) return
    setOpening(true)
    const res = await fetch(
      `${API}/attendance/window/open?class_id=${selectedClass.id}&duration_minutes=${sessionDuration}`,
      { method: 'POST', headers: auth }
    )
    const data = await res.json()
    if (res.ok) {
      setWindowId(data.window_id)
      setClosesAt(new Date(data.closes_at))
      await fetchRoster(data.window_id)
    }
    setOpening(false)
  }

  async function closeWindow() {
    if (!windowId) return
    await fetch(`${API}/attendance/window/${windowId}/close`, { method: 'POST', headers: auth })
    setWindowId(null)
    setRoster([])
  }

  async function reopenWindow(wid, extraMinutes = 5) {
    const res = await fetch(
      `${API}/attendance/window/${wid}/reopen?extra_minutes=${extraMinutes}`,
      { method: 'POST', headers: auth }
    )
    if (res.ok) {
      const data = await res.json()
      setWindowId(data.window_id)
      setClosesAt(new Date(data.closes_at))
      await fetchRoster(data.window_id)
      setTab('session')
    }
  }

  async function fetchRoster(wid) {
    try {
      const res  = await fetch(`${API}/attendance/window/${wid}/roster`, { headers: auth })
      const data = await res.json()
      if (res.ok) {
        setRoster(data.roster ?? [])
        setLastRoster(data.roster ?? [])
      }
    } catch (err) {
      console.error('Roster fetch error:', err)
    }
  }

  async function markPresent(studentId) {
    if (!windowId) return
    const res = await fetch(`${API}/attendance/window/${windowId}/mark/${studentId}`, {
      method: 'POST', headers: auth,
    })
    if (res.ok) {
      setRoster(prev => prev.map(s =>
        s.id === studentId ? { ...s, status: 'present', scanned_at: new Date().toISOString() } : s
      ))
    }
  }

  function downloadAttendance(rosterData, sessionInfo) {
    const list = rosterData || (lastRoster.length > 0 ? lastRoster : roster)
    if (list.length === 0) return

    const className = sessionInfo?.className || selectedClass?.name || 'Class'
    const date      = sessionInfo?.date || new Date().toISOString().slice(0, 10)
    const now       = new Date()
    const time      = sessionInfo?.time ||
      `${String(now.getHours()).padStart(2,'0')}:${String(now.getMinutes()).padStart(2,'0')}`

    const presentCount = list.filter(s => s.status === 'present').length
    const sheetData = [
      [className, '', '', ''],
      [`Date: ${date}`, `Time: ${time}`, '', ''],
      [`Present: ${presentCount} / ${list.length}`, '', '', ''],
      [],
      ['Name', 'Student Number', 'Status', 'Check-in Time'],
      ...list.map(s => [
        s.name,
        s.student_number,
        s.status === 'present' ? 'Present' : 'Absent',
        s.scanned_at
          ? new Date(s.scanned_at).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit', second: '2-digit' })
          : '',
      ]),
    ]

    const ws = XLSX.utils.aoa_to_sheet(sheetData)
    ws['!cols'] = [{ wch: 28 }, { wch: 18 }, { wch: 10 }, { wch: 14 }]
    const wb = XLSX.utils.book_new()
    XLSX.utils.book_append_sheet(wb, ws, 'Attendance')
    const safeClass = className.replace(/[^\w\s-]/g, '').trim().replace(/\s+/g, '_')
    const safeTime  = time.replace(':', '-')
    XLSX.writeFile(wb, `${safeClass}_${date}_${safeTime}.xlsx`)
  }

  // ── History ────────────────────────────────────────────────────────────────
  async function fetchHistory() {
    if (!selectedClass) return
    setHistoryLoading(true)
    const res = await fetch(`${API}/attendance/history?class_id=${selectedClass.id}`, { headers: auth })
    if (res.ok) setHistory(await res.json())
    setHistoryLoading(false)
  }

  async function downloadHistorySession(sessionId, date, time, className) {
    const res  = await fetch(`${API}/attendance/window/${sessionId}/roster`, { headers: auth })
    const data = await res.json()
    if (res.ok) downloadAttendance(data.roster, { date, time, className })
  }

  useEffect(() => {
    if (token && tab === 'history' && selectedClass) fetchHistory()
  }, [token, tab, selectedClass]) // eslint-disable-line

  // ── Students ───────────────────────────────────────────────────────────────
  async function fetchStudents() {
    if (!selectedClass) return
    setStudentsLoading(true)
    const res = await fetch(`${API}/enrollment/students?class_id=${selectedClass.id}`, { headers: auth })
    if (res.ok) setStudents(await res.json())
    setStudentsLoading(false)
  }

  useEffect(() => {
    if (token && tab === 'students' && selectedClass) fetchStudents()
  }, [token, tab, selectedClass]) // eslint-disable-line

  // Student search (debounced)
  useEffect(() => {
    clearTimeout(searchTimerRef.current)
    if (!searchQuery.trim()) { setSearchResults([]); return }
    searchTimerRef.current = setTimeout(async () => {
      setSearchLoading(true)
      const res = await fetch(`${API}/enrollment/students/search?q=${encodeURIComponent(searchQuery)}`, { headers: auth })
      if (res.ok) setSearchResults(await res.json())
      setSearchLoading(false)
    }, 300)
  }, [searchQuery]) // eslint-disable-line

  async function addExistingToClass(student) {
    if (!selectedClass) return
    const res = await fetch(`${API}/enrollment/classes/${selectedClass.id}/students/${student.id}`, {
      method: 'POST', headers: auth,
    })
    if (res.ok) {
      setSearchQuery('')
      setSearchResults([])
      fetchStudents()
    }
  }

  async function removeFromClass(studentId) {
    if (!selectedClass) return
    const res = await fetch(`${API}/enrollment/classes/${selectedClass.id}/students/${studentId}`, {
      method: 'DELETE', headers: auth,
    })
    setConfirmDeleteId(null)
    if (res.ok || res.status === 204) {
      setStudents(prev => prev.filter(s => s.id !== studentId))
    }
  }

  async function saveEdit() {
    if (!editingStudent) return
    setEditSaving(true)
    const res = await fetch(`${API}/enrollment/students/${editingStudent.id}`, {
      method: 'PUT',
      headers: { ...auth, 'Content-Type': 'application/json' },
      body: JSON.stringify({ name: editingStudent.name, student_number: editingStudent.student_number }),
    })
    if (res.ok) {
      const updated = await res.json()
      setStudents(prev => prev.map(s => s.id === updated.id ? { ...s, ...updated } : s))
      setEditingStudent(null)
    }
    setEditSaving(false)
  }

  function handleCapturedBlobs(blobs) {
    setCapturedBlobs(blobs)
    setShowCapture(false)
  }

  function handleFileSelect(e) {
    const files = Array.from(e.target.files)
    if (files.length > 0) setCapturedBlobs(files)
    e.target.value = ''
  }

  function handleAddPhotosFileSelect(e) {
    const files = Array.from(e.target.files)
    if (files.length > 0) setAddPhotosBlobs(files)
    e.target.value = ''
  }

  function openAddPhotos(student) {
    setAddingPhotosFor(student)
    setAddPhotosBlobs([])
    setAddPhotosMode('camera')
    setAddPhotosStep('idle')
  }

  function closeAddPhotos() {
    setAddingPhotosFor(null)
    setAddPhotosBlobs([])
    setAddPhotosStep('idle')
  }

  async function uploadExtraPhotos() {
    if (!addingPhotosFor || addPhotosBlobs.length === 0) return
    setAddPhotosStep('uploading')
    setAddPhotosProgress({ done: 0, total: addPhotosBlobs.length })
    for (let i = 0; i < addPhotosBlobs.length; i++) {
      const form = new FormData()
      form.append('photo', addPhotosBlobs[i], 'face.jpg')
      await fetch(`${API}/enrollment/students/${addingPhotosFor.id}/face`, {
        method: 'POST', headers: auth, body: form,
      })
      setAddPhotosProgress({ done: i + 1, total: addPhotosBlobs.length })
    }
    setAddPhotosStep('done')
    fetchStudents()
  }

  async function addStudent(e) {
    e.preventDefault()
    setAddError('')
    if (capturedBlobs.length === 0) { setAddError('Please capture the student\'s face first.'); return }
    if (!selectedClass) { setAddError('Please select a class first.'); return }
    setAddStep('saving')
    const res1 = await fetch(`${API}/enrollment/students`, {
      method: 'POST',
      headers: { ...auth, 'Content-Type': 'application/json' },
      body: JSON.stringify({ ...addForm, class_id: selectedClass.id }),
    })
    if (!res1.ok) {
      setAddError((await res1.json()).detail || 'Failed to create student')
      setAddStep('error')
      return
    }
    const student = await res1.json()
    setAddStep('uploading')
    setUploadProgress({ done: 0, total: capturedBlobs.length })
    for (let i = 0; i < capturedBlobs.length; i++) {
      const form = new FormData()
      form.append('photo', capturedBlobs[i], 'face.jpg')
      await fetch(`${API}/enrollment/students/${student.id}/face`, {
        method: 'POST', headers: auth, body: form,
      })
      setUploadProgress({ done: i + 1, total: capturedBlobs.length })
    }
    setAddedStudent(student)
    setAddStep('done')
    setCapturedBlobs([])
    setAddForm({ name: '', student_number: '' })
    fetchStudents()
  }

  function resetAddForm() {
    setAddStep('idle')
    setAddError('')
    setAddedStudent(null)
    setCapturedBlobs([])
    setAddForm({ name: '', student_number: '' })
    setEnrollMode('camera')
  }

  async function deleteStudent(id) {
    setDeleting(true)
    const res = await fetch(`${API}/enrollment/students/${id}`, { method: 'DELETE', headers: auth })
    setDeleting(false)
    setConfirmDeleteId(null)
    if (res.ok || res.status === 204) setStudents(prev => prev.filter(s => s.id !== id))
  }

  // ── Derived ────────────────────────────────────────────────────────────────
  const presentCount = roster.filter(s => s.status === 'present').length
  const absentCount  = roster.length - presentCount
  const mins = String(Math.floor(timeLeft / 60)).padStart(2, '0')
  const secs = String(timeLeft % 60).padStart(2, '0')
  const shareLink = `https://${serverIp}:5173/?window=${windowId}`

  // ── Login / Register ───────────────────────────────────────────────────────
  if (!token) return (
    <div className="min-h-screen bg-gray-950 flex items-center justify-center p-4">
      <div className="bg-gray-900 border border-gray-800 rounded-2xl p-8 w-full max-w-sm space-y-4 shadow-2xl">
        <div className="text-center mb-2">
          <div className="text-3xl mb-1">🎓</div>
          <h1 className="text-xl font-bold text-white">Teacher Portal</h1>
          <p className="text-gray-400 text-sm mt-1">
            {isRegistering ? 'Create a teacher account' : 'Sign in to manage attendance'}
          </p>
        </div>

        {isRegistering ? (
          <>
            {regError && (
              <div className="bg-red-900/40 border border-red-700 rounded-lg px-4 py-2 text-red-300 text-sm">{regError}</div>
            )}
            <input
              className="w-full bg-gray-800 border border-gray-700 rounded-lg px-4 py-3 text-white placeholder-gray-500 focus:outline-none focus:ring-2 focus:ring-indigo-500"
              placeholder="Full Name" value={regName} onChange={e => setRegName(e.target.value)}
              onKeyDown={e => e.key === 'Enter' && register()}
            />
            <input
              className="w-full bg-gray-800 border border-gray-700 rounded-lg px-4 py-3 text-white placeholder-gray-500 focus:outline-none focus:ring-2 focus:ring-indigo-500"
              placeholder="Email" value={regEmail} onChange={e => setRegEmail(e.target.value)}
              onKeyDown={e => e.key === 'Enter' && register()}
            />
            <input
              className="w-full bg-gray-800 border border-gray-700 rounded-lg px-4 py-3 text-white placeholder-gray-500 focus:outline-none focus:ring-2 focus:ring-indigo-500"
              type="password" placeholder="Password (min 8 chars)" value={regPassword}
              onChange={e => setRegPassword(e.target.value)}
              onKeyDown={e => e.key === 'Enter' && register()}
            />
            <button
              onClick={register}
              disabled={regLoading}
              className="w-full bg-indigo-600 hover:bg-indigo-500 disabled:opacity-50 rounded-lg py-3 font-semibold text-white transition"
            >
              {regLoading ? 'Creating account…' : 'Create Account'}
            </button>
            <button
              onClick={() => { setIsRegistering(false); setRegError('') }}
              className="w-full text-gray-500 hover:text-gray-300 text-sm text-center transition py-1"
            >
              Back to Sign In
            </button>
          </>
        ) : (
          <>
            {loginError && (
              <div className="bg-red-900/40 border border-red-700 rounded-lg px-4 py-2 text-red-300 text-sm">{loginError}</div>
            )}
            <input
              className="w-full bg-gray-800 border border-gray-700 rounded-lg px-4 py-3 text-white placeholder-gray-500 focus:outline-none focus:ring-2 focus:ring-indigo-500"
              placeholder="Email" value={email} onChange={e => setEmail(e.target.value)}
              onKeyDown={e => e.key === 'Enter' && login()}
            />
            <input
              className="w-full bg-gray-800 border border-gray-700 rounded-lg px-4 py-3 text-white placeholder-gray-500 focus:outline-none focus:ring-2 focus:ring-indigo-500"
              type="password" placeholder="Password" value={password}
              onChange={e => setPassword(e.target.value)}
              onKeyDown={e => e.key === 'Enter' && login()}
            />
            <button onClick={login} className="w-full bg-indigo-600 hover:bg-indigo-500 rounded-lg py-3 font-semibold text-white transition">
              Sign In
            </button>
            <button
              onClick={() => { setIsRegistering(true); setLoginError('') }}
              className="w-full text-gray-500 hover:text-gray-300 text-sm text-center transition py-1"
            >
              Create an account
            </button>
          </>
        )}
      </div>
    </div>
  )

  // ── Dashboard ──────────────────────────────────────────────────────────────
  return (
    <div className="min-h-screen bg-gray-950 text-white">
      {showCapture && <FaceCaptureModal onDone={handleCapturedBlobs} onClose={() => setShowCapture(false)} />}
      {showAddCapture && (
        <FaceCaptureModal
          onDone={blobs => { setAddPhotosBlobs(blobs); setShowAddCapture(false) }}
          onClose={() => setShowAddCapture(false)}
        />
      )}
      {showQR && windowId && <QRModal link={shareLink} onClose={() => setShowQR(false)} />}
      <input ref={addPhotosFileRef} type="file" accept="image/*" multiple className="hidden" onChange={handleAddPhotosFileSelect} />

      {/* Top bar */}
      <div className="bg-gray-900 border-b border-gray-800 px-6 py-3 flex items-center gap-3">
        <h1 className="font-bold text-indigo-400 text-lg mr-auto">Attendance Dashboard</h1>
        {queueDepth > 5 && (
          <span className="text-xs bg-yellow-900/60 border border-yellow-700 text-yellow-300 rounded-lg px-2 py-1">
            Queue backed up ({queueDepth} tasks)
          </span>
        )}

        {/* Class selector */}
        {classes.length > 0 && (
          <div className="flex items-center gap-2">
            <select
              value={selectedClass?.id || ''}
              onChange={e => {
                const cls = classes.find(c => c.id === Number(e.target.value))
                setSelectedClass(cls || null)
                setWindowId(null); setRoster([]); setStudents([])
              }}
              className="bg-gray-800 border border-gray-700 rounded-lg px-3 py-1.5 text-sm text-white focus:outline-none focus:ring-2 focus:ring-indigo-500"
            >
              {!selectedClass && <option value="">— Select class —</option>}
              {classes.map(c => <option key={c.id} value={c.id}>{c.name}</option>)}
            </select>
          </div>
        )}

        {/* Create class */}
        {showCreateClass ? (
          <div className="flex items-center gap-2">
            <input
              autoFocus
              className="bg-gray-800 border border-gray-700 rounded-lg px-3 py-1.5 text-sm text-white w-40 focus:outline-none focus:ring-2 focus:ring-indigo-500"
              placeholder="Class name"
              value={newClassName}
              onChange={e => setNewClassName(e.target.value)}
              onKeyDown={e => { if (e.key === 'Enter') createClass(); if (e.key === 'Escape') setShowCreateClass(false) }}
            />
            <button onClick={createClass} className="bg-indigo-600 hover:bg-indigo-500 rounded-lg px-3 py-1.5 text-xs font-medium transition">Create</button>
            <button onClick={() => setShowCreateClass(false)} className="text-gray-500 hover:text-white text-xs">✕</button>
          </div>
        ) : (
          <button onClick={() => setShowCreateClass(true)} className="text-gray-400 hover:text-white text-sm transition">
            + New Class
          </button>
        )}

        <button onClick={logout} className="text-gray-400 hover:text-white text-sm transition">Sign out</button>
      </div>

      {/* Class required banner */}
      {!selectedClass && (
        <div className="flex flex-col items-center justify-center py-20 gap-4">
          <p className="text-gray-400 text-lg">Select or create a class to get started.</p>
          {classes.length === 0 && (
            <button
              onClick={() => setShowCreateClass(true)}
              className="bg-indigo-600 hover:bg-indigo-500 rounded-xl px-6 py-3 font-semibold transition"
            >
              Create First Class
            </button>
          )}
        </div>
      )}

      {selectedClass && (
        <>
          {/* Tabs */}
          <div className="border-b border-gray-800 px-6">
            <div className="flex gap-6">
              {[['session', 'Session'], ['students', 'Students'], ['history', 'History']].map(([key, label]) => (
                <button
                  key={key}
                  onClick={() => setTab(key)}
                  className={`py-3 text-sm font-medium border-b-2 transition ${
                    tab === key ? 'border-indigo-500 text-indigo-400' : 'border-transparent text-gray-400 hover:text-white'
                  }`}
                >
                  {label}
                </button>
              ))}
            </div>
          </div>

          <div className="p-6 max-w-6xl mx-auto">

            {/* ── SESSION TAB ── */}
            {tab === 'session' && (
              <div className="space-y-6">
                {!windowId ? (
                  <div className="flex flex-col items-center justify-center py-16 space-y-6">
                    <p className="text-gray-400 text-lg">No active attendance session</p>

                    {/* Duration picker */}
                    <div className="bg-gray-900 border border-gray-800 rounded-2xl p-5 space-y-3 w-full max-w-sm">
                      <label className="block text-gray-400 text-sm text-center">Session duration</label>
                      <div className="flex gap-2 justify-center flex-wrap">
                        {[5, 10, 15, 20, 30].map(d => (
                          <button
                            key={d}
                            onClick={() => setSessionDuration(d)}
                            className={`px-4 py-2 rounded-lg text-sm font-medium transition ${
                              sessionDuration === d
                                ? 'bg-indigo-600 text-white'
                                : 'bg-gray-800 text-gray-300 hover:bg-gray-700'
                            }`}
                          >
                            {d} min
                          </button>
                        ))}
                        <div className="flex items-center gap-1">
                          <input
                            type="number"
                            min="1"
                            max="120"
                            value={sessionDuration}
                            onChange={e => setSessionDuration(Number(e.target.value))}
                            className="w-16 bg-gray-800 border border-gray-700 rounded-lg px-2 py-2 text-sm text-center text-white focus:outline-none focus:ring-2 focus:ring-indigo-500"
                          />
                          <span className="text-gray-500 text-sm">min</span>
                        </div>
                      </div>
                    </div>

                    <button
                      onClick={openWindow}
                      disabled={opening}
                      className="bg-green-600 hover:bg-green-500 disabled:opacity-50 rounded-xl px-8 py-4 font-semibold text-lg transition shadow-lg shadow-green-900/30"
                    >
                      {opening ? 'Opening…' : `▶ Start Attendance (${sessionDuration} min)`}
                    </button>
                    {lastRoster.length > 0 && (
                      <button
                        onClick={() => downloadAttendance(null, { className: selectedClass?.name })}
                        className="bg-gray-700 hover:bg-gray-600 rounded-xl px-6 py-3 text-sm font-medium transition flex items-center gap-2"
                      >
                        ⬇ Download Last Session ({lastRoster.filter(s => s.status === 'present').length}/{lastRoster.length} present)
                      </button>
                    )}
                  </div>
                ) : (
                  <>
                    {/* Session header */}
                    <div className="bg-gray-900 border border-gray-800 rounded-2xl p-4 space-y-3">
                      <div className="flex flex-wrap items-center gap-4">
                        <div className={`font-mono text-3xl font-bold px-4 py-2 rounded-xl ${
                          timeLeft <= 30 ? 'text-red-400 bg-red-900/20' : 'text-yellow-400 bg-yellow-900/20'
                        }`}>
                          {mins}:{secs}
                        </div>
                        <div className="flex-1 min-w-0">
                          <p className="text-gray-400 text-xs mb-1">Share with students:</p>
                          <div className="flex items-center gap-2">
                            <code className="text-indigo-300 text-sm bg-gray-800 px-3 py-1.5 rounded-lg truncate block flex-1">
                              {shareLink}
                            </code>
                            <button
                              onClick={() => navigator.clipboard?.writeText(shareLink)}
                              className="text-gray-400 hover:text-white text-xs bg-gray-800 px-3 py-1.5 rounded-lg transition flex-shrink-0"
                            >
                              Copy
                            </button>
                            <button
                              onClick={() => setShowQR(true)}
                              className="text-gray-400 hover:text-white text-xs bg-gray-800 px-3 py-1.5 rounded-lg transition flex-shrink-0"
                            >
                              QR
                            </button>
                          </div>
                        </div>
                        <div className="flex gap-2 flex-shrink-0">
                          <button
                            onClick={() => downloadAttendance(null, { className: selectedClass?.name })}
                            disabled={roster.length === 0}
                            className="bg-gray-700 hover:bg-gray-600 disabled:opacity-40 rounded-xl px-4 py-2 text-sm font-medium transition"
                          >
                            ⬇ Download
                          </button>
                          <button
                            onClick={closeWindow}
                            className="bg-red-800 hover:bg-red-700 rounded-xl px-4 py-2 text-sm font-medium transition"
                          >
                            Close Session
                          </button>
                        </div>
                      </div>

                      {/* Progress bar */}
                      {roster.length > 0 && (
                        <div className="space-y-1">
                          <div className="flex justify-between text-xs text-gray-400">
                            <span>{presentCount} checked in</span>
                            <span>{roster.length} total</span>
                          </div>
                          <div className="w-full bg-gray-800 rounded-full h-3 overflow-hidden">
                            <div
                              className="bg-green-500 h-3 rounded-full transition-all duration-700"
                              style={{ width: `${(presentCount / roster.length) * 100}%` }}
                            />
                          </div>
                        </div>
                      )}
                    </div>

                    {/* Stats row */}
                    <div className="grid grid-cols-3 gap-4">
                      <div className="bg-green-900/30 border border-green-800/50 rounded-2xl p-4 text-center">
                        <div className="text-4xl font-bold text-green-400">{presentCount}</div>
                        <div className="text-green-300/70 text-sm mt-1">Present</div>
                      </div>
                      <div className="bg-gray-800/50 border border-gray-700/50 rounded-2xl p-4 text-center">
                        <div className="text-4xl font-bold text-gray-300">{absentCount}</div>
                        <div className="text-gray-400 text-sm mt-1">Absent</div>
                      </div>
                      <div className="bg-gray-800/50 border border-gray-700/50 rounded-2xl p-4 text-center">
                        <div className="text-4xl font-bold text-gray-300">{roster.length}</div>
                        <div className="text-gray-400 text-sm mt-1">Total</div>
                      </div>
                    </div>

                    {/* Roster grid */}
                    {roster.length === 0 ? (
                      <p className="text-gray-500 text-center py-8">No students enrolled in this class yet.</p>
                    ) : (
                      <div className="grid grid-cols-3 sm:grid-cols-4 md:grid-cols-6 lg:grid-cols-8 gap-2">
                        {roster.map(s => (
                          <div
                            key={s.id}
                            className={`rounded-xl p-3 text-center transition-all duration-500 relative group ${
                              s.status === 'present' ? 'bg-green-600 shadow-lg shadow-green-900/40' : 'bg-gray-800 text-gray-400'
                            }`}
                          >
                            <div className="text-lg font-bold">
                              {s.name.split(' ').map(w => w[0]).join('').slice(0, 2).toUpperCase()}
                            </div>
                            <div className="text-xs truncate mt-1 font-medium">{s.name.split(' ')[0]}</div>
                            <div className="text-[10px] opacity-60 truncate">{s.student_number}</div>
                            {s.status === 'present' ? (
                              <div className="text-[10px] text-green-200 mt-1">
                                ✓ {s.scanned_at
                                  ? new Date(s.scanned_at).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })
                                  : 'Present'}
                              </div>
                            ) : (
                              <button
                                onClick={() => markPresent(s.id)}
                                title="Mark present"
                                className="text-[10px] text-gray-500 hover:text-green-400 mt-1 transition opacity-0 group-hover:opacity-100 leading-none"
                              >
                                + Mark
                              </button>
                            )}
                          </div>
                        ))}
                      </div>
                    )}

                    {/* Absent list */}
                    {absentCount > 0 && (
                      <div className="bg-gray-900 border border-gray-800 rounded-2xl p-4">
                        <h3 className="text-sm font-semibold text-gray-400 mb-3">Absent ({absentCount})</h3>
                        <div className="flex flex-wrap gap-2">
                          {roster.filter(s => s.status !== 'present').map(s => (
                            <div key={s.id} className="flex items-center gap-1.5 bg-gray-800 rounded-full pl-3 pr-1.5 py-1">
                              <span className="text-gray-300 text-xs">{s.name} · {s.student_number}</span>
                              <button
                                onClick={() => markPresent(s.id)}
                                title="Mark present"
                                className="text-gray-500 hover:text-green-400 text-xs transition leading-none bg-gray-700 hover:bg-gray-600 rounded-full px-1.5 py-0.5"
                              >
                                ✓
                              </button>
                            </div>
                          ))}
                        </div>
                      </div>
                    )}
                  </>
                )}
              </div>
            )}

            {/* ── STUDENTS TAB ── */}
            {tab === 'students' && (
              <div className="space-y-6">
                {/* Add student panel */}
                <div className="bg-gray-900 border border-gray-800 rounded-2xl p-6">
                  <div className="flex items-center gap-4 mb-4">
                    <h2 className="font-semibold text-white">Add Student</h2>
                    <div className="flex gap-1 bg-gray-800 rounded-lg p-1">
                      <button
                        onClick={() => { setAddMode('new'); setSearchQuery(''); setSearchResults([]) }}
                        className={`px-3 py-1.5 rounded-md text-xs font-medium transition ${addMode === 'new' ? 'bg-indigo-600 text-white' : 'text-gray-400 hover:text-white'}`}
                      >
                        New Enrollment
                      </button>
                      <button
                        onClick={() => { setAddMode('search'); resetAddForm() }}
                        className={`px-3 py-1.5 rounded-md text-xs font-medium transition ${addMode === 'search' ? 'bg-indigo-600 text-white' : 'text-gray-400 hover:text-white'}`}
                      >
                        Add Existing
                      </button>
                    </div>
                  </div>

                  {addMode === 'search' ? (
                    /* ── SEARCH EXISTING STUDENT ── */
                    <div className="space-y-3">
                      <p className="text-gray-400 text-sm">Search the global student database by name or student number.</p>
                      <div className="relative">
                        <input
                          className="w-full bg-gray-800 border border-gray-700 rounded-lg px-4 py-2.5 text-white placeholder-gray-500 focus:outline-none focus:ring-2 focus:ring-indigo-500"
                          placeholder="Student number or name…"
                          value={searchQuery}
                          onChange={e => setSearchQuery(e.target.value)}
                        />
                        {searchLoading && (
                          <div className="absolute right-3 top-1/2 -translate-y-1/2 w-4 h-4 border-2 border-indigo-500 border-t-transparent rounded-full animate-spin" />
                        )}
                      </div>
                      {searchResults.length > 0 && (
                        <div className="space-y-2">
                          {searchResults.map(s => {
                            const alreadyIn = students.some(st => st.id === s.id)
                            return (
                              <div key={s.id} className="bg-gray-800 rounded-xl px-4 py-3 flex items-center justify-between gap-3">
                                <div>
                                  <span className="font-medium text-white">{s.name}</span>
                                  <span className="text-gray-400 text-sm ml-2">{s.student_number}</span>
                                  {!s.face_enrolled && (
                                    <span className="ml-2 text-xs text-yellow-500">⚠ No face data</span>
                                  )}
                                </div>
                                {alreadyIn ? (
                                  <span className="text-green-400 text-xs font-medium">Already in class</span>
                                ) : (
                                  <button
                                    onClick={() => addExistingToClass(s)}
                                    className="bg-indigo-600 hover:bg-indigo-500 text-white text-xs font-medium px-3 py-1.5 rounded-lg transition"
                                  >
                                    + Add to Class
                                  </button>
                                )}
                              </div>
                            )
                          })}
                        </div>
                      )}
                      {searchQuery && !searchLoading && searchResults.length === 0 && (
                        <p className="text-gray-500 text-sm">No students found. Try a different search term or enroll them as new.</p>
                      )}
                    </div>
                  ) : (
                    /* ── NEW ENROLLMENT ── */
                    addStep === 'done' ? (
                      <div className="text-center space-y-3 py-4">
                        <div className="text-4xl">✅</div>
                        <p className="text-green-400 font-medium">{addedStudent?.name} enrolled successfully!</p>
                        <p className="text-gray-400 text-sm">{uploadProgress.total} face photos registered.</p>
                        <button onClick={resetAddForm} className="bg-indigo-600 hover:bg-indigo-500 rounded-lg px-6 py-2 text-sm font-medium transition">
                          Add Another Student
                        </button>
                      </div>
                    ) : (
                      <form onSubmit={addStudent} className="space-y-5">
                        <div className="grid grid-cols-1 sm:grid-cols-2 gap-4">
                          <div>
                            <label className="block text-gray-400 text-xs mb-1">Full Name *</label>
                            <input
                              required
                              className="w-full bg-gray-800 border border-gray-700 rounded-lg px-4 py-2.5 text-white placeholder-gray-500 focus:outline-none focus:ring-2 focus:ring-indigo-500"
                              placeholder="e.g. Jane Smith"
                              value={addForm.name}
                              onChange={e => setAddForm(f => ({ ...f, name: e.target.value }))}
                            />
                          </div>
                          <div>
                            <label className="block text-gray-400 text-xs mb-1">Student Number *</label>
                            <input
                              required
                              className="w-full bg-gray-800 border border-gray-700 rounded-lg px-4 py-2.5 text-white placeholder-gray-500 focus:outline-none focus:ring-2 focus:ring-indigo-500"
                              placeholder="e.g. S003"
                              value={addForm.student_number}
                              onChange={e => setAddForm(f => ({ ...f, student_number: e.target.value }))}
                            />
                          </div>
                        </div>

                        <div>
                          <label className="block text-gray-400 text-xs mb-2">Face Photos *</label>
                          <input ref={fileInputRef} type="file" accept="image/*" multiple className="hidden" onChange={handleFileSelect} />
                          <div className="flex gap-1 mb-3 bg-gray-800 rounded-lg p-1 w-fit">
                            <button type="button" onClick={() => { setEnrollMode('camera'); setCapturedBlobs([]) }}
                              className={`px-3 py-1.5 rounded-md text-xs font-medium transition ${enrollMode === 'camera' ? 'bg-indigo-600 text-white' : 'text-gray-400 hover:text-white'}`}>
                              📷 Camera
                            </button>
                            <button type="button" onClick={() => { setEnrollMode('upload'); setCapturedBlobs([]) }}
                              className={`px-3 py-1.5 rounded-md text-xs font-medium transition ${enrollMode === 'upload' ? 'bg-indigo-600 text-white' : 'text-gray-400 hover:text-white'}`}>
                              📁 Upload
                            </button>
                          </div>

                          {capturedBlobs.length === 0 ? (
                            <button type="button"
                              onClick={() => enrollMode === 'camera' ? setShowCapture(true) : fileInputRef.current?.click()}
                              className="flex items-center gap-3 bg-gray-800 border border-dashed border-gray-600 hover:border-indigo-500 rounded-xl px-5 py-4 text-gray-300 transition w-full">
                              <span className="text-2xl">{enrollMode === 'camera' ? '📷' : '📁'}</span>
                              <div className="text-left">
                                <p className="font-medium text-sm">{enrollMode === 'camera' ? 'Open Camera to Capture Face' : 'Choose Photos from Device'}</p>
                                <p className="text-gray-500 text-xs mt-0.5">{enrollMode === 'camera' ? '5 guided poses · ~15 seconds' : 'Select 1 or more clear face photos'}</p>
                              </div>
                            </button>
                          ) : (
                            <div className="flex items-center gap-3 bg-green-900/30 border border-green-800/50 rounded-xl px-5 py-4">
                              <div className="flex gap-1 flex-wrap">
                                {Array.from({ length: Math.min(capturedBlobs.length, 10) }).map((_, i) => (
                                  <div key={i} className="w-2.5 h-2.5 rounded-full bg-green-400" />
                                ))}
                              </div>
                              <div className="flex-1">
                                <p className="text-green-400 font-medium text-sm">{capturedBlobs.length} photo{capturedBlobs.length !== 1 ? 's' : ''} ready</p>
                              </div>
                              <button type="button" onClick={() => { setCapturedBlobs([]); if (enrollMode === 'upload') fileInputRef.current?.click(); else setShowCapture(true) }}
                                className="text-gray-400 hover:text-white text-xs transition">
                                {enrollMode === 'upload' ? 'Change' : 'Retake'}
                              </button>
                            </div>
                          )}
                        </div>

                        {addError && (
                          <div className="bg-red-900/40 border border-red-700 rounded-lg px-4 py-2 text-red-300 text-sm">{addError}</div>
                        )}
                        <button
                          type="submit"
                          disabled={addStep === 'saving' || addStep === 'uploading'}
                          className="bg-indigo-600 hover:bg-indigo-500 disabled:opacity-50 rounded-lg px-6 py-2.5 font-medium transition"
                        >
                          {addStep === 'saving' && '⏳ Creating student…'}
                          {addStep === 'uploading' && `⏳ Uploading face ${uploadProgress.done}/${uploadProgress.total}…`}
                          {(addStep === 'idle' || addStep === 'error') && 'Enroll Student'}
                        </button>
                      </form>
                    )
                  )}
                </div>

                {/* Student list */}
                <div className="bg-gray-900 border border-gray-800 rounded-2xl p-6">
                  <div className="flex items-center justify-between mb-4">
                    <h2 className="font-semibold text-white">Class Roster ({students.length})</h2>
                    <button onClick={fetchStudents} disabled={studentsLoading} className="text-gray-400 hover:text-white text-sm transition">
                      {studentsLoading ? 'Loading…' : '↻ Refresh'}
                    </button>
                  </div>

                  {studentsLoading ? (
                    <div className="text-gray-500 text-center py-8">Loading…</div>
                  ) : students.length === 0 ? (
                    <div className="text-gray-500 text-center py-8">No students in this class yet.</div>
                  ) : (
                    <div className="space-y-2">
                      {students.map(s => (
                        <div key={s.id} className="bg-gray-800 rounded-xl px-4 py-3">
                          {confirmDeleteId === s.id ? (
                            <div className="flex items-center justify-between gap-3">
                              <p className="text-sm text-red-300">
                                Remove <span className="font-semibold">{s.name}</span> from this class?
                              </p>
                              <div className="flex gap-2 flex-shrink-0">
                                <button onClick={() => removeFromClass(s.id)} disabled={deleting}
                                  className="bg-red-700 hover:bg-red-600 disabled:opacity-50 text-white text-xs font-medium px-3 py-1.5 rounded-lg transition">
                                  {deleting ? 'Removing…' : 'Confirm'}
                                </button>
                                <button onClick={() => setConfirmDeleteId(null)}
                                  className="bg-gray-700 hover:bg-gray-600 text-gray-300 text-xs font-medium px-3 py-1.5 rounded-lg transition">
                                  Cancel
                                </button>
                              </div>
                            </div>
                          ) : editingStudent?.id === s.id ? (
                            <div className="flex items-center gap-3 flex-wrap">
                              <input
                                className="bg-gray-700 border border-gray-600 rounded-lg px-3 py-1.5 text-white text-sm w-44 focus:outline-none focus:ring-2 focus:ring-indigo-500"
                                value={editingStudent.name}
                                onChange={e => setEditingStudent(prev => ({ ...prev, name: e.target.value }))}
                              />
                              <input
                                className="bg-gray-700 border border-gray-600 rounded-lg px-3 py-1.5 text-white text-sm w-28 focus:outline-none focus:ring-2 focus:ring-indigo-500"
                                value={editingStudent.student_number}
                                onChange={e => setEditingStudent(prev => ({ ...prev, student_number: e.target.value }))}
                              />
                              <button onClick={saveEdit} disabled={editSaving}
                                className="bg-indigo-600 hover:bg-indigo-500 disabled:opacity-50 text-white text-xs font-medium px-3 py-1.5 rounded-lg transition">
                                {editSaving ? 'Saving…' : 'Save'}
                              </button>
                              <button onClick={() => setEditingStudent(null)}
                                className="text-gray-500 hover:text-white text-xs transition">
                                Cancel
                              </button>
                            </div>
                          ) : addingPhotosFor?.id === s.id ? (
                            <div className="space-y-3">
                              <div className="flex items-center justify-between">
                                <p className="text-sm font-medium text-white">Add photos for <span className="text-indigo-400">{s.name}</span></p>
                                <button onClick={closeAddPhotos} className="text-gray-500 hover:text-white text-xs transition">✕ Cancel</button>
                              </div>
                              {addPhotosStep === 'done' ? (
                                <div className="flex items-center gap-2 text-green-400 text-sm">
                                  <span>✓ {addPhotosProgress.total} photo{addPhotosProgress.total !== 1 ? 's' : ''} added.</span>
                                  <button onClick={closeAddPhotos} className="ml-auto text-gray-400 hover:text-white text-xs transition">Close</button>
                                </div>
                              ) : (
                                <>
                                  <div className="flex gap-1 bg-gray-700 rounded-lg p-1 w-fit">
                                    <button type="button" onClick={() => { setAddPhotosMode('camera'); setAddPhotosBlobs([]) }}
                                      className={`px-3 py-1 rounded-md text-xs font-medium transition ${addPhotosMode === 'camera' ? 'bg-indigo-600 text-white' : 'text-gray-400 hover:text-white'}`}>
                                      📷 Camera
                                    </button>
                                    <button type="button" onClick={() => { setAddPhotosMode('upload'); setAddPhotosBlobs([]) }}
                                      className={`px-3 py-1 rounded-md text-xs font-medium transition ${addPhotosMode === 'upload' ? 'bg-indigo-600 text-white' : 'text-gray-400 hover:text-white'}`}>
                                      📁 Upload
                                    </button>
                                  </div>
                                  {addPhotosBlobs.length === 0 ? (
                                    <button type="button"
                                      onClick={() => addPhotosMode === 'camera' ? setShowAddCapture(true) : addPhotosFileRef.current?.click()}
                                      className="flex items-center gap-3 bg-gray-700 border border-dashed border-gray-600 hover:border-indigo-500 rounded-xl px-4 py-3 text-gray-300 transition w-full">
                                      <span>{addPhotosMode === 'camera' ? '📷' : '📁'}</span>
                                      <span className="text-sm">{addPhotosMode === 'camera' ? 'Open camera (5 guided poses)' : 'Choose photos from device'}</span>
                                    </button>
                                  ) : (
                                    <div className="flex items-center gap-3 bg-green-900/20 border border-green-800/40 rounded-xl px-4 py-2.5">
                                      <span className="text-green-400 text-sm">{addPhotosBlobs.length} photo{addPhotosBlobs.length !== 1 ? 's' : ''} ready</span>
                                      <button onClick={() => setAddPhotosBlobs([])} className="text-gray-500 hover:text-white text-xs ml-auto transition">Clear</button>
                                    </div>
                                  )}
                                  <button onClick={uploadExtraPhotos}
                                    disabled={addPhotosBlobs.length === 0 || addPhotosStep === 'uploading'}
                                    className="bg-indigo-600 hover:bg-indigo-500 disabled:opacity-40 rounded-lg px-4 py-2 text-sm font-medium transition">
                                    {addPhotosStep === 'uploading' ? `Uploading ${addPhotosProgress.done}/${addPhotosProgress.total}…` : 'Upload Photos'}
                                  </button>
                                </>
                              )}
                            </div>
                          ) : (
                            /* Normal row */
                            <div className="flex items-center justify-between gap-3">
                              <div className="min-w-0">
                                <span className="font-medium text-white">{s.name}</span>
                                <span className="text-gray-400 text-sm ml-2">{s.student_number}</span>
                                {s.sessions_total > 0 && (
                                  <span className="text-gray-500 text-xs ml-3">
                                    {s.sessions_attended}/{s.sessions_total} sessions
                                    {' '}
                                    <span className={`font-medium ${
                                      s.sessions_attended / s.sessions_total >= 0.75 ? 'text-green-400'
                                      : s.sessions_attended / s.sessions_total >= 0.5 ? 'text-yellow-400'
                                      : 'text-red-400'
                                    }`}>
                                      ({Math.round((s.sessions_attended / s.sessions_total) * 100)}%)
                                    </span>
                                  </span>
                                )}
                              </div>
                              <div className="flex items-center gap-3 flex-shrink-0">
                                <span className={`text-xs px-2 py-1 rounded-full ${
                                  s.face_enrolled
                                    ? 'bg-green-900/40 text-green-400 border border-green-800/50'
                                    : 'bg-yellow-900/40 text-yellow-400 border border-yellow-800/50'
                                }`}>
                                  {s.face_enrolled ? `✓ Face (${s.face_count})` : '⚠ No face'}
                                </span>
                                {s.last_enrolled_at && s.face_enrolled && (() => {
                                  const daysOld = Math.floor((Date.now() - new Date(s.last_enrolled_at)) / 86400000)
                                  return daysOld > 180 ? (
                                    <span className="text-xs px-2 py-1 rounded-full bg-orange-900/40 text-orange-400 border border-orange-800/50"
                                          title={`Face data last updated ${daysOld} days ago — consider re-enrolling`}>
                                      ↻ Re-enroll?
                                    </span>
                                  ) : null
                                })()}
                                <button onClick={() => setEditingStudent({ id: s.id, name: s.name, student_number: s.student_number })}
                                  title="Edit student" className="text-gray-500 hover:text-indigo-400 transition text-sm">
                                  ✏
                                </button>
                                <button onClick={() => openAddPhotos(s)} title="Add face photos"
                                  className="text-gray-500 hover:text-indigo-400 transition text-sm font-medium">
                                  + Photos
                                </button>
                                <button onClick={() => setConfirmDeleteId(s.id)} title="Remove from class"
                                  className="text-gray-500 hover:text-red-400 transition text-base leading-none">
                                  🗑
                                </button>
                              </div>
                            </div>
                          )}
                        </div>
                      ))}
                    </div>
                  )}
                </div>
              </div>
            )}

            {/* ── HISTORY TAB ── */}
            {tab === 'history' && (
              <div className="space-y-4">
                <div className="flex items-center justify-between">
                  <h2 className="font-semibold text-white text-lg">Past Sessions</h2>
                  <button onClick={fetchHistory} disabled={historyLoading} className="text-gray-400 hover:text-white text-sm transition">
                    {historyLoading ? 'Loading…' : '↻ Refresh'}
                  </button>
                </div>

                {historyLoading ? (
                  <div className="text-gray-500 text-center py-12">Loading…</div>
                ) : history.length === 0 ? (
                  <div className="text-gray-500 text-center py-12">No past sessions yet. Start your first attendance session.</div>
                ) : (
                  <div className="space-y-2">
                    {history.map(h => {
                      const pct = h.total_count > 0 ? Math.round((h.present_count / h.total_count) * 100) : 0
                      const openedAt = new Date(h.opened_at)
                      const timeStr = openedAt.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })
                      return (
                        <div key={h.id} className="bg-gray-900 border border-gray-800 rounded-2xl px-5 py-4 flex items-center gap-4">
                          <div className="flex-1 min-w-0">
                            <div className="flex items-center gap-3">
                              <span className="font-semibold text-white">{h.date}</span>
                              <span className="text-gray-500 text-sm">{timeStr}</span>
                              {h.is_open && new Date(h.closes_at) > new Date() && (
                                <span className="text-xs bg-green-900/40 text-green-400 border border-green-800/50 rounded-full px-2 py-0.5">Live</span>
                              )}
                            </div>
                            <div className="mt-2 space-y-1">
                              <div className="flex items-center gap-3 text-sm">
                                <span className="text-green-400 font-semibold">{h.present_count} present</span>
                                <span className="text-gray-500">/ {h.total_count} total</span>
                                <span className={`font-medium ${pct >= 75 ? 'text-green-400' : pct >= 50 ? 'text-yellow-400' : 'text-red-400'}`}>
                                  {pct}%
                                </span>
                              </div>
                              <div className="w-48 bg-gray-800 rounded-full h-1.5 overflow-hidden">
                                <div
                                  className={`h-1.5 rounded-full ${pct >= 75 ? 'bg-green-500' : pct >= 50 ? 'bg-yellow-500' : 'bg-red-500'}`}
                                  style={{ width: `${pct}%` }}
                                />
                              </div>
                            </div>
                          </div>
                          <div className="flex gap-2 flex-shrink-0">
                            {h.is_open && new Date(h.closes_at) > new Date() ? (
                              <button
                                onClick={async () => {
                                  setWindowId(h.id)
                                  setClosesAt(new Date(h.closes_at))
                                  await fetchRoster(h.id)
                                  setTab('session')
                                }}
                                className="bg-green-800 hover:bg-green-700 rounded-xl px-4 py-2 text-sm font-medium transition"
                              >
                                → View Live
                              </button>
                            ) : !h.is_open ? (
                              <button
                                onClick={() => reopenWindow(h.id, 5)}
                                className="bg-indigo-800 hover:bg-indigo-700 rounded-xl px-4 py-2 text-sm font-medium transition"
                                title="Re-open for 5 more minutes"
                              >
                                ↺ Re-open
                              </button>
                            ) : null}
                            <button
                              onClick={() => downloadHistorySession(h.id, h.date, timeStr, selectedClass?.name)}
                              className="bg-gray-700 hover:bg-gray-600 rounded-xl px-4 py-2 text-sm font-medium transition"
                            >
                              ⬇ Excel
                            </button>
                          </div>
                        </div>
                      )
                    })}
                  </div>
                )}
              </div>
            )}

          </div>
        </>
      )}
    </div>
  )
}
