import { createRelayHandler, type RelayHandlerOptions } from './handler';
import type { CauceRelayer } from './relayer';

export type NextRouteHandler = (request: Request) => Promise<Response>;

export interface CauceRouteHandlers {
  GET: NextRouteHandler;
  POST: NextRouteHandler;
  OPTIONS: NextRouteHandler;
}

/**
 * Route handlers for the Next.js App Router. Mount them on a catch-all route:
 *
 * ```ts
 * // app/api/cauce/[...cauce]/route.ts
 * import { after } from 'next/server';
 * import { createCauceRouteHandlers } from '@cauce/server/next';
 * import { relayer } from '@/lib/cauce-relayer';
 *
 * export const runtime = 'nodejs';
 * export const { GET, POST, OPTIONS } = createCauceRouteHandlers(relayer, {
 *   waitUntil: (task) => after(task),
 * });
 * ```
 *
 * and point the client at it with `relayerUrl: '/api/cauce'` (absolute URL in createCauceConfig).
 */
export function createCauceRouteHandlers(
  relayer: CauceRelayer,
  options: RelayHandlerOptions = {},
): CauceRouteHandlers {
  const handler = createRelayHandler(relayer, options);
  const route: NextRouteHandler = (request) => handler(request);
  return { GET: route, POST: route, OPTIONS: route };
}
