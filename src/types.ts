export type Ref = { chunkId: string; quote: string };
export type Chunk = { id: string; materialName: string; location: string; text: string; page: number | null };
export type ProfileItem = { field: string; content: string; sourceType: string; refs: Ref[] };
export type Profile = { version: number; items: ProfileItem[]; confirmedAt: number | null; stale: boolean; demo: boolean };
export type Analysis = { reason: string; suggestion: string; uncertainty: string; refs: Ref[]; action: string };
export type Attempt = { id: string; text: string; operation: string; analysis?: Analysis };
export type Turn = { id: string; number: number; parentId: string | null; depth: number; role: string; dimension: string; question: string; refs: Ref[]; attempts: Attempt[] };
export type Finding = { id: string; turnId: string; attemptId: string; dimension: string; category: string; question: string; answer: string; reason: string; suggestion: string; uncertainty: string; criterion: string; refs: Ref[]; done: boolean; actionType: string; priority: string };
export type Session = { id: string; mode: string; demo: boolean; minutes: number; deadline: number; createdAt: number; status: string; version: number; turns: Turn[]; chunks: Chunk[]; error: string | null; target: string; report: { summary: string; coverage: Record<string, string>; findings: Finding[] } | null };
export type Project = { id: string; title: string; createdAt: number; materials: { id: string; name: string; pageCount: number; chunks: Chunk[]; warnings: string[] }[]; profile: Profile | null; sessions: Session[] };
export type ProjectBrief = { id: string; title: string; createdAt: number; updatedAt: number; materialCount: number; sessionCount: number };
export type Example = { id: string; title: string; tag: string; description: string };
export type Settings = { mode: string; baseUrl: string; model: string; hasKey: boolean; dataDirectory: string; version: string };
type Result<T> = { ok: true; value: T } | { ok: false; error: string };
declare global {
  interface Window { desktop: {
    request: (method: string, route: string, body?: unknown) => Promise<Result<unknown>>;
    importPdf: (projectId: string) => Promise<Result<Project | null>>;
    exportReport: (projectId: string, sessionId: string) => Promise<Result<boolean>>;
    settings: () => Promise<Result<Settings>>;
    saveSettings: (settings: unknown) => Promise<Result<Settings>>;
    testConnection: () => Promise<Result<{ ok: boolean; message: string }>>;
    openDataDirectory: () => Promise<Result<boolean>>;
    backup: () => Promise<Result<boolean>>;
    restore: () => Promise<Result<{ restored: number } | null>>;
  } }
}
export async function unwrap<T>(promise: Promise<Result<T>>): Promise<T> {
  const response = await promise;
  if (!response.ok) throw new Error(response.error);
  return response.value;
}
export async function api<T>(method: string, route: string, body?: unknown): Promise<T> {
  if (method === 'DELETE' && /^\/projects\/[a-f0-9]{32}$/.test(route)) {
    const project = await unwrap(window.desktop.request('GET', route)) as Project;
    const result = await unwrap(window.desktop.request(method, route, body));
    const prefixes = ['draft-' + project.id + '-', ...project.sessions.map(s => 'draft-' + s.id + '-')];
    for (const key of Object.keys(localStorage)) {
      if (prefixes.some(prefix => key.startsWith(prefix))) localStorage.removeItem(key);
    }
    return result as T;
  }
  return unwrap(window.desktop.request(method, route, body)) as Promise<T>;
}
