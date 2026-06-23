import { useState, useEffect, useRef, useCallback } from 'react'

const API_BASE = '/api/v1'
const WS_BASE = 'ws://localhost:8000/api/v1'

export default function App() {
  const [token, setToken] = useState(localStorage.getItem('token') || '')
  const [email, setEmail] = useState('')
  const [password, setPassword] = useState('')
  const [loginError, setLoginError] = useState('')

  const [classId, setClassId] = useState(1)
  const [windowId, setWindowId] = useState(null)
  const [closesAt, setClosesAt] = useState(null)
  const [timeLeft, setTimeLeft] = useState(0)
  const [roster, setRoster] = useState([])
  const [loading, setLoading] = useState(false)

  const wsRef = useRef(null)

  // ─── Auth ────────────────────────────────────────────────────────────────────
  async function login() {
    setLoginError('')
    const form = new FormData()
    form.append('username', email)
    form.append('password', password)
    const res = await fetch(`${API_BASE}/auth/token`, { method: 'POST', body: form })
    const data = await res.json()
    if (res.ok) {
      localStorage.setItem('token', data.access_token)
      setToken(data.access_token)
    } else {
      setLoginError('Invalid credentials')
    }
  }

  function logout() {
    localStorage.removeItem('token')
    setToken('')
    wsRef.current?.close()
  }

  const authHeaders = { Authorization: `Bearer ${token}` }

  // ─── WebSocket ───────────────────────────────────────────────────────────────
  const connectWs = useCallback((cid) => {
    wsRef.current?.close()
    const ws = new WebSocket(`${WS_BASE}/attendance/ws/${cid}`)
    ws.onmessage = (e) => {
      const msg = JSON.parse(e.data)
      if (msg.event === 'student_present') {
        setRoster(prev => prev.map(s =>
          s.student_number === msg.student_number ? { ...s, status: 'present' } : s
        ))
      }
      if (msg.event === 'window_opened') {
        setWindowId(msg.window_id)
        setClosesAt(new Date(msg.closes_at))
      }
      if (msg.event === 'window_closed') {
        setWindowId(null)
      }
    }
    ws.onerror = () => console.error('WS error')
    wsRef.current = ws
  }, [])

  // ─── Countdown ───────────────────────────────────────────────────────────────
  useEffect(() => {
    if (!closesAt) return
    const id = setInterval(() => {
      const secs = Math.max(0, Math.round((closesAt - Date.now()) / 1000))
      setTimeLeft(secs)
      if (secs === 0) {
        setWindowId(null)
        clearInterval(id)
      }
    }, 1000)
    return () => clearInterval(id)
  }, [closesAt])

  // ─── Open window ─────────────────────────────────────────────────────────────
  async function openWindow() {
    setLoading(true)
    const res = await fetch(`${API_BASE}/attendance/window/open?class_id=${classId}`, {
      method: 'POST',
      headers: authHeaders,
    })
    const data = await res.json()
    if (res.ok) {
      setWindowId(data.window_id)
      setClosesAt(new Date(data.closes_at))
      connectWs(classId)
      await fetchRoster(data.window_id)
    }
    setLoading(false)
  }

  async function closeWindow() {
    if (!windowId) return
    await fetch(`${API_BASE}/attendance/window/${windowId}/close`, {
      method: 'POST',
      headers: authHeaders,
    })
    setWindowId(null)
  }

  async function fetchRoster(wid) {
    const res = await fetch(`${API_BASE}/attendance/window/${wid}/roster`, {
      headers: authHeaders,
    })
    const data = await res.json()
    if (res.ok) setRoster(data.roster)
  }

  const presentCount = roster.filter(s => s.status === 'present').length
  const mins = String(Math.floor(timeLeft / 60)).padStart(2, '0')
  const secs = String(timeLeft % 60).padStart(2, '0')

  // ─── Login screen ─────────────────────────────────────────────────────────────
  if (!token) return (
    <div className="min-h-screen bg-gray-950 text-white flex items-center justify-center p-4">
      <div className="bg-gray-800 rounded-2xl p-8 w-full max-w-sm space-y-4">
        <h1 className="text-xl font-bold text-indigo-400">Teacher Login</h1>
        {loginError && <p className="text-red-400 text-sm">{loginError}</p>}
        <input className="w-full bg-gray-700 rounded-lg px-4 py-3 placeholder-gray-400 focus:outline-none focus:ring-2 focus:ring-indigo-500"
          placeholder="Email" value={email} onChange={e => setEmail(e.target.value)} />
        <input className="w-full bg-gray-700 rounded-lg px-4 py-3 placeholder-gray-400 focus:outline-none focus:ring-2 focus:ring-indigo-500"
          type="password" placeholder="Password" value={password} onChange={e => setPassword(e.target.value)}
          onKeyDown={e => e.key === 'Enter' && login()} />
        <button onClick={login} className="w-full bg-indigo-600 hover:bg-indigo-500 rounded-lg py-3 font-semibold transition">
          Sign In
        </button>
      </div>
    </div>
  )

  // ─── Dashboard ────────────────────────────────────────────────────────────────
  return (
    <div className="min-h-screen bg-gray-950 text-white p-4 md:p-8">
      {/* Header */}
      <div className="flex items-center justify-between mb-6">
        <h1 className="text-xl font-bold text-indigo-400">Attendance Dashboard</h1>
        <button onClick={logout} className="text-gray-400 hover:text-white text-sm transition">Sign out</button>
      </div>

      {/* Controls */}
      <div className="flex flex-wrap gap-3 mb-6 items-center">
        {!windowId ? (
          <button
            onClick={openWindow}
            disabled={loading}
            className="bg-green-600 hover:bg-green-500 disabled:opacity-50 rounded-lg px-6 py-3 font-semibold transition"
          >
            {loading ? 'Opening…' : 'Open Attendance Window'}
          </button>
        ) : (
          <>
            <div className="bg-gray-800 rounded-lg px-6 py-3 font-mono text-2xl text-yellow-400">
              {mins}:{secs}
            </div>
            <div className="text-gray-400 text-sm">
              Share this link with students:<br />
              <code className="text-indigo-300">http://&lt;your-ip&gt;:5173/?window={windowId}</code>
            </div>
            <button onClick={closeWindow} className="bg-red-700 hover:bg-red-600 rounded-lg px-4 py-3 text-sm transition ml-auto">
              Close Window
            </button>
          </>
        )}
      </div>

      {/* Stats */}
      {roster.length > 0 && (
        <div className="flex gap-4 mb-6">
          <div className="bg-green-900/40 border border-green-700 rounded-xl px-6 py-4 text-center">
            <div className="text-3xl font-bold text-green-400">{presentCount}</div>
            <div className="text-gray-400 text-sm">Present</div>
          </div>
          <div className="bg-gray-800 rounded-xl px-6 py-4 text-center">
            <div className="text-3xl font-bold">{roster.length - presentCount}</div>
            <div className="text-gray-400 text-sm">Absent</div>
          </div>
          <div className="bg-gray-800 rounded-xl px-6 py-4 text-center">
            <div className="text-3xl font-bold">{roster.length}</div>
            <div className="text-gray-400 text-sm">Total</div>
          </div>
        </div>
      )}

      {/* Roster grid */}
      {roster.length > 0 && (
        <div className="grid grid-cols-4 sm:grid-cols-6 md:grid-cols-10 gap-2">
          {roster.map(s => (
            <div
              key={s.id}
              title={`${s.name} (${s.student_number})`}
              className={`rounded-lg p-2 text-center text-xs transition-all duration-500 ${
                s.status === 'present'
                  ? 'bg-green-600 text-white shadow-lg shadow-green-900/50'
                  : 'bg-gray-800 text-gray-500'
              }`}
            >
              <div className="truncate font-medium">{s.name.split(' ')[0]}</div>
              <div className="truncate text-[10px] opacity-60">{s.student_number}</div>
            </div>
          ))}
        </div>
      )}

      {roster.length === 0 && !windowId && (
        <p className="text-gray-500 text-center mt-20">Open a window to start taking attendance.</p>
      )}
    </div>
  )
}
