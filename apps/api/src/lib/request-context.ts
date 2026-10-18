import { AsyncLocalStorage, AsyncResource } from 'node:async_hooks';
import type { FastifyInstance, FastifyRequest } from 'fastify';

/** Facts about the current request that code deep down may need, without passing them through every call. */
export type RequestContext = {
  /** Set when the request is authenticated with an API key rather than a person's sign-in. */
  apiKey?: { id: string; name: string };
};

const storage = new AsyncLocalStorage<RequestContext>();
const resources = new WeakMap<FastifyRequest, AsyncResource>();

export const requestContext = () => storage.getStore();

/**
 * Gives every request its own context. Fastify runs the later stages of a request (after
 * the body is read) from a different async context, so the request's one is re-entered
 * before validation; from there on it reaches the handler and everything it calls.
 */
export function registerRequestContext(app: FastifyInstance) {
  app.addHook('onRequest', (req, _reply, done) => {
    storage.run({}, () => {
      const resource = new AsyncResource('qra-request-context');
      resources.set(req, resource);
      resource.runInAsyncScope(done, req.raw);
    });
  });
  app.addHook('preValidation', (req, _reply, done) => {
    const resource = resources.get(req);
    if (resource) resource.runInAsyncScope(done, req.raw);
    else done();
  });
}
