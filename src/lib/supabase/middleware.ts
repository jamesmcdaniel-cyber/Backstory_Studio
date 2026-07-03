import { createServerClient } from '@supabase/ssr'
import { NextResponse, type NextRequest } from 'next/server'
import { getSupabaseConfig } from './config'

const publicPages = new Set([
  '/',
  '/auth',
  '/auth/login',
  '/auth/signin',
  '/auth/signup',
  '/auth/callback',
  '/auth/auth-code-error',
  '/privacy',
  '/terms',
])

function copyCookies(source: NextResponse, target: NextResponse) {
  source.cookies.getAll().forEach((cookie) => target.cookies.set(cookie))
  return target
}

export async function updateSession(request: NextRequest) {
  let response = NextResponse.next({ request })
  const { url, anonKey } = getSupabaseConfig()
  const supabase = createServerClient(url, anonKey, {
    cookies: {
      getAll: () => request.cookies.getAll(),
      setAll(cookies) {
        cookies.forEach(({ name, value }) => request.cookies.set(name, value))
        response = NextResponse.next({ request })
        cookies.forEach(({ name, value, options }) => response.cookies.set(name, value, options))
      },
    },
  })

  const { data: { user } } = await supabase.auth.getUser()
  const pathname = request.nextUrl.pathname
  const isApi = pathname.startsWith('/api/')
  const isAuthPage = pathname.startsWith('/auth/')

  // Production is SSO/invite-only: password signup is disabled unless
  // explicitly allowed (AUTH_ALLOW_PASSWORD=true keeps it for dev).
  if (pathname === '/auth/signup' && process.env.AUTH_ALLOW_PASSWORD === 'false') {
    const url = request.nextUrl.clone()
    url.pathname = '/auth/login'
    url.search = ''
    return copyCookies(response, NextResponse.redirect(url))
  }

  if (!user && !isApi && !publicPages.has(pathname)) {
    const url = request.nextUrl.clone()
    url.pathname = '/auth/login'
    url.search = ''
    url.searchParams.set('return_to', `${pathname}${request.nextUrl.search}`)
    return copyCookies(response, NextResponse.redirect(url))
  }

  if (user && isAuthPage && pathname !== '/auth/callback') {
    const url = request.nextUrl.clone()
    url.pathname = '/dashboard'
    url.search = ''
    return copyCookies(response, NextResponse.redirect(url))
  }

  return response
}
