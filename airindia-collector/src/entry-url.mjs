export const DEFAULT_ENTRY_URL = 'https://www.airindia.com/';

export function resolveEntryUrl(value = process.env.AIRINDIA_ENTRY_URL ?? DEFAULT_ENTRY_URL) {
  let url;
  try { url = new URL(value); }
  catch { throw new Error('--entry-url must be an Air India HTTPS URL (AIRINDIA_ENTRY_URL uses the same rules)'); }
  if (url.protocol !== 'https:' || !['airindia.com', 'www.airindia.com'].includes(url.hostname) ||
      url.username || url.password || url.port || url.hash ||
      [...url.searchParams].some(([key, content]) => key !== 'ai_pc' || !/^[a-z0-9_-]{1,64}$/i.test(content)) ||
      url.searchParams.getAll('ai_pc').length > 1)
    throw new Error('--entry-url must be an Air India HTTPS URL with no credentials, port, fragment, or query other than ai_pc (AIRINDIA_ENTRY_URL uses the same rules)');
  return url.href;
}
