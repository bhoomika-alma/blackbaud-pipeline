import { createClient } from '@supabase/supabase-js'
import { getEnv } from './env'

const env = getEnv()

// Browser-side Supabase client (anon key, RLS-gated). Used for Storage uploads
// and for invoking Edge Functions. The frontend never talks to HubSpot directly.
export const supabase = createClient(env.supabaseUrl, env.supabaseAnonKey)

export const STORAGE_BUCKET = env.bucket
export const FUNCTIONS_URL = env.functionsUrl
