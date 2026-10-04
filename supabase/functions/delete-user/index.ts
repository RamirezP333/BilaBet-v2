import { withSupabase } from 'npm:@supabase/server@^1'

const corsHeaders = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'authorization, x-client-info, apikey, content-type',
  'Access-Control-Allow-Methods': 'POST, OPTIONS',
}

function jsonResponse(body: Record<string, unknown>, status = 200) {
  return new Response(JSON.stringify(body), {
    status,
    headers: {
      ...corsHeaders,
      'Content-Type': 'application/json',
    },
  })
}

const handler = withSupabase({ auth: 'user' }, async (req, ctx) => {
  if (req.method !== 'POST') {
    return jsonResponse({ success: false, error: 'Método no permitido.' }, 405)
  }

  try {
    const caller = await ctx.supabase.auth.getUser()

    if (caller.error || !caller.data.user) {
      return jsonResponse({ success: false, error: 'Sesión no válida.' }, 401)
    }

    const { data: callerProfile, error: callerProfileError } = await ctx.supabaseAdmin
      .from('profiles')
      .select('role')
      .eq('id', caller.data.user.id)
      .maybeSingle()

    if (callerProfileError) {
      return jsonResponse({ success: false, error: callerProfileError.message }, 500)
    }

    if (callerProfile?.role !== 'admin') {
      return jsonResponse({ success: false, error: 'No tienes permisos de administrador.' }, 403)
    }

    const body = await req.json().catch(() => null)
    const userId = typeof body?.user_id === 'string' ? body.user_id : ''

    if (!userId) {
      return jsonResponse({ success: false, error: 'Falta el ID del usuario.' }, 400)
    }

    if (userId === caller.data.user.id) {
      return jsonResponse({ success: false, error: 'No puedes eliminar tu propia cuenta de administrador.' }, 400)
    }

    // Primero intentamos borrar el usuario de Auth. Si alguna FK antigua
    // impide el borrado, limpiamos los datos públicos dependientes y reintentamos.
    let authDelete = await ctx.supabaseAdmin.auth.admin.deleteUser(userId, false)

    if (authDelete.error) {
      const dependentDeletes = [
        await ctx.supabaseAdmin.from('bets').delete().eq('user_id', userId),
        await ctx.supabaseAdmin.from('exact_score_bets').delete().eq('user_id', userId),
        await ctx.supabaseAdmin.from('profiles').delete().eq('id', userId),
      ]

      const dependentError = dependentDeletes.find((result) => result.error)?.error

      if (dependentError) {
        return jsonResponse({ success: false, error: dependentError.message }, 500)
      }

      authDelete = await ctx.supabaseAdmin.auth.admin.deleteUser(userId, false)
    }

    if (authDelete.error) {
      return jsonResponse({ success: false, error: authDelete.error.message }, 500)
    }

    // En caso de que alguna relación no tenga ON DELETE CASCADE, limpiamos
    // cualquier fila pública que pudiera haber quedado atrás.
    const cleanup = [
      await ctx.supabaseAdmin.from('bets').delete().eq('user_id', userId),
      await ctx.supabaseAdmin.from('exact_score_bets').delete().eq('user_id', userId),
      await ctx.supabaseAdmin.from('profiles').delete().eq('id', userId),
    ]

    const cleanupError = cleanup.find((result) => result.error)?.error

    if (cleanupError) {
      return jsonResponse({
        success: false,
        error: `La cuenta de Auth se eliminó, pero quedó una fila pública sin limpiar: ${cleanupError.message}`,
      }, 500)
    }

    return jsonResponse({ success: true })
  } catch (error) {
    const message = error instanceof Error ? error.message : 'Error inesperado.'
    return jsonResponse({ success: false, error: message }, 500)
  }
})

Deno.serve(async (req) => {
  if (req.method === 'OPTIONS') {
    return new Response('ok', { headers: corsHeaders })
  }

  const response = await handler(req)
  const headers = new Headers(response.headers)

  for (const [key, value] of Object.entries(corsHeaders)) {
    headers.set(key, value)
  }

  return new Response(response.body, {
    status: response.status,
    statusText: response.statusText,
    headers,
  })
})
