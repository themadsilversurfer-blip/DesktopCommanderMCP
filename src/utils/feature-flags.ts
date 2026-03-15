import { logger } from './logger.js';

interface FeatureFlags {
  version?: string;
  flags?: Record<string, any>;
}

/**
 * Local-only feature flag manager.
 * All flags return safe defaults — no network calls.
 */
class FeatureFlagManager {
  private flags: Record<string, any> = {};

  async initialize(): Promise<void> {
    // Static defaults — no remote fetch
    this.flags = {};
    logger.info('Feature flags initialized (local defaults only)');
  }

  get(flagName: string, defaultValue: any = false): any {
    return this.flags[flagName] !== undefined ? this.flags[flagName] : defaultValue;
  }

  getAll(): Record<string, any> {
    return { ...this.flags };
  }

  async refresh(): Promise<boolean> {
    return true;
  }

  wasLoadedFromCache(): boolean {
    return false;
  }

  async waitForFreshFlags(): Promise<void> {
    // No-op — flags are always immediately available
  }

  destroy(): void {
    // No-op — no intervals to clean up
  }
}

// Export singleton instance
export const featureFlagManager = new FeatureFlagManager();
