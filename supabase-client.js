import { createClient } from 'https://esm.sh/@supabase/supabase-js@2';
import { config } from './app-config.js';

export const supabase = createClient(config.supabase.url, config.supabase.publishableKey);

// Wraps supabase.functions.invoke(name, {body:{action, ...payload}}) and
// unwraps {data, error} into the same {status, message, data...} envelope
// every page's fetch() call sites already branch on (data.status === 'ok'),
// so no call-site branching logic needs to change — only the transport.
export async function callFn(name, action, payload) {
  const { data, error } = await supabase.functions.invoke(name, {
    body: { action, ...payload },
  });
  if (error) {
    // A non-2xx from the Edge Function itself (rare — every handler in this
    // codebase returns HTTP 200 with {status:'error',...} instead) or a
    // network failure. Surface it in the same envelope shape so callers
    // never need a separate error path.
    return { status: 'error', message: error.message || 'Request failed' };
  }
  return data;
}
