import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { BridgeError } from './errors.js';
import type { WorkspaceConfig } from './types.js';

export class WorkspaceManager {
  private configPath: string;
  private config: WorkspaceConfig;

  constructor(customConfigPath?: string) {
    const home = os.homedir();
    const defaultDir = path.join(home, '.agy-lark');
    this.configPath = customConfigPath || path.join(defaultDir, 'workspace.json');
    this.config = this.loadConfig();
  }

  private loadConfig(): WorkspaceConfig {
    try {
      if (fs.existsSync(this.configPath)) {
        const raw = fs.readFileSync(this.configPath, 'utf8');
        const parsed = JSON.parse(raw);
        return {
          defaultRoot: parsed.defaultRoot || path.join(os.homedir(), 'project'),
          projects: parsed.projects || {},
        };
      }
    } catch {
      // Fallback on read or parse failure
    }

    const initial: WorkspaceConfig = {
      defaultRoot: path.join(os.homedir(), 'project'),
      projects: {},
    };
    this.saveConfig(initial);
    return initial;
  }

  private saveConfig(config: WorkspaceConfig): void {
    try {
      const dir = path.dirname(this.configPath);
      if (!fs.existsSync(dir)) {
        fs.mkdirSync(dir, { recursive: true });
      }
      fs.writeFileSync(this.configPath, JSON.stringify(config, null, 2), 'utf8');
    } catch (err: unknown) {
      const msg = err instanceof Error ? err.message : String(err);
      throw new BridgeError(
        'E_CONFIG_INVALID',
        `无法保存工作区配置至 ${this.configPath}: ${msg}`,
        '请检查目录写入权限'
      );
    }
  }

  public expandPath(p: string): string {
    if (p.startsWith('~')) {
      return path.join(os.homedir(), p.slice(1));
    }
    return path.resolve(p);
  }

  public getDefaultRoot(): string {
    return this.expandPath(this.config.defaultRoot);
  }

  public setDefaultRoot(newRoot: string): string {
    const resolved = this.expandPath(newRoot);
    if (!fs.existsSync(resolved)) {
      fs.mkdirSync(resolved, { recursive: true });
    }
    this.config.defaultRoot = resolved;
    this.saveConfig(this.config);
    return resolved;
  }

  public listProjects(): Record<string, string> {
    return { ...this.config.projects };
  }

  public getProjectPath(name: string): string | undefined {
    return this.config.projects[name];
  }

  public registerProject(name: string, projectPath: string): string {
    const resolved = this.expandPath(projectPath);
    if (!fs.existsSync(resolved)) {
      throw new BridgeError(
        'E_INVALID_WORKSPACE',
        `目标目录不存在: ${resolved}`,
        '请确认路径是否输入正确并已创建对应文件夹'
      );
    }
    this.config.projects[name] = resolved;
    this.saveConfig(this.config);
    return resolved;
  }

  public createProject(name: string, customParentDir?: string): string {
    if (!name || !/^[a-zA-Z0-9_\-\.]+$/.test(name)) {
      throw new BridgeError(
        'E_INVALID_WORKSPACE',
        `项目名称不合法: "${name}"`,
        '项目名称只能包含字母、数字、下划线、中划线和点'
      );
    }

    if (this.config.projects[name]) {
      throw new BridgeError(
        'E_PROJECT_EXISTS',
        `项目别名 "${name}" 已存在，对应目录: ${this.config.projects[name]}`,
        '请选择新的项目名称，或先使用 /bind 删除已有绑定'
      );
    }

    const parent = customParentDir ? this.expandPath(customParentDir) : this.getDefaultRoot();
    const newPath = path.join(parent, name);

    if (!fs.existsSync(newPath)) {
      fs.mkdirSync(newPath, { recursive: true });
    }

    this.config.projects[name] = newPath;
    this.saveConfig(this.config);
    return newPath;
  }

  public removeProject(name: string): boolean {
    if (!this.config.projects[name]) {
      return false;
    }
    delete this.config.projects[name];
    this.saveConfig(this.config);
    return true;
  }
}
