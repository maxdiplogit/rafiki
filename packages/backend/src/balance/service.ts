import { Account, AccountFlags, Client } from 'tigerbeetle-node'
import { v4 as uuid } from 'uuid'

import { CreateBalanceError } from './errors'
import { BaseService } from '../shared/baseService'
import { uuidToBigInt } from '../shared/utils'

const ACCOUNT_RESERVED = Buffer.alloc(48)

// Credit and debit balances can both send and receive
// but are restricted by their respective Tigerbeetle flags.
// In Rafiki transfers:
// - the source account's debits increase
// - the destination account's credits increase
export enum BalanceType {
  Credit = 'Credit', // debits_must_not_exceed_credits
  Debit = 'Debit' // credits_must_not_exceed_debits
}

export interface BalanceOptions {
  type: BalanceType
  unit: number
}

export type Balance = BalanceOptions & {
  id: string
  balance: bigint
}

export interface BalanceService {
  create(balance: BalanceOptions): Promise<Balance>
  get(id: string): Promise<Balance | undefined>
}

interface ServiceDependencies extends BaseService {
  tigerbeetle: Client
}

export async function createBalanceService({
  logger,
  tigerbeetle
}: ServiceDependencies): Promise<BalanceService> {
  const log = logger.child({
    service: 'BalanceService'
  })
  const deps: ServiceDependencies = {
    logger: log,
    tigerbeetle
  }
  return {
    create: (balance) => createBalance(deps, balance),
    get: (id) => getBalance(deps, id)
  }
}

async function createBalance(
  deps: ServiceDependencies,
  { type, unit }: BalanceOptions
): Promise<Balance> {
  const id = uuid()
  const errors = await deps.tigerbeetle.createAccounts([
    {
      id: uuidToBigInt(id),
      user_data: BigInt(0),
      reserved: ACCOUNT_RESERVED,
      unit,
      code: 0,
      flags:
        type === BalanceType.Debit
          ? AccountFlags.credits_must_not_exceed_debits
          : AccountFlags.debits_must_not_exceed_credits,
      debits_accepted: BigInt(0),
      debits_reserved: BigInt(0),
      credits_accepted: BigInt(0),
      credits_reserved: BigInt(0),
      timestamp: 0n
    }
  ])
  if (errors.length) {
    throw new CreateBalanceError(errors[0].code)
  }
  return {
    id,
    unit,
    type,
    balance: BigInt(0)
  }
}

async function getBalance(
  deps: ServiceDependencies,
  id: string
): Promise<Balance | undefined> {
  const balance = (await deps.tigerbeetle.lookupAccounts([uuidToBigInt(id)]))[0]
  if (balance) {
    return {
      id,
      unit: balance.unit,
      type:
        balance.flags & AccountFlags.credits_must_not_exceed_debits
          ? BalanceType.Debit
          : BalanceType.Credit,
      balance: calculateBalance(deps, balance)
    }
  }
}

function calculateBalance(deps: ServiceDependencies, balance: Account): bigint {
  if (balance.flags & AccountFlags.credits_must_not_exceed_debits) {
    return (
      balance.debits_accepted -
      balance.credits_accepted +
      balance.debits_reserved
    )
  } else {
    if (!(balance.flags & AccountFlags.debits_must_not_exceed_credits)) {
      deps.logger.warn({ balance }, 'balance missing credit/debit flag')
    }
    return (
      balance.credits_accepted -
      balance.debits_accepted -
      balance.debits_reserved
    )
  }
}
