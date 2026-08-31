import { teraFlyResolver as teraflyInstance, TeraFlyResolver as TeraFlyResolverClass, TERAFLY_PUBLIC_ENDPOINT } from '../terafly/terafly.resolver';
import { config } from '../../config';

export const TERAFLY_WORKER_ENDPOINT = TERAFLY_PUBLIC_ENDPOINT;

export class TeraFlyResolver extends TeraFlyResolverClass {
  public isEnabled(): boolean {
    // If TERABOX_TERAFLY_ENABLED is explicitly false in config, treat as disabled; otherwise default to enabled
    if (typeof (config as any).TERABOX_TERAFLY_ENABLED === 'boolean' && !(config as any).TERABOX_TERAFLY_ENABLED) {
      return false;
    }
    return true;
  }
}

export const teraFlyResolver = new TeraFlyResolver();
