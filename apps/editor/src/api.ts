// SPDX-License-Identifier: AGPL-3.0-only

import type {
  ConflictView,
  DiffFile,
  DraftSummary,
  FileOp,
  PageResponse,
  PreviewResponse,
  RegionChoice,
  RenameReport,
  TreeResponse,
} from './model.ts';

/** One resolution per conflicted file, as `POST draft/resolve` takes it. */
export type Resolution =
  | { path: string; take: 'keep-mine' | 'take-theirs' }
  | { path: string; choices: RegionChoice[] };

/** An error answer from the editor API, with its status and body. */
export class ApiError extends Error {
  constructor(
    readonly status: number,
    message: string,
    readonly body: Record<string, unknown>,
  ) {
    super(message);
    this.name = 'ApiError';
  }

  /** For a 409 on a stale `If-Match`: the draft's current version. */
  get current(): number | null {
    return typeof this.body.current === 'number' ? this.body.current : null;
  }
}

/** Calls `/api/editor/<org>/<space>/…` with the session cookie and the CSRF token. */
export class EditorApi {
  csrfToken = '';

  constructor(
    readonly org: string,
    readonly space: string,
  ) {}

  private url(action: string, query?: Record<string, string>): string {
    const base = `/api/editor/${encodeURIComponent(this.org)}/${encodeURIComponent(this.space)}/${action}`;
    return query ? `${base}?${new URLSearchParams(query).toString()}` : base;
  }

  private async call<T>(
    method: string,
    action: string,
    options: {
      query?: Record<string, string>;
      json?: unknown;
      body?: Blob;
      ifMatch?: number;
    } = {},
  ): Promise<T> {
    const headers: Record<string, string> = {};
    if (method !== 'GET') headers['x-csrf-token'] = this.csrfToken;
    if (options.ifMatch !== undefined) headers['if-match'] = String(options.ifMatch);
    let body: BodyInit | undefined;
    if (options.json !== undefined) {
      headers['content-type'] = 'application/json';
      body = JSON.stringify(options.json);
    } else if (options.body) {
      headers['content-type'] = options.body.type || 'application/octet-stream';
      body = options.body;
    }
    const response = await fetch(this.url(action, options.query), {
      method,
      headers,
      credentials: 'same-origin',
      ...(body !== undefined ? { body } : {}),
    });
    const text = await response.text();
    let parsed: Record<string, unknown> = {};
    try {
      parsed = text ? (JSON.parse(text) as Record<string, unknown>) : {};
    } catch {
      parsed = { error: text };
    }
    if (!response.ok) {
      const message = typeof parsed.error === 'string' ? parsed.error : `HTTP ${response.status}`;
      throw new ApiError(response.status, message, parsed);
    }
    return parsed as T;
  }

  async tree(): Promise<TreeResponse> {
    const tree = await this.call<TreeResponse>('GET', 'tree');
    this.csrfToken = tree.csrfToken;
    return tree;
  }

  page(path: string): Promise<PageResponse> {
    return this.call('GET', 'page', { query: { path } });
  }

  async draft(): Promise<DraftSummary | null> {
    return (await this.call<{ draft: DraftSummary | null }>('GET', 'draft')).draft;
  }

  async openDraft(): Promise<DraftSummary> {
    return (await this.call<{ draft: DraftSummary }>('POST', 'draft', { json: {} })).draft;
  }

  async diff(): Promise<DiffFile[]> {
    return (await this.call<{ files: DiffFile[] }>('GET', 'draft/diff')).files;
  }

  preview(path: string, content: string): Promise<PreviewResponse> {
    return this.call('POST', 'preview', { json: { path, content } });
  }

  async saveFile(
    ifMatch: number,
    file: { op: FileOp; path: string; baseBlobSha?: string | null; content: string },
  ): Promise<number> {
    const { baseBlobSha, ...rest } = file;
    const json = baseBlobSha ? { ...rest, baseBlobSha } : rest;
    return (await this.call<{ version: number }>('PUT', 'draft/file', { json, ifMatch })).version;
  }

  async revertFile(ifMatch: number, path: string): Promise<number> {
    return (
      await this.call<{ version: number }>('DELETE', 'draft/file', { query: { path }, ifMatch })
    ).version;
  }

  async upload(ifMatch: number, path: string, file: Blob): Promise<number> {
    return (
      await this.call<{ version: number }>('POST', 'upload', {
        query: { path },
        body: file,
        ifMatch,
      })
    ).version;
  }

  async discard(ifMatch: number): Promise<void> {
    await this.call('POST', 'draft/discard', { json: {}, ifMatch });
  }

  rename(ifMatch: number, from: string, to: string): Promise<RenameReport> {
    return this.call('POST', 'draft/rename', { json: { from, to }, ifMatch });
  }

  conflicts(): Promise<ConflictView> {
    return this.call('GET', 'draft/conflicts');
  }

  async resolve(ifMatch: number, head: string, resolutions: Resolution[]): Promise<DraftSummary> {
    return (
      await this.call<{ draft: DraftSummary }>('POST', 'draft/resolve', {
        json: { head, resolutions },
        ifMatch,
      })
    ).draft;
  }

  async propose(title: string, signOff: boolean): Promise<{ queued: boolean }> {
    return this.call('POST', 'draft/propose', { json: { title, signOff } });
  }
}
