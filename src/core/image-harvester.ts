import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';

export interface ImageHarvesterOptions {
  conversationId?: string;
  cwd: string;
  startedAt: number;
  extensions?: string[];
  fileStableMs?: number;
}

export class ImageHarvester {
  private conversationId?: string;
  private cwd: string;
  private startedAt: number;
  private extensions: string[];
  private fileStableMs: number;
  private intervalTimer: NodeJS.Timeout | null = null;
  private stableKey = '';
  private stableSince = 0;
  private harvested = new Set<string>();

  constructor(opts: ImageHarvesterOptions) {
    this.conversationId = opts.conversationId;
    this.cwd = opts.cwd;
    this.startedAt = opts.startedAt;
    this.extensions = (opts.extensions || ['.png', '.jpg', '.jpeg', '.webp', '.gif']).map((e) => e.toLowerCase());
    this.fileStableMs = opts.fileStableMs || 1500;
  }

  public setConversationId(id: string): void {
    this.conversationId = id;
  }

  private getSearchDirectories(): string[] {
    const dirs: string[] = [this.cwd];
    const home = os.homedir();
    const brainBase = path.join(home, '.gemini', 'antigravity-cli', 'brain');
    const scratchBase = path.join(home, '.gemini', 'antigravity-cli', 'scratch');

    if (this.conversationId) {
      dirs.push(path.join(brainBase, this.conversationId));
      dirs.push(path.join(brainBase, this.conversationId, 'scratch'));
    }
    dirs.push(scratchBase);
    return dirs.filter((d) => fs.existsSync(d));
  }

  public scanFreshImages(): Array<{ filePath: string; size: number }> {
    const searchDirs = this.getSearchDirectories();
    const hits: Array<{ filePath: string; size: number }> = [];

    for (const dir of searchDirs) {
      try {
        const entries = fs.readdirSync(dir, { withFileTypes: true });
        for (const entry of entries) {
          if (!entry.isFile()) continue;
          const ext = path.extname(entry.name).toLowerCase();
          if (!this.extensions.includes(ext)) continue;

          const fullPath = path.join(dir, entry.name);
          const stat = fs.statSync(fullPath);
          // mtime must be >= startedAt (give 500ms grace for clock skew)
          if (stat.mtimeMs >= this.startedAt - 500 && stat.size > 0) {
            hits.push({ filePath: fullPath, size: stat.size });
          }
        }
      } catch {
        // Skip inaccessible dirs
      }
    }

    return hits;
  }

  public startPolling(onStableImages: (paths: string[]) => void): void {
    this.stopPolling();
    this.intervalTimer = setInterval(() => {
      const hits = this.scanFreshImages();
      if (hits.length === 0) {
        this.stableKey = '';
        this.stableSince = 0;
        return;
      }

      const currentKey = hits
        .map((h) => `${h.filePath}:${h.size}`)
        .sort()
        .join('|');

      if (currentKey !== this.stableKey) {
        this.stableKey = currentKey;
        this.stableSince = Date.now();
        return;
      }

      if (Date.now() - this.stableSince >= this.fileStableMs) {
        const newPaths: string[] = [];
        for (const hit of hits) {
          if (!this.harvested.has(hit.filePath)) {
            this.harvested.add(hit.filePath);
            newPaths.push(hit.filePath);
          }
        }
        if (newPaths.length > 0) {
          onStableImages(newPaths);
        }
      }
    }, 500);
  }

  public stopPolling(): void {
    if (this.intervalTimer) {
      clearInterval(this.intervalTimer);
      this.intervalTimer = null;
    }
  }

  public harvestFinal(): string[] {
    this.stopPolling();
    const hits = this.scanFreshImages();
    const finalPaths: string[] = [];
    for (const hit of hits) {
      if (!this.harvested.has(hit.filePath)) {
        this.harvested.add(hit.filePath);
        finalPaths.push(hit.filePath);
      }
    }
    return finalPaths;
  }
}
