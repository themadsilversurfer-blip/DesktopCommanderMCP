import { ServerResult } from '../types.js';
import { e2eObserver } from '../tools/e2e-observer.js';

export async function handleE2EObserver(args: unknown): Promise<ServerResult> {
    return e2eObserver(args);
}
