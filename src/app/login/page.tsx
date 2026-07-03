'use client'

import { useState } from 'react'
import { createSupabaseBrowser } from '@/lib/supabase-browser'
import { useRouter } from 'next/navigation'
import { UI } from '@/components/ui-kit'

function traducirError(msg: string): string {
  const m = (msg || '').toLowerCase()
  if (m.includes('invalid login credentials')) return 'Email o contraseña incorrectos.'
  if (m.includes('email not confirmed')) return 'Tu email aún no está confirmado.'
  if (m.includes('rate limit') || m.includes('too many')) return 'Demasiados intentos. Espera un momento y vuelve a probar.'
  return 'No pudimos iniciar tu sesión. Inténtalo de nuevo.'
}

/* Visual tokens come straight from the ui-kit (UI.* = var(--uik-*)), so the
   page follows the .dark/.light theme class even outside the AppShell. */
const inputStyle: React.CSSProperties = {
  width: '100%',
  background: UI.bg,
  border: `1px solid ${UI.borderStrong}`,
  borderRadius: 8,
  padding: '10px 14px',
  fontSize: 13.5,
  color: UI.text,
  outline: 'none',
  boxSizing: 'border-box',
  transition: 'border-color 150ms ease, box-shadow 150ms ease',
}

const labelStyle: React.CSSProperties = {
  display: 'block',
  fontSize: 10.5,
  fontWeight: 500,
  letterSpacing: '0.1em',
  color: UI.muted,
  marginBottom: 7,
  textTransform: 'uppercase',
}

function focusInput(e: React.FocusEvent<HTMLInputElement>) {
  e.currentTarget.style.borderColor = UI.accentHairline
  e.currentTarget.style.boxShadow = `0 0 0 3px ${UI.accentSoft}`
}

function blurInput(e: React.FocusEvent<HTMLInputElement>) {
  e.currentTarget.style.borderColor = UI.borderStrong
  e.currentTarget.style.boxShadow = 'none'
}

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
      setError(traducirError(error.message))
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
    <div
      className="flex items-center justify-center min-h-screen"
      style={{
        background: `radial-gradient(640px 260px at 50% -60px, rgba(16,185,129,0.06), transparent 70%), ${UI.bg}`,
        padding: '24px 16px',
      }}
    >
      <div style={{ width: '100%', maxWidth: 380 }}>
        {/* Hero wordmark — the editorial signature */}
        <div
          className="rise"
          style={{ display: 'flex', flexDirection: 'column', alignItems: 'center', marginBottom: 32 }}
        >
          <div style={{ display: 'flex', alignItems: 'baseline', gap: 10 }}>
            <h1
              style={{
                fontFamily: UI.fontDisplay,
                fontSize: 40,
                fontWeight: 500,
                letterSpacing: '-0.01em',
                lineHeight: 1.1,
                color: UI.text,
                margin: 0,
              }}
            >
              AI Rankia
            </h1>
            <span
              style={{
                fontSize: 10,
                fontWeight: 600,
                padding: '2px 6px',
                borderRadius: 4,
                background: UI.accentSoft,
                color: UI.accent,
                border: `1px solid color-mix(in srgb, ${UI.accent} 30%, transparent)`,
                letterSpacing: '0.08em',
              }}
            >
              ADS
            </span>
          </div>
          <p style={{ fontSize: 13, color: UI.muted, marginTop: 10 }}>
            Accede a tu espacio de campañas
          </p>
        </div>

        {/* Panel */}
        <div
          className="rise"
          style={{
            background: UI.surface,
            border: `1px solid ${UI.border}`,
            borderTopColor: UI.borderTop,
            borderRadius: 12,
            padding: '28px 28px 24px',
          }}
        >
          <form onSubmit={handleLogin} style={{ display: 'flex', flexDirection: 'column', gap: 16 }}>
            <div>
              <label htmlFor="login-email" style={labelStyle}>Email</label>
              <input
                id="login-email"
                type="email"
                value={email}
                onChange={e => setEmail(e.target.value)}
                required
                placeholder="tu@empresa.com"
                style={inputStyle}
                onFocus={focusInput}
                onBlur={blurInput}
              />
            </div>
            <div>
              <label htmlFor="login-password" style={labelStyle}>Contraseña</label>
              <input
                id="login-password"
                type="password"
                value={password}
                onChange={e => setPassword(e.target.value)}
                required
                placeholder="••••••••"
                style={inputStyle}
                onFocus={focusInput}
                onBlur={blurInput}
              />
            </div>
            {error && (
              <p
                role="alert"
                style={{
                  fontSize: 12.5,
                  lineHeight: 1.5,
                  color: UI.danger,
                  background: `color-mix(in srgb, ${UI.danger} 6%, transparent)`,
                  border: `1px solid color-mix(in srgb, ${UI.danger} 35%, transparent)`,
                  padding: '8px 12px',
                  borderRadius: 8,
                  margin: 0,
                }}
              >
                {error}
              </p>
            )}
            {/* Colors come from .uik-btn-primary (globals.css) so the light
                theme override wins; only layout styles are inline. */}
            <button
              type="submit"
              disabled={loading}
              className="uik-btn uik-btn-primary"
              style={{
                width: '100%',
                borderRadius: 8,
                padding: '11px',
                fontSize: 13,
                fontWeight: 550,
                cursor: loading ? 'not-allowed' : 'pointer',
                opacity: loading ? 0.7 : 1,
                marginTop: 4,
              }}
            >
              {loading ? 'Entrando…' : 'Entrar'}
            </button>
          </form>

          <div style={{ display: 'flex', alignItems: 'center', gap: 10, margin: '18px 0' }}>
            <div style={{ flex: 1, height: 1, background: UI.border }} />
            <span style={{ fontSize: 11, color: UI.faint }}>o</span>
            <div style={{ flex: 1, height: 1, background: UI.border }} />
          </div>

          <button
            onClick={handleGoogleLogin}
            className="uik-btn uik-btn-secondary"
            style={{
              width: '100%',
              borderRadius: 8,
              padding: '10px',
              fontSize: 13,
              fontWeight: 500,
              color: UI.muted,
              cursor: 'pointer',
              display: 'flex',
              alignItems: 'center',
              justifyContent: 'center',
              gap: 8,
            }}
          >
            <svg width="15" height="15" viewBox="0 0 24 24" aria-hidden="true">
              <path d="M22.56 12.25c0-.78-.07-1.53-.2-2.25H12v4.26h5.92c-.26 1.37-1.04 2.53-2.21 3.31v2.77h3.57c2.08-1.92 3.28-4.74 3.28-8.09z" fill="#4285F4"/>
              <path d="M12 23c2.97 0 5.46-.98 7.28-2.66l-3.57-2.77c-.98.66-2.23 1.06-3.71 1.06-2.86 0-5.29-1.93-6.16-4.53H2.18v2.84C3.99 20.53 7.7 23 12 23z" fill="#34A853"/>
              <path d="M5.84 14.09c-.22-.66-.35-1.36-.35-2.09s.13-1.43.35-2.09V7.07H2.18C1.43 8.55 1 10.22 1 12s.43 3.45 1.18 4.93l3.66-2.84z" fill="#FBBC05"/>
              <path d="M12 5.38c1.62 0 3.06.56 4.21 1.64l3.15-3.15C17.45 2.09 14.97 1 12 1 7.7 1 3.99 3.47 2.18 7.07l3.66 2.84c.87-2.6 3.3-4.53 6.16-4.53z" fill="#EA4335"/>
            </svg>
            Continuar con Google
          </button>
        </div>

        <p className="rise" style={{ textAlign: 'center', fontSize: 11, color: UI.faint, marginTop: 20 }}>
          Campañas de Google Ads con IA · AI Rankia
        </p>
      </div>
    </div>
  )
}
