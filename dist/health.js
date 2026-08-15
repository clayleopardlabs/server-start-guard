/**
 * Well-known default ports for common dev servers, keyed loosely off the
 * command text. Deliberately inherited from the detection patterns; a
 * mismatch here only degrades the *health* signal (UNHEALTHY may report
 * against the wrong port once), never the rewrite itself.
 */
const PRESET_PORTS = [
    { pattern: /\bvite\b|sveltekit|svelte|astro\s+dev\b/i, url: "http://localhost:5173" },
    { pattern: /\bng\s+serve\b/i, url: "http://localhost:4200" },
    { pattern: /\bnext\s+dev\b|nuxt\b|create-react-app|react-scripts|webpack\b/i, url: "http://localhost:3000" },
    { pattern: /\buvicorn\b|\bgunicorn\b|flask\s+run|django[\w.:/-]*\s+runserver|manage\.py\s+runserver\b/i, url: "http://localhost:8000" },
    { pattern: /\bpython[\w.\s-]*-m\s+http\.server\b/i, url: "http://localhost:8000" },
    { pattern: /\bdotnet\s+run\b/i, url: "http://localhost:5000" },
    { pattern: /\bgo\s+run\s+[\w./\\-]*server\.go\b/i, url: "http://localhost:8080" },
];
/**
 * Resolve a health-check URL for a command, or undefined when nothing
 * sensible matches (the server will get PID/log monitoring only).
 */
export function resolveHealthUrl(command, cfg) {
    for (const rule of cfg.healthChecks) {
        if (rule.pattern && command.includes(rule.pattern))
            return rule.url;
    }
    if (!cfg.defaultHealthChecks)
        return undefined;
    for (const preset of PRESET_PORTS) {
        if (preset.pattern.test(command))
            return preset.url;
    }
    return undefined;
}
/**
 * Probe a URL with a hard wall-clock timeout. Resolves to the HTTP status
 * (2xx/3xx/4xx/5xx) when the server answers, or null when the connection
 * failed, the request timed out, or the host is unreachable. Treating
 * "reached a port" as success is deliberately NOT done: a bare TCP accept
 * with a 500 on every route is exactly the broken state we must flag.
 */
export async function httpStatus(url, timeoutMs) {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeoutMs);
    try {
        const res = await fetch(url, { signal: controller.signal, redirect: "follow" });
        return res.status;
    }
    catch {
        return null;
    }
    finally {
        clearTimeout(timer);
    }
}
//# sourceMappingURL=health.js.map