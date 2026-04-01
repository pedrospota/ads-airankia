'use client'

import { useState } from 'react'
import { createSupabaseBrowser } from '@/lib/supabase-browser'
import { useRouter } from 'next/navigation'

export default function LoginPage() {
  const [email, setEmail] = useState('')
  const [password, setPassword] = useState('')
  const [error, setError] = useState<string | null>(null)
  const [loading, setLoading] = useState(false)
  const router = useRouter()

  async function handleLogin(e: React.FormEvent) {
    e.preventDefault()
    setLoading(true)
    setError(null)
    const supabase = createSupabaseBrowser()
    const { error } = await supabase.auth.signInWithPassword({ email, password })
    if (error) {
      setError(error.message)
      setLoading(false)
    } else {
      router.push('/brands')
      router.refresh()
    }
  }

  async function handleGoogleLogin() {
    const supabase = createSupabaseBrowser()
    await supabase.auth.signInWithOAuth({
      provider: 'google',
      options: { redirectTo: `${window.location.origin}/auth/callback` },
    })
  }

  return (
    <div className="flex items-center justify-center min-h-screen" style={{ background: '#0A0A0E' }}>
      <div style={{ width: '100%', maxWidth: 380 }}>
        <div style={{ display: 'flex', flexDirection: 'column', alignItems: 'center', marginBottom: 32 }}>
          <img src="/airankia-logo-light.png" alt="AI Rankia" style={{ height: 36, width: 'auto', marginBottom: 20, objectFit: 'contain' }} />
          <h1 style={{ fontSize: 22, fontWeight: 600, color: '#fff', letterSpacing: '-0.5px', margin: 0, lineHeight: 1.2 }}>
            Ads Platform
          </h1>
          <p style={{ fontSize: 13, color: 'rgba(255,255,255,0.4)', marginTop: 4 }}>
            by AI Rankia \u00b7 Sign in to your workspace
          </p>
        </div>

        <div style={{ background: '#1C1C23', border: '1px solid #38383F', borderRadius: 14, padding: '28px 28px 24px' }}>
          <form onSubmit={handleLogin} style={{ display: 'flex', flexDirection: 'column', gap: 16 }}>
            <div>
              <label style={{ display: 'block', fontSize: 11, fontWeight: 600, letterSpacing: '0.08em', color: 'rgba(255,255,255,0.45)', marginBottom: 7, textTransform: 'uppercase' }}>Email</label>
              <input type="email" value={email} onChange={e => setEmail(e.target.value)} required placeholder="you@company.com"
                style={{ width: '100%', background: '#0A0A0E', border: '1px solid #38383F', borderRadius: 8, padding: '10px 14px', fontSize: 13, color: '#fff', outline: 'none', boxSizing: 'border-box' }} />
            </div>
            <div>
              <label style={{ display: 'block', fontSize: 11, fontWeight: 600, letterSpacing: '0.08em', color: 'rgba(255,255,255,0.45)', marginBottom: 7, textTransform: 'uppercase' }}>Password</label>
              <input type="password" value={password} onChange={e => setPassword(e.target.value)} required placeholder="\u2022\u2022\u2022\u2022\u2022\u2022\u2022\u2022"
                style={{ width: '100%', background: '#0A0A0E', border: '1px solid #38383F', borderRadius: 8, padding: '10px 14px', fontSize: 13, color: '#fff', outline: 'none', boxSizing: 'border-box' }} />
            </div>
            {error && <p style={{ fontSize: 12, color: '#F87171', background: 'rgba(248,113,113,0.1)', padding: '8px 12px', borderRadius: 7, margin: 0 }}>{error}</p>}
            <button type="submit" disabled={loading}
              style={{ width: '100%', background: '#10B981', border: 'none', borderRadius: 8, padding: '11px', fontSize: 13, fontWeight: 600, color: '#000', cursor: loading ? 'not-allowed' : 'pointer', opacity: loading ? 0.7 : 1, marginTop: 4 }}>
              {loading ? 'Signing in\u2026' : 'Sign in'}
            </button>
          </form>

          <div style={{ display: 'flex', alignItems: 'center', gap: 10, margin: '18px 0' }}>
            <div style={{ flex: 1, height: 1, background: '#38383F' }} />
            <span style={{ fontSize: 11, color: 'rgba(255,255,255,0.3)' }}>or</span>
            <div style={{ flex: 1, height: 1, background: '#38383F' }} />
          </div>

          <button onClick={handleGoogleLogin}
            style={{ width: '100%', background: 'transparent', border: '1px solid #38383F', borderRadius: 8, padding: '10px', fontSize: 13, fontWeight: 500, color: 'rgba(255,255,255,0.7)', cursor: 'pointer', display: 'flex', alignItems: 'center', justifyContent: 'center', gap: 8 }}>
            <svg width="15" height="15" viewBox="0 0 24 24">
              <path d="M22.56 12.25c0-.78-.07-1.53-.2-2.25H12v4.26h5.92c-.26 1.37-1.04 2.53-2.21 3.31v2.77h3.57c2.08-1.92 3.28-4.74 3.28-8.09z" fill="#4285F4"/>
              <path d="M12 23c2.97 0 5.46-.98 7.28-2.66l-3.57-2.77c-.98.66-2.23 1.06-3.71 1.06-2.86 0-5.29-1.93-6.16-4.53H2.18v2.84C3.99 20.53 7.7 23 12 23z" fill="#34A853"/>
              <path d="M5.84 14.09c-.22-.66-.35-1.36-.35-2.09s.13-1.43.35-2.09V7.07H2.18C1.43 8.55 1 10.22 1 12s.43 3.45 1.18 4.93l3.66-2.84z" fill="#FBBC05"/>
              <path d="M12 5.38c1.62 0 3.06.56 4.21 1.64l3.15-3.15C17.45 2.09 14.97 1 12 1 7.7 1 3.99 3.47 2.18 7.07l3.66 2.84c.87-2.6 3.3-4.53 6.16-4.53z" fill="#EA4335"/>
            </svg>
            Continue with Google
          </button>
        </div>

        <p style={{ textAlign: 'center', fontSize: 11, color: 'rgba(255,255,255,0.2)', marginTop: 20 }}>
          Citation Retargeting \u00b7 Powered by AI Rankia
        </p>
      </div>
    </div>
  )
}
