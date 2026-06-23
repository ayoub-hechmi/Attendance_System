import { useRef, useState, useEffect } from 'react'

const API_BASE = '/api/v1'

export default function App() {
  const videoRef = useRef(null)
  const canvasRef = useRef(null)
  const streamRef = useRef(null)

  const [step, setStep] = useState('enter-id') // enter-id | camera | processing | done | error
  const [studentNumber, setStudentNumber] = useState('')
  const [windowId, setWindowId] = useState('')
  const [message, setMessage] = useState('')

  // Get window_id from URL params (teacher shares a link like /?window=42)
  useEffect(() => {
    const params = new URLSearchParams(window.location.search)
    const wid = params.get('window')
    if (wid) setWindowId(wid)
  }, [])

  async function startCamera() {
    try {
      const stream = await navigator.mediaDevices.getUserMedia({
        video: { facingMode: 'user', width: 1280, height: 720 },
      })
      streamRef.current = stream
      videoRef.current.srcObject = stream
      setStep('camera')
    } catch {
      setMessage('Camera access denied. Please allow camera access and try again.')
      setStep('error')
    }
  }

  function stopCamera() {
    streamRef.current?.getTracks().forEach(t => t.stop())
  }

  async function captureAndSend() {
    setStep('processing')
    const video = videoRef.current
    const canvas = canvasRef.current
    canvas.width = video.videoWidth
    canvas.height = video.videoHeight
    canvas.getContext('2d').drawImage(video, 0, 0)

    canvas.toBlob(async (blob) => {
      stopCamera()
      const form = new FormData()
      form.append('image', blob, 'scan.jpg')
      form.append('student_number', studentNumber)
      form.append('window_id', windowId)

      try {
        const res = await fetch(`${API_BASE}/attendance/scan`, { method: 'POST', body: form })
        const data = await res.json()
        if (res.ok) {
          setMessage(data.message || 'Scan submitted successfully!')
          setStep('done')
        } else {
          setMessage(data.detail || 'Error submitting scan.')
          setStep('error')
        }
      } catch {
        setMessage('Network error. Check your connection and try again.')
        setStep('error')
      }
    }, 'image/jpeg', 0.85)
  }

  return (
    <div className="min-h-screen bg-gray-950 text-white flex flex-col items-center justify-center p-4">
      <div className="w-full max-w-md">
        <h1 className="text-2xl font-bold text-center mb-6 text-indigo-400">
          Face Attendance
        </h1>

        {step === 'enter-id' && (
          <div className="bg-gray-800 rounded-2xl p-6 space-y-4">
            <p className="text-gray-300 text-sm">Enter your student number, then scan your face to mark yourself present.</p>
            <input
              className="w-full bg-gray-700 rounded-lg px-4 py-3 text-white placeholder-gray-400 focus:outline-none focus:ring-2 focus:ring-indigo-500"
              placeholder="Student number (e.g. 2024CS001)"
              value={studentNumber}
              onChange={e => setStudentNumber(e.target.value)}
              onKeyDown={e => e.key === 'Enter' && studentNumber && startCamera()}
            />
            {!windowId && (
              <input
                className="w-full bg-gray-700 rounded-lg px-4 py-3 text-white placeholder-gray-400 focus:outline-none focus:ring-2 focus:ring-indigo-500"
                placeholder="Session ID (from QR code)"
                value={windowId}
                onChange={e => setWindowId(e.target.value)}
              />
            )}
            <button
              onClick={startCamera}
              disabled={!studentNumber || !windowId}
              className="w-full bg-indigo-600 hover:bg-indigo-500 disabled:opacity-40 disabled:cursor-not-allowed rounded-lg py-3 font-semibold transition"
            >
              Open Camera
            </button>
          </div>
        )}

        {step === 'camera' && (
          <div className="space-y-4">
            <div className="relative rounded-2xl overflow-hidden bg-black aspect-video">
              <video ref={videoRef} autoPlay playsInline muted className="w-full h-full object-cover" />
              <div className="absolute inset-0 flex items-center justify-center pointer-events-none">
                <div className="w-48 h-60 border-2 border-indigo-400 rounded-full opacity-60" />
              </div>
            </div>
            <canvas ref={canvasRef} className="hidden" />
            <p className="text-center text-gray-400 text-sm">
              Centre your face in the oval, then tap Scan.
            </p>
            <button
              onClick={captureAndSend}
              className="w-full bg-green-600 hover:bg-green-500 rounded-lg py-3 font-semibold text-lg transition"
            >
              Scan My Face
            </button>
            <button
              onClick={() => { stopCamera(); setStep('enter-id') }}
              className="w-full text-gray-400 hover:text-white text-sm transition"
            >
              Cancel
            </button>
          </div>
        )}

        {step === 'processing' && (
          <div className="text-center space-y-4">
            <div className="w-16 h-16 mx-auto border-4 border-indigo-500 border-t-transparent rounded-full animate-spin" />
            <p className="text-gray-300">Verifying your identity...</p>
          </div>
        )}

        {step === 'done' && (
          <div className="bg-green-900/40 border border-green-500 rounded-2xl p-8 text-center space-y-3">
            <div className="text-5xl">✓</div>
            <p className="text-green-400 font-semibold text-lg">{message}</p>
            <p className="text-gray-400 text-sm">You can close this tab.</p>
          </div>
        )}

        {step === 'error' && (
          <div className="bg-red-900/40 border border-red-500 rounded-2xl p-8 text-center space-y-4">
            <div className="text-5xl">✗</div>
            <p className="text-red-400">{message}</p>
            <button
              onClick={() => setStep('enter-id')}
              className="bg-gray-700 hover:bg-gray-600 rounded-lg px-6 py-2 transition"
            >
              Try Again
            </button>
          </div>
        )}
      </div>
    </div>
  )
}
