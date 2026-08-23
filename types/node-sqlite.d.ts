// Minimal ambient types for node:sqlite -- @types/node is pinned to ^20 (see package.json), which
// predates this module's official type declarations even though the actual Node runtime (v24) has
// it natively. Only declares what scripts/sync-social-sentiment.ts actually uses; not a full
// surface. Remove this file once @types/node is upgraded past the version that ships real types.
declare module "node:sqlite" {
  export interface DatabaseSyncOptions {
    readOnly?: boolean;
    open?: boolean;
  }

  export interface StatementSync {
    all(...params: unknown[]): unknown[];
    get(...params: unknown[]): unknown;
    run(...params: unknown[]): { changes: number; lastInsertRowid: number | bigint };
  }

  export class DatabaseSync {
    constructor(path: string, options?: DatabaseSyncOptions);
    prepare(sql: string): StatementSync;
    exec(sql: string): void;
    close(): void;
  }
}
