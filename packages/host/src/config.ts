import 'dotenv/config';

export interface Config {
  /** WebSocket port the extension connects to. */
  hostPort: number;
  /** Chrome remote debugging port (Chrome must be started with --remote-debugging-port). */
  chromeDebugPort: number;
  /** TypeSafe System One (Jev) API key; empty string enables jev dry-run mode. */
  typesafeApiKey: string;
  /** TypeSafe API root; empty string → SDK default (https://api.typesafe.ai). */
  typesafeBaseUrl: string;
  /** TypeSafe model; empty string → SDK default (jev-latest). */
  typesafeModel: string;
  /** OpenAI-compatible quiz solver endpoint. */
  solverBaseUrl: string;
  solverApiKey: string;
  solverModel: string;
  /**
   * SAFETY: when false (default) the quiz loop never clicks submit/交卷 controls.
   */
  autoSubmit: boolean;
}

export interface FeatureFlags {
  /** true iff a TypeSafe API key is configured (live Jev decisions). */
  jevEnabled: boolean;
  /** true iff a solver API key is configured (live LLM answering). */
  solverEnabled: boolean;
}

function str(env: Record<string, string | undefined>, key: string, fallback = ''): string {
  const v = env[key];
  return v === undefined || v.trim() === '' ? fallback : v.trim();
}

function num(env: Record<string, string | undefined>, key: string, fallback: number): number {
  const v = Number(env[key]);
  return Number.isFinite(v) && v > 0 ? v : fallback;
}

function bool(env: Record<string, string | undefined>, key: string, fallback: boolean): boolean {
  const v = env[key];
  if (v === undefined || v.trim() === '') return fallback;
  return ['1', 'true', 'yes', 'on'].includes(v.trim().toLowerCase());
}

export function loadConfig(env: Record<string, string | undefined> = process.env): Config & FeatureFlags {
  const config: Config & FeatureFlags = {
    hostPort: num(env, 'HOST_WS_PORT', 8765),
    chromeDebugPort: num(env, 'CHROME_DEBUG_PORT', 9222),
    typesafeApiKey: str(env, 'TYPESAFE_API_KEY'),
    typesafeBaseUrl: str(env, 'TYPESAFE_BASE_URL'),
    typesafeModel: str(env, 'TYPESAFE_MODEL'),
    solverBaseUrl: str(env, 'SOLVER_BASE_URL', 'https://open.bigmodel.cn/api/paas/v4'),
    solverApiKey: str(env, 'SOLVER_API_KEY'),
    solverModel: str(env, 'SOLVER_MODEL', 'glm-4.5-flash'),
    autoSubmit: bool(env, 'AUTO_SUBMIT', false),
    jevEnabled: false,
    solverEnabled: false,
  };
  config.jevEnabled = config.typesafeApiKey !== '';
  config.solverEnabled = config.solverApiKey !== '';
  return config;
}
