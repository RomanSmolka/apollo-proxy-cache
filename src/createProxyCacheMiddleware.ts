import crypto from 'crypto'
import { createProxyMiddleware, Options } from 'http-proxy-middleware'
import { parse } from 'graphql'
import { print } from 'graphql/language/printer'
import { hasDirectives } from 'apollo-utilities'
import type { Request, Response, NextFunction } from 'express'
import { decode } from './utils'
import type { Cache } from './caches/types'
import {
  calculateArguments,
  DIRECTIVE,
  removeCacheDirective,
  errorOnGet,
  errorOnSet,
  CacheKeyModifier,
} from './utils-browser-only'
const CACHE_HEADER = 'X-Proxy-Cached'
const CACHE_HASH_HEADER = 'X-Proxy-Hash'

type RequestWithCache = Request & { _hasCache: { id: string; timeout: number }, _bodyHash: string }

export const createProxyCacheMiddleware =
  <T extends Cache<string, any>>(
    queryCache: T,
    cacheKeyModifier?: CacheKeyModifier,
    cacheBypassHeader?: string,
    globalTimeout = 0
  ) => 
  (proxyConfig: Options) => {
    const directiveMiddleware = async (
      req: RequestWithCache,
      response: Response,
      next: NextFunction
    ) => {
      if (!req.body && req.method === 'POST') {
        console.warn(
          '[skip] proxy-cache-middleware, request.body is not populated. Please add "body-parser" middleware (or similar).'
        ) // eslint-disable-line
        return next()
      }
      if (!req.body.query) {
        return next()
      }
      const doc = parse(req.body.query)
      const isCache = hasDirectives([DIRECTIVE], doc)

      // we remove the @cache directive if it exists
      if (isCache) {
        try {
          const nextQuery = removeCacheDirective(doc)
          const { id, timeout } = calculateArguments(
            doc,
            req.body.variables,
            cacheKeyModifier,
            req
          )
          const possibleData = await queryCache.get(id)
          if (possibleData) {
            response.setHeader(CACHE_HEADER, 'true')
            return response.json({ data: possibleData })
          }
          req._hasCache = { id, timeout }
          // eslint-disable-next-line @typescript-eslint/no-extra-semi
          // could this be piped here (with req.pipe)
          req.body = { ...req.body, query: print(nextQuery) }
        } catch (e) {
          errorOnGet(e)
        }
      }
      next()
    }

    const hashMiddleware = async (
      req: RequestWithCache,
      response: Response,
      next: NextFunction
    ) => {
      if (!req.body && req.method === 'POST') {
        console.warn(
          '[skip] proxy-cache-middleware, request.body is not populated. Please add "body-parser" middleware (or similar).'
        ) // eslint-disable-line
        return next()
      }

      if (!req.body.query || (cacheBypassHeader && req.header(cacheBypassHeader))) {
        return next()
      }

      const bodyJson = JSON.stringify(req.body)
      const bodyHash = crypto.createHash('md5').update(bodyJson).digest('hex')
      req._bodyHash = bodyHash

      await queryCache.hset(
        bodyHash, 
        'lastRequested',
        new Date().toISOString(),
        globalTimeout
      )

      const cachedQuery = await queryCache.hget(bodyHash)
      
      if (cachedQuery && cachedQuery.response) {
        response.setHeader(CACHE_HEADER, 'true')
        response.setHeader(CACHE_HASH_HEADER, bodyHash)

        return response.json({ data: JSON.parse(cachedQuery.response) })
      }

      next()
    }

    const proxyMiddleware = createProxyMiddleware({
      ...proxyConfig,
      onProxyReq: (proxyReq, req, res) => {
        let data
        if (req.body) {
          // We have to rewrite the request body due to body-parser's removal of the content.
          data = JSON.stringify(req.body)
          proxyReq.setHeader('Content-Length', Buffer.byteLength(data))
        }
        if (proxyConfig.onProxyReq) {
          proxyConfig.onProxyReq(proxyReq, req, res)
        }
        // We write the data at the end in case something get's manipulated before.
        if (data) {
          proxyReq.write(data)
        }
      },
      onProxyRes: async (proxyRes, req, res) => {
        const hasCache = (req as RequestWithCache)._hasCache
        const bodyHash = (req as RequestWithCache)._bodyHash

        if (hasCache || bodyHash) {
          try {
            const response = JSON.parse(await decode(proxyRes))

            if (!response.errors && response.data) {
              if (bodyHash) {
                await queryCache.hset(bodyHash, 'request', JSON.stringify(req.body), globalTimeout)
                await queryCache.hset(bodyHash, 'response', JSON.stringify(response.data), globalTimeout)
              } else {
                await queryCache.set(hasCache.id, response.data, hasCache.timeout)
              }
            }
          } catch (e) {
            errorOnSet(e)
          }
        }
        if (proxyConfig.onProxyRes) {
          proxyConfig.onProxyRes(proxyRes, req, res)
        }
      },
    })

    return { proxyMiddleware, hashMiddleware, directiveMiddleware }
  }
