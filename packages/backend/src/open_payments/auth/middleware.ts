import {
  getKeyId,
  RequestLike,
  validateSignature
} from '@interledger/http-signature-utils'
import { Limits, parseLimits } from '../payment/outgoing/limits'
import {
  HttpSigContext,
  HttpSigWithAuthenticatedStatusContext,
  WalletAddressUrlContext
} from '../../app'
import {
  AccessItem,
  AccessAction,
  AccessType,
  JWKS,
  OpenPaymentsClientError
} from '@interledger/open-payments'
import { TokenInfo, isActiveTokenInfo } from 'token-introspection'
import { Config } from '../../config/app'
import { OpenPaymentsServerRouteError } from '../route-errors'

export type RequestAction = Exclude<AccessAction, 'read-all' | 'list-all'>
export const RequestAction: Record<string, RequestAction> = Object.freeze({
  Create: 'create',
  Read: 'read',
  Complete: 'complete',
  List: 'list'
})

export interface Grant {
  id: string
  limits?: Limits
}

export interface Access {
  type: string
  actions: AccessAction[]
  identifier: string
}

function contextToRequestLike(ctx: HttpSigContext): RequestLike {
  const url =
    Config.env === 'autopeer'
      ? ctx.href.replace('http://', 'https://')
      : ctx.href
  return {
    url,
    method: ctx.method,
    headers: ctx.headers ? JSON.parse(JSON.stringify(ctx.headers)) : undefined,
    body: ctx.request.body ? JSON.stringify(ctx.request.body) : undefined
  }
}

function toOpenPaymentsAccess(
  type: AccessType,
  action: RequestAction,
  identifier?: string
): AccessItem {
  return {
    type: type,
    actions: [action],
    identifier
  } as AccessItem
}

export function createTokenIntrospectionMiddleware({
  requestType,
  requestAction,
  bypassError = false
}: {
  requestType: AccessType
  requestAction: RequestAction
  bypassError?: boolean
}) {
  return async (
    ctx: WalletAddressUrlContext,
    next: () => Promise<void>
  ): Promise<void> => {
    const config = await ctx.container.use('config')
    try {
      const parts = ctx.request.headers.authorization?.split(' ')
      if (parts?.length !== 2 || parts[0] !== 'GNAP') {
        throw new OpenPaymentsServerRouteError(
          401,
          'Missing or invalid authorization header value'
        )
      }
      const token = parts[1]
      const tokenIntrospectionClient = await ctx.container.use(
        'tokenIntrospectionClient'
      )
      let tokenInfo: TokenInfo
      try {
        tokenInfo = await tokenIntrospectionClient.introspect({
          access_token: token,
          access: [
            toOpenPaymentsAccess(
              requestType,
              requestAction,
              ctx.walletAddressUrl
            )
          ]
        })
      } catch (err) {
        throw new OpenPaymentsServerRouteError(401, 'Invalid Token')
      }
      if (!isActiveTokenInfo(tokenInfo)) {
        throw new OpenPaymentsServerRouteError(403, 'Inactive Token')
      }

      if (tokenInfo.access.length !== 1) {
        throw new OpenPaymentsServerRouteError(
          403,
          'Token info access does not match request access'
        )
      }

      const access = tokenInfo.access[0]

      if (
        requestAction === AccessAction.Read &&
        (access as Access).actions.includes(AccessAction.ReadAll)
      ) {
        ctx.accessAction = AccessAction.ReadAll
      } else if (
        requestAction === AccessAction.List &&
        (access as Access).actions.includes(AccessAction.ListAll)
      ) {
        ctx.accessAction = AccessAction.ListAll
      } else {
        ctx.accessAction = requestAction
      }

      ctx.client = tokenInfo.client
      if (
        requestType === AccessType.OutgoingPayment &&
        requestAction === AccessAction.Create
      ) {
        ctx.grant = {
          id: tokenInfo.grant,
          limits:
            'limits' in access && access.limits
              ? parseLimits(access.limits)
              : undefined
        }
      }
    } catch (err) {
      if (!(err instanceof OpenPaymentsServerRouteError)) {
        throw err
      }

      ctx.set('WWW-Authenticate', `GNAP as_uri=${config.authServerGrantUrl}`)

      if (!bypassError) {
        throw err
      }
    }

    await next()
  }
}

export const authenticatedStatusMiddleware = async (
  ctx: HttpSigWithAuthenticatedStatusContext,
  next: () => Promise<unknown>
): Promise<void> => {
  ctx.authenticated = false
  try {
    await throwIfSignatureInvalid(ctx)
    ctx.authenticated = true
  } catch (err) {
    if (!(err instanceof OpenPaymentsServerRouteError)) {
      throw err
    }
  }
  await next()
}

export const throwIfSignatureInvalid = async (ctx: HttpSigContext) => {
  const keyId =
    ctx.request.headers['signature-input'] &&
    getKeyId(ctx.request.headers['signature-input'])

  if (!keyId) {
    throw new OpenPaymentsServerRouteError(
      401,
      'Signature validation error: missing keyId in signature input',
      { client: ctx.client }
    )
  }
  // TODO
  // cache client key(s)
  let jwks: JWKS
  try {
    const openPaymentsClient = await ctx.container.use('openPaymentsClient')
    jwks = await openPaymentsClient.walletAddress.getKeys({
      url: ctx.client
    })
  } catch (err) {
    throw new OpenPaymentsServerRouteError(
      401,
      'Signature validation error: could not retrieve client keys',
      {
        client: ctx.client,
        keyIdInSignature: keyId,
        requestedRoute: `${ctx.client}/jwks.json`,
        validationErrorsInRequest:
          err instanceof OpenPaymentsClientError
            ? err.validationErrors
            : undefined
      }
    )
  }
  const key = jwks.keys.find((key) => key.kid === keyId)
  if (!key) {
    throw new OpenPaymentsServerRouteError(
      401,
      'Signature validation error: could not find key in list of client keys',
      {
        client: ctx.client,
        keyIdInSignature: keyId,
        clientKeys: jwks.keys
      }
    )
  }

  const logger = await ctx.container.use('logger')

  let isValidSignature = false
  let requestLike: RequestLike | undefined

  try {
    requestLike = contextToRequestLike(ctx)
    isValidSignature = await validateSignature(key, requestLike)
  } catch (err) {
    logger.error(
      { err, requestLike },
      'Received unhandled error when trying to validate signature'
    )
  }

  if (!isValidSignature) {
    throw new OpenPaymentsServerRouteError(
      401,
      'Signature validation error: provided signature is invalid',
      {
        keyIdInSignature: keyId,
        client: ctx.client
      }
    )
  }
}

export const httpsigMiddleware = async (
  ctx: HttpSigContext,
  next: () => Promise<unknown>
): Promise<void> => {
  await throwIfSignatureInvalid(ctx)
  await next()
}
