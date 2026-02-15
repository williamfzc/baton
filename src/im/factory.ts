import type { BatonConfig } from '../config/types';
import type { RepoInfo } from '../types';
import type { IMAdapter } from './adapter';
import { IMPlatform } from './adapter';
import type { RepoManager } from '../core/repo';

export type IMAdapterFactory = (
  config: BatonConfig,
  selectedRepo: RepoInfo,
  repoManager: RepoManager
) => IMAdapter;

const registry = new Map<IMPlatform, IMAdapterFactory>();

export function registerIMAdapter(platform: IMPlatform, factory: IMAdapterFactory): void {
  registry.set(platform, factory);
}

export function createIMAdapter(
  platform: IMPlatform,
  config: BatonConfig,
  selectedRepo: RepoInfo,
  repoManager: RepoManager
): IMAdapter {
  const factory = registry.get(platform);
  if (!factory) {
    throw new Error(`IM adapter not registered: ${platform}`);
  }
  return factory(config, selectedRepo, repoManager);
}
