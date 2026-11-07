export const DENIAL_CODES = new Set([
  'ACCESS_DENIED', 'CAPTCHA', 'RATE_LIMITED', 'SESSION_EXPIRED', 'SESSION_INVALID'
]);

const RETRYABLE_STATUSES = new Set(['failed', 'partial', 'skipped', 'interrupted']);

export function runHasDenial(run) {
  return DENIAL_CODES.has(run?.stopReason) || (run?.tasks || []).some(task => DENIAL_CODES.has(task.cause?.code));
}

export function retryableTasks(run, today) {
  if (!run || ['running', 'stopping'].includes(run.status) || runHasDenial(run)) return [];
  return (run.tasks || []).filter(task => RETRYABLE_STATUSES.has(task.status) &&
    task.travelDate > today);
}
