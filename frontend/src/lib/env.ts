// Reads VITE_-prefixed config from the browser environment.
// Throws a clear error if a required variable is missing — see frontend/.env.example.

export interface FrontendEnv {
  supabaseUrl: string
  supabaseAnonKey: string
  bucket: string
  functionsUrl: string
}

function required(name: string, value: string | undefined): string {
  if (!value || value.trim() === '') {
    throw new Error(
      `Missing required environment variable: ${name}. Copy frontend/.env.example to frontend/.env and fill it in.`,
    )
  }
  return value
}

export function getEnv(): FrontendEnv {
  const supabaseUrl = required('VITE_SUPABASE_URL', import.meta.env.VITE_SUPABASE_URL)
  const supabaseAnonKey = required('VITE_SUPABASE_ANON_KEY', import.meta.env.VITE_SUPABASE_ANON_KEY)
  const bucket = import.meta.env.VITE_BB_UPLOADS_BUCKET?.trim() || 'bb-uploads'
  const functionsUrl =
    import.meta.env.VITE_FUNCTIONS_URL?.trim() || `${supabaseUrl.replace(/\/$/, '')}/functions/v1`
  return { supabaseUrl, supabaseAnonKey, bucket, functionsUrl }
}
