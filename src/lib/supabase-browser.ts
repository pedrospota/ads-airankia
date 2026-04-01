import { createClient as createSupabaseClient } from '@supabase/supabase-js'

const CHUNK_SIZE = 3500
const SUPABASE_URL = process.env.NEXT_PUBLIC_SUPABASE_URL ?? ''
const PROJECT_REF = SUPABASE_URL.match(/\/\/([^.]+)/)?.[1] ?? ''
const STORAGE_KEY = `sb-${PROJECT_REF}-auth-token`

function parseCookies(): Record<string, string> {
  if (typeof document === 'undefined') return {}
  const cookies: Record<string, string> = {}
  for (const c of document.cookie.split(';')) {
    const trimmed = c.trim()
    if (!trimmed) continue
    const eqIdx = trimmed.indexOf('=')
    if (eqIdx === -1) continue
    cookies[trimmed.slice(0, eqIdx)] = trimmed.slice(eqIdx + 1)
  }
  return cookies
}

function readCookieValue(key: string): string | null {
  const cookies = parseCookies()
  if (key in cookies && cookies[key]) return cookies[key]
  let combined = ''
  for (let i = 0; ; i++) {
    const chunk = cookies[`${key}.${i}`]
    if (chunk === undefined) break
    combined += chunk
  }
  return combined || null
}

function setCookieNative(cookieString: string): void {
  if (typeof document === 'undefined') return
  const nativeSetter = Object.getOwnPropertyDescriptor(Document.prototype, 'cookie')?.set
  if (nativeSetter) {
    nativeSetter.call(document, cookieString)
  } else {
    document.cookie = cookieString
  }
}

const cookieStorage: Storage = {
  get length() { return 0 },
  key() { return null },
  clear() {},
  getItem(key: string): string | null { return readCookieValue(key) },
  setItem(key: string, value: string): void {
    if (typeof document === 'undefined') return
    if (!value || value === 'null' || value === 'undefined' || value.length < 50) return
    const isSecure = window.location.protocol === 'https:'
    const suffix = `; path=/; max-age=${60 * 60 * 24 * 365}; samesite=lax${isSecure ? '; secure' : ''}`
    if (value.length <= CHUNK_SIZE) {
      setCookieNative(`${key}=${value}${suffix}`)
      for (let i = 0; i < 10; i++) {
        const cn = `${key}.${i}`
        if (!document.cookie.includes(cn + '=')) break
        setCookieNative(`${cn}=; path=/; max-age=0`)
      }
    } else {
      const count = Math.ceil(value.length / CHUNK_SIZE)
      for (let i = 0; i < count; i++) {
        setCookieNative(`${key}.${i}=${value.slice(i * CHUNK_SIZE, (i + 1) * CHUNK_SIZE)}${suffix}`)
      }
      for (let i = count; i < count + 5; i++) {
        if (!document.cookie.includes(`${key}.${i}=`)) break
        setCookieNative(`${key}.${i}=; path=/; max-age=0`)
      }
      if (document.cookie.includes(key + '=')) {
        setCookieNative(`${key}=; path=/; max-age=0`)
      }
    }
  },
  removeItem(): void {},
}

let _cached: ReturnType<typeof createSupabaseClient> | null = null

export function createSupabaseBrowser() {
  if (_cached) return _cached
  _cached = createSupabaseClient(
    process.env.NEXT_PUBLIC_SUPABASE_URL!,
    process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY!,
    {
      auth: {
        autoRefreshToken: false,
        persistSession: true,
        detectSessionInUrl: false,
        storage: cookieStorage,
        flowType: 'implicit',
      },
    }
  )
  return _cached
}
