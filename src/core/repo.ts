/**
 * 仓库管理器
 * 负责递归扫描、发现和管理本地 git 仓库
 * 支持按深度扫描、目录过滤、名称/序号查找
 */
import * as fs from 'node:fs/promises';
import { Dirent } from 'node:fs';
import * as path from 'node:path';

export interface RepoInfo {
  name: string;
  path: string;
  gitPath: string;
}

const SKIP_DIRS = new Set([
  'node_modules',
  'dist',
  'build',
  'vendor',
  '__pycache__',
  '.git',
  '.venv',
  'venv',
  '.tox',
  'target',
  '.gradle',
  'out',
  'coverage',
  '.nyc_output',
]);

export class RepoManager {
  private repos: RepoInfo[] = [];
  private rootPath: string = '';

  async scanFromRoot(root: string): Promise<RepoInfo[]> {
    this.repos = [];
    // 规范化路径，去除 .. 和 .
    this.rootPath = path.resolve(root);

    // 首先检查根目录本身是否是 git 仓库
    const rootGitPath = path.join(root, '.git');
    try {
      const stat = await fs.stat(rootGitPath);
      if (stat.isDirectory()) {
        this.repos.push({
          name: path.basename(root),
          path: root,
          gitPath: rootGitPath,
        });
      }
    } catch {
      // 根目录不是 git 仓库，继续扫描子目录
    }

    await this.scanDirectory(root, 0);

    // 去重（防止根目录和子目录重复）
    const seen = new Set<string>();
    this.repos = this.repos.filter(repo => {
      if (seen.has(repo.path)) return false;
      seen.add(repo.path);
      return true;
    });

    this.repos.sort((a, b) => {
      const depthA = a.path.split(path.sep).length;
      const depthB = b.path.split(path.sep).length;
      if (depthA !== depthB) return depthA - depthB;
      return a.name.localeCompare(b.name);
    });

    return this.repos;
  }

  private async scanDirectory(dir: string, depth: number): Promise<void> {
    if (depth > 10) return;

    let entries: Dirent[];
    try {
      entries = await fs.readdir(dir, { withFileTypes: true });
    } catch {
      return;
    }

    for (const entry of entries) {
      if (entry.isDirectory() && !SKIP_DIRS.has(entry.name)) {
        const fullPath = path.join(dir, entry.name);
        const gitPath = path.join(fullPath, '.git');

        try {
          const stat = await fs.stat(gitPath);
          if (stat.isDirectory()) {
            this.repos.push({
              name: entry.name,
              path: fullPath,
              gitPath,
            });
            continue;
          }
        } catch {
          // .git 检查失败，继续扫描
        }

        await this.scanDirectory(fullPath, depth + 1);
      }
    }
  }

  findRepo(identifier: string): RepoInfo | null {
    const index = parseInt(identifier, 10);
    if (!isNaN(index) && index >= 0 && index < this.repos.length) {
      return this.repos[index];
    }

    const normalized = identifier.toLowerCase();
    return (
      this.repos.find(r => r.name.toLowerCase() === normalized) ||
      this.repos.find(r => r.path.toLowerCase().includes(normalized)) ||
      null
    );
  }

  getRepoByPath(targetPath: string): RepoInfo | null {
    return this.repos.find(r => r.path === targetPath) || null;
  }

  listRepos(): { index: number; name: string; path: string }[] {
    return this.repos.map((repo, index) => ({
      index,
      name: repo.name,
      path: this.getRelativePath(repo.path),
    }));
  }

  private getRelativePath(fullPath: string): string {
    if (!this.rootPath) return fullPath;

    if (fullPath.startsWith(this.rootPath)) {
      const relative = fullPath.slice(this.rootPath.length + 1);
      // 如果相对路径为空（即当前路径就是 rootPath），返回目录名而不是点号
      return relative || path.basename(this.rootPath);
    }

    return fullPath;
  }

  getAllRepos(): RepoInfo[] {
    return [...this.repos];
  }

  getRootPath(): string {
    return this.rootPath;
  }

  addRepo(repo: RepoInfo): void {
    // 检查是否已存在
    const exists = this.repos.some(r => r.path === repo.path);
    if (!exists) {
      this.repos.push(repo);
      // 重新排序
      this.repos.sort((a, b) => {
        const depthA = a.path.split(path.sep).length;
        const depthB = b.path.split(path.sep).length;
        if (depthA !== depthB) return depthA - depthB;
        return a.name.localeCompare(b.name);
      });
    }
  }
}
