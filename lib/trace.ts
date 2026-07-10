// lib/trace.ts
// Captures everything written to console.{log,warn,error} while an async function runs and
// returns it as structured log lines. This lets the /debug/trace endpoint hand the user the
// EXACT internal trace of a real pipeline run — the queries, URLs, params, raw result counts
// and ranking decisions the engine logged — in a copy-pasteable, log-style format.
//
// NOTE: console is a global, so any other request executing during the capture window is also
// recorded into the buffer. This is a developer-only diagnostic tool meant to be run ad hoc on
// a quiet instance, not a production-traffic logger.

export interface LogLine {
  t: string;                         // ISO timestamp
  level: 'log' | 'warn' | 'error';
  msg: string;
}

type Level = LogLine['level'];

function format(args: unknown[]): string {
  return args
    .map(a => {
      if (typeof a === 'string') return a;
      try { return JSON.stringify(a); } catch { return String(a); }
    })
    .join(' ');
}

export async function captureConsole<T>(
  fn: () => Promise<T>,
): Promise<{ result: T; logs: LogLine[] }> {
  const logs: LogLine[] = [];
  const original: Record<Level, (...a: any[]) => void> = {
    log:   console.log,
    warn:  console.warn,
    error: console.error,
  };

  const patch = (level: Level) => (...args: any[]) => {
    logs.push({ t: new Date().toISOString(), level, msg: format(args) });
    original[level](...args); // still print to the real server console
  };

  console.log = patch('log');
  console.warn = patch('warn');
  console.error = patch('error');

  try {
    const result = await fn();
    return { result, logs };
  } finally {
    console.log = original.log;
    console.warn = original.warn;
    console.error = original.error;
  }
}
