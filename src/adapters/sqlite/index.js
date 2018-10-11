// @flow
/* eslint-disable global-require */

import { NativeModules, Platform } from 'react-native'
import {
  connectionTag,
  type ConnectionTag,
  logger,
  isDevelopment,
  invariant,
} from '../../utils/common'

import type Model, { RecordId } from '../../Model'
import type Query from '../../Query'
import type { TableName, AppSchema, SchemaVersion } from '../../Schema'
import type { SchemaMigrations } from '../../Schema/migrations'
import type { DatabaseAdapter, CachedQueryResult, CachedFindResult, BatchOperation } from '../type'
import {
  type DirtyFindResult,
  type DirtyQueryResult,
  sanitizeFindResult,
  sanitizeQueryResult,
  devLogFind,
  devLogQuery,
  devLogCount,
  devLogBatch,
  devLogSetUp,
  validateAdapter,
} from '../common'

import encodeQuery from './encodeQuery'
import encodeUpdate from './encodeUpdate'
import encodeInsert from './encodeInsert'

export type SQL = string
export type SQLiteArg = string | boolean | number | null
export type SQLiteQuery = [SQL, SQLiteArg[]]

type NativeBridgeBatchOperation =
  | ['execute', SQL, SQLiteArg[]]
  | ['create', RecordId, SQL, SQLiteArg[]]
  | ['markAsDeleted', TableName<any>, RecordId]
  | ['destroyPermanently', TableName<any>, RecordId]
// | ['setLocal', string, string]
// | ['removeLocal', string]

type InitializeStatus =
  | { code: 'ok' | 'schema_needed' }
  | { code: 'migrations_needed', databaseVersion: SchemaVersion }

type NativeBridgeType = {
  setUp: (ConnectionTag, string, SQL, SchemaVersion) => Promise<void>, // TODO: Remove me
  initialize: (ConnectionTag, string, SchemaVersion) => Promise<InitializeStatus>,
  setUpWithSchema: (ConnectionTag, string, SQL, SchemaVersion) => Promise<void>,
  setUpWithMigrations: (ConnectionTag, string, SQL, SchemaVersion, SchemaVersion) => Promise<void>,
  find: (ConnectionTag, TableName<any>, RecordId) => Promise<DirtyFindResult>,
  query: (ConnectionTag, SQL) => Promise<DirtyQueryResult>,
  count: (ConnectionTag, SQL) => Promise<number>,
  batch: (ConnectionTag, NativeBridgeBatchOperation[]) => Promise<void>,
  getDeletedRecords: (ConnectionTag, TableName<any>) => Promise<RecordId[]>,
  destroyDeletedRecords: (ConnectionTag, TableName<any>, RecordId[]) => Promise<void>,
  unsafeResetDatabase: (ConnectionTag, SQL, SchemaVersion) => Promise<void>,
  getLocal: (ConnectionTag, string) => Promise<?string>,
  setLocal: (ConnectionTag, string, string) => Promise<void>,
  removeLocal: (ConnectionTag, string) => Promise<void>,
  unsafeClearCachedRecords: ConnectionTag => Promise<void>,
}
const Native: NativeBridgeType = NativeModules.DatabaseBridge

export type SQLiteAdapterOptions = $Exact<{
  dbName: string,
  schema: AppSchema,
  migrationsExperimental?: SchemaMigrations,
}>

export default class SQLiteAdapter implements DatabaseAdapter {
  schema: AppSchema

  migrations: ?SchemaMigrations

  _tag: ConnectionTag = connectionTag()

  constructor({ dbName, schema, migrationsExperimental }: SQLiteAdapterOptions): void {
    this.schema = schema
    this.migrations = migrationsExperimental
    isDevelopment && validateAdapter(this)

    devLogSetUp(() => this._init(dbName))
  }

  async _init(dbName: string): Promise<void> {
    // TODO: Temporary, remove me after Android is updated
    if (Platform.OS === 'ios') {
      // Try to initialize the database with just the schema number. If it matches the database,
      // we're good. If not, we try again, this time sending the compiled schema or a migration set
      // This is to speed up the launch (less to do and pass through bridge), and avoid repeating
      // migration logic inside native code
      const status = await Native.initialize(this._tag, dbName, this.schema.version)

      if (status.code === 'schema_needed') {
        logger.log('[DB] Database needs setup. Setting up schema.')
        await Native.setUpWithSchema(this._tag, dbName, this._encodedSchema(), this.schema.version)
      } else if (status.code === 'migrations_needed') {
        logger.log('[DB] Database needs migrations')
        const { databaseVersion } = status
        invariant(databaseVersion > 0, 'Invalid database schema version')
        // TODO: Apply migrations
        await Native.setUpWithSchema(this._tag, dbName, this._encodedSchema(), this.schema.version)
      } else {
        invariant(status.code === 'ok', 'Invalid database initialization status')
      }
    } else {
      await Native.setUp(this._tag, dbName, this._encodedSchema(), this.schema.version)
    }
  }

  async find(table: TableName<any>, id: RecordId): Promise<CachedFindResult> {
    return devLogFind(
      async () =>
        sanitizeFindResult(await Native.find(this._tag, table, id), this.schema.tables[table]),
      table,
      id,
    )
  }

  async query<T: Model>(query: Query<T>): Promise<CachedQueryResult> {
    return devLogQuery(
      async () =>
        sanitizeQueryResult(
          await Native.query(this._tag, encodeQuery(query)),
          this.schema.tables[query.table],
        ),
      query,
    )
  }

  async count<T: Model>(query: Query<T>): Promise<number> {
    return devLogCount(() => Native.count(this._tag, encodeQuery(query, true)), query)
  }

  async batch(operations: BatchOperation[]): Promise<void> {
    await devLogBatch(async () => {
      await Native.batch(
        this._tag,
        operations.map(([type, record]) => {
          switch (type) {
            case 'create':
              return ['create', record.id, ...encodeInsert(record)]
            case 'markAsDeleted':
              return ['markAsDeleted', record.table, record.id]
            case 'destroyPermanently':
              return ['destroyPermanently', record.table, record.id]
            default:
              // case 'update':
              return ['execute', ...encodeUpdate(record)]
          }
        }),
      )
    }, operations)
  }

  getDeletedRecords(table: TableName<any>): Promise<RecordId[]> {
    return Native.getDeletedRecords(this._tag, table)
  }

  destroyDeletedRecords(table: TableName<any>, recordIds: RecordId[]): Promise<void> {
    return Native.destroyDeletedRecords(this._tag, table, recordIds)
  }

  async unsafeResetDatabase(): Promise<void> {
    // TODO: Temporary, remove me after Android is updated
    if (Platform.OS === 'ios') {
      await Native.unsafeResetDatabase(this._tag, this._encodedSchema(), this.schema.version)
    } else {
      // $FlowFixMe
      await Native.unsafeResetDatabase(this._tag)
    }
    logger.log('[DB] Database is now reset')
  }

  getLocal(key: string): Promise<?string> {
    return Native.getLocal(this._tag, key)
  }

  setLocal(key: string, value: string): Promise<void> {
    return Native.setLocal(this._tag, key, value)
  }

  removeLocal(key: string): Promise<void> {
    return Native.removeLocal(this._tag, key)
  }

  unsafeClearCachedRecords(): Promise<void> {
    return Native.unsafeClearCachedRecords(this._tag)
  }

  _encodedSchema(): SQL {
    const encodeSchema = require('./encodeSchema').default
    return encodeSchema(this.schema)
  }
}
