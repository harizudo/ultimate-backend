import { DocumentCollection, EdgeCollection } from 'arangojs';
import { CacheStore, Logger } from '@nestjs/common';
import { ArangoCollectionProps, ArangoDBSource, ArangoIndexDefinition } from '../interfaces';
import { DataEvents } from '@juicycleff/nest-multi-tenant/enums';
import {
  COLLECTION_KEY,
  FindRequest,
  POST_KEY,
  PRE_KEY,
  TenantData,
  UpdateByIdRequest,
  UpdateRequest,
} from '@juicycleff/nest-multi-tenant/interfaces';
import { cleanEmptyProperties } from '@graphqlcqrs/common';
import { InsertOptions, UpdateOptions } from 'arangojs/lib/cjs/util/types';
import { aql, AqlQuery } from 'arangojs/lib/cjs/aql-query';
import { ArrayCursor } from 'arangojs/lib/cjs/cursor';
import { QueryOptions } from 'arangojs/lib/cjs/database';
import { arangoQueryBuilder } from '@ultimatebackend/contracts/utils';

// that class only can be extended
export class BaseArangoRepository <DOC, DTO = DOC> {
  // @ts-ignore
  collection: Promise<DocumentCollection<DOC> | EdgeCollection<DOC>>;
  readonly options: ArangoCollectionProps;
  readonly tenant: TenantData;
  readonly cacheStore: CacheStore;
  logger = new Logger(this.constructor.name);

  /**
   * Creates an instance of BaseMongoRepository.
   * @param {DBSource} dbSource Your MongoDB connection
   * @param cacheStore
   * @param opts
   * @param tenantData
   * @memberof BaseMongoRepository
   */
  constructor(public dbSource: ArangoDBSource, cacheStore?: CacheStore, opts?: ArangoCollectionProps, tenantData?: TenantData) {
    this.options = Object.assign({}, opts, Reflect.getMetadata(COLLECTION_KEY, this));
    if (!this.options.name) {
      throw new Error('No name was provided for this collection');
    }

    // Assign tenant DI
    if (tenantData) {
      this.tenant = tenantData;
    }

    // Assign cache DI
    if (cacheStore) {
      this.cacheStore = cacheStore;
    }
    this.collection = this.getCollection();
  }

  /**
   * Finds a record by id
   *
   * @param {string} id
   * @returns {Promise<DOC>}
   * @memberof BaseMongoRepository
   */
  async findById(id: string): Promise<DOC> {
    const condition = { _id: id, tenantId: this.tenant?.tenantId };
    return await this.findOne(condition);
  }

  /**
   * Find multiple documents by a list of ids
   *
   * @param {string[]} ids
   * @returns {Promise<T[]>}
   * @memberof BaseMongoRepository
   */
  async findManyById(ids: string[]): Promise<DOC[]> {
    const query = { _id: { $in: ids.map(id => id) } };

    const cacheKey = JSON.stringify(query);
    const cachedResult = await this.retrieveFromCache(cacheKey);
    if (Array.isArray(cachedResult)) {
      return cachedResult;
    }

    const found = await this.runManyByIdQuery(ids);

    const results: DOC[] = [];
    for (const result of found) {
      results.push(await this.invokeEvents(POST_KEY, ['FIND', 'FIND_MANY'], this.toggleId(result, false)));
    }

    await this.saveToCache(cacheKey, results);
    return results;
  }

  /**
   * Finds a record by a list of conditions
   *
   * @param {object} conditions
   * @returns {Promise<DOC>}
   * @memberof BaseMongoRepository
   */
  async findOne(conditions: object): Promise<DOC> {
    const cleanConditions = cleanEmptyProperties({ ...conditions, tenantId: this.tenant?.tenantId });
    const prunedConditions = this.toggleId(cleanConditions, true) as any;

    const cacheKey = JSON.stringify(prunedConditions);
    const cachedResult = await this.retrieveFromCache(cacheKey);
    if (!Array.isArray(cachedResult)) {
      return cachedResult;
    }

    let document = await this.runFindQuery(prunedConditions, { toObject: true });
    if (document) {
      document = this.toggleId(document, false) as any;
      document = await this.invokeEvents(POST_KEY, ['FIND', 'FIND_ONE'], document);
      await this.saveToCache(cacheKey, document);
      return document;
    }
  }

  /**
   * Finds a record by a list of conditions
   *
   * @returns {Promise<DOC>}
   * @memberof BaseMongoRepository
   * @param q
   * @param bindVars
   * @param opts
   */
  async query(q: string | AqlQuery, opts?: QueryOptions): Promise<ArrayCursor> {
    const db = await this.dbSource.db;

    // const cacheKey = JSON.stringify(q);
    // const cachedResult = await this.retrieveFromCache(cacheKey);
    // if (cachedResult) {
      // return cachedResult as any;
    // }

    let result;
    if (typeof q === 'string') {
      result = await db.query(q, opts);
    } else {
      result = await db.query(q, opts);
    }

    // await this.saveToCache(cacheKey, result);
    return result;
  }

  /**
   * Find records by a list of conditions
   *
   * @param {FindRequest} [req={ conditions: {} }]
   * @returns {Promise<T[]>}
   * @memberof BaseMongoRepository
   */
  async find(req: FindRequest = { conditions: {} }): Promise<DOC[]> {
    const collection = await this.collection;

    const cleanConditions = cleanEmptyProperties({ ...req.conditions, tenantId: this.tenant?.tenantId });
    const conditions = this.toggleId(cleanConditions as any, true) as any;

    const cacheKey = JSON.stringify(conditions) + JSON.stringify(req);
    const cachedResult = await this.retrieveFromCache(cacheKey);
    if (Array.isArray(cachedResult)) {
      return cachedResult;
    }

    let cursor = await collection.firstExample(conditions);

    if (req.projection) {
      cursor = cursor.project(req.projection);
    }

    if (req.sort) {
      cursor = cursor.sort(req.sort);
    }

    if (req.skip) {
      cursor = cursor.skip(req.skip);
    }

    if (req.limit) {
      cursor = cursor.limit(req.limit);
    }

    const newDocuments = await cursor.toArray();
    const results = [];

    for (let document of newDocuments) {
      document = this.toggleId(document, false) as any;
      document = await this.invokeEvents(POST_KEY, ['FIND', 'FIND_MANY'], document);
      results.push(document);
    }

    // Save to cache
    await this.saveToCache(cacheKey, results);

    return results;
  }

  /**
   * Create a document of type T
   *
   * @param {DTO} document
   * @param opts
   * @returns {Promise<DOC>}
   * @memberof BaseMongoRepository
   */
  async create(document: Partial<DTO> | DTO, opts?: InsertOptions): Promise<DOC> {
    const collection = await this.collection;
    const eventResult: unknown = await this.invokeEvents(PRE_KEY, ['SAVE', 'CREATE'], document);
    // @ts-ignore
    const cleanDoc = cleanEmptyProperties({ ...eventResult, tenantId: this.tenant?.tenantId });
    let newDocument = await collection.save(cleanDoc, { ...opts, returnNew: true});
    // @ts-ignore
    newDocument = this.toggleId(newDocument, false);
    newDocument = await this.invokeEvents(POST_KEY, ['SAVE', 'CREATE'], newDocument);
    // @ts-ignore
    return newDocument;
  }

  /**
   * Create a document of type T
   *
   * @param {DTO} document
   * @param _from
   * @param _to
   * @param opts
   * @returns {Promise<DOC>}
   * @memberof BaseMongoRepository
   */
  // tslint:disable-next-line:variable-name
  async createEdge(document: Partial<DTO> | DTO, _from: string, _to: string, opts?: InsertOptions): Promise<DOC> {
    const collection = await this.collection as EdgeCollection;
    const eventResult: unknown = await this.invokeEvents(PRE_KEY, ['SAVE', 'CREATE'], document);
    // @ts-ignore
    const cleanDoc = cleanEmptyProperties({ ...eventResult, tenantId: this.tenant?.tenantId });
    let newDocument = await collection.save(cleanDoc, _from, _to, { ...opts, returnNew: true});
    // @ts-ignore
    newDocument = this.toggleId(newDocument, false);
    newDocument = await this.invokeEvents(POST_KEY, ['SAVE', 'CREATE'], newDocument);
    // @ts-ignore
    return newDocument;
  }

  /**
   * Save any changes to your document
   *
   * @param {Document} document
   * @param options
   * @returns {Promise<DOC>}
   * @memberof BaseMongoRepository
   */
  async save(document: Document, options?: UpdateOptions): Promise<DOC> {
    const collection = await this.collection;

    // @ts-ignore
    const id = document.id;  // flip/flop ids

    const updates = await this.invokeEvents(PRE_KEY, ['SAVE'], document);
    delete updates.id;
    delete updates._id;
    const query = { _id: id };
    let newDocument = await collection.update(query, updates, { ...options, overwrite: true, returnNew: true });

    // project new items
    if (newDocument) {
      Object.assign(document, newDocument);
    }

    // @ts-ignore
    newDocument.id = id; // flip flop ids back
    // @ts-ignore
    delete newDocument._id;

    newDocument = await this.invokeEvents(POST_KEY, ['SAVE'], newDocument);
    return newDocument;
  }

  /**
   * Save any changes to your document
   *
   * @returns {Promise<DOC>}
   * @memberof BaseMongoRepository
   * @param documents
   * @param opts
   */
  async createMany(documents: Partial<DTO[]> | DTO[], opts?: InsertOptions): Promise<DOC[]> {
    const collection = await this.collection;

    const unSavedDocs = [];
    for (const document of documents) {
      const eventResult: unknown = await this.invokeEvents(PRE_KEY, ['SAVE', 'CREATE'], document);
      // @ts-ignore
      const cleanDoc = cleanEmptyProperties({ ...eventResult, tenantId: this.tenant?.tenantId });
      unSavedDocs.push(cleanDoc);
    }

    let newDocuments = await collection.save(unSavedDocs, { ...opts, returnNew: true });
    newDocuments = this.toggleId(newDocuments, false);
    newDocuments = await this.invokeEvents(POST_KEY, ['SAVE', 'CREATE'], newDocuments);

    return newDocuments;
  }

  /**
   * Find a record by ID and update with new values
   *
   * @param {string} id
   * @param {UpdateByIdRequest} req
   * @returns {Promise<DOC>}
   * @memberof BaseMongoRepository
   */
  async findOneByIdAndUpdate(id: string, req: UpdateByIdRequest): Promise<DOC> {
    const conditions = cleanEmptyProperties({ _id: id, tenantId: this.tenant?.tenantId });
    return this.findOneAndUpdate({
      conditions,
      updates: req.updates,
      upsert: req.upsert,
    });
  }

  /**
   * Find a record and update with new values
   *
   * @param {UpdateRequest} req
   * @returns {Promise<DOC>}
   * @memberof BaseMongoRepository
   */
  async findOneAndUpdate(req: UpdateRequest): Promise<DOC> {
    const collection = await this.collection;
    const updates = await this.invokeEvents(PRE_KEY, ['UPDATE', 'UPDATE_ONE'], req.updates);

    const conditions = cleanEmptyProperties({ ...req.conditions, tenantId: this.tenant?.tenantId });
    const res = await collection.updateByExample(conditions, updates);

    let document = res.value as any;
    document = this.toggleId(document, false);
    document = await this.invokeEvents(POST_KEY, ['UPDATE', 'UPDATE_ONE'], document);
    return document;
  }

  /**
   * Delete a record by ID
   *
   * @param {string} id
   * @returns {Promise<DeleteWriteOpResultObject>}
   * @memberof BaseMongoRepository
   */
  async deleteOneById(id: string): Promise<DOC> {
    const collection = await this.collection;
    const conditions = cleanEmptyProperties({ _id: id, tenantId: this.tenant?.tenantId });
    return await collection.removeByExample(conditions);
  }

  /**
   * Delete a record
   *
   * @param {*} conditions
   * @returns {Promise<DeleteWriteOpResultObject>}
   * @memberof BaseMongoRepository
   */
  async deleteOne(conditions: any): Promise<DOC> {
    const collection = await this.collection;
    const cleanConditions = cleanEmptyProperties({ ...conditions, tenantId: this.tenant?.tenantId });

    await this.invokeEvents(PRE_KEY, ['DELETE', 'DELETE_ONE'], conditions);
    const deleteResult = await collection.removeByExample(cleanConditions);
    await this.invokeEvents(POST_KEY, ['DELETE', 'DELETE_ONE'], deleteResult);

    return deleteResult;
  }

  /**
   * Delete multiple records
   *
   * @param {*} conditions
   * @returns {Promise<any>}
   * @memberof BaseMongoRepository
   */
  async deleteMany(conditions: any): Promise<DOC[]> {
    const collection = await this.collection;
    const cleanConditions = cleanEmptyProperties({ ...conditions, tenantId: this.tenant?.tenantId });

    await this.invokeEvents(PRE_KEY, ['DELETE_ONE', 'DELETE_MANY'], cleanConditions);
    const deleteResult = await collection.removeByExample(cleanConditions);
    await this.invokeEvents(POST_KEY, ['DELETE_ONE', 'DELETE_MANY'], deleteResult);

    return deleteResult;
  }

  /**
   * Delete multiple records
   *
   * @param {*} conditions
   * @returns {Promise<any>}
   * @memberof BaseMongoRepository
   */
  public async exist(conditions: any): Promise<boolean> {
    const cleanConditions = cleanEmptyProperties({ ...conditions, tenantId: this.tenant?.tenantId });
    const collection = await this.collection;

    return await collection.exists();
  }

  /**
   * Delete multiple records
   *
   * @returns {Promise<any>}
   * @memberof BaseArangoRepository
   * @param key
   */
  public async documentExist(key: string): Promise<boolean> {
    const collection = await this.collection;
    return await collection.documentExists(key);
  }

  /**
   * Strip off Mongo's ObjectID and replace with string representation or in reverse
   *
   * @private
   * @param {*} document
   * @param {boolean} replace
   * @returns {T}
   * @memberof BaseMongoRepository
   */
  protected toggleId(document: any | any[], replace: boolean): DOC | DOC[] {
    if (Array.isArray(document)) {
      const docs: any[] = [];
      for (const doc of document) {
        if (doc && (doc.id || doc._id)) {
          if (replace) {
            doc._id = doc.id;
            delete doc.id;
          } else {
            doc.id = doc._id;
            delete doc._id;
          }
        }
        docs.push(doc);
      }
      return docs;
    }

    if (document && (document.id || document._id)) {
      if (replace) {
        document._id = document.id;
        delete document.id;
      } else {
        document.id = document._id;
        delete document._id;
      }
    }
    return document;
  }

  /**
   * Return a collection
   * If the collection doesn't exist, it will create it with the given options
   *
   * @private
   * @returns {Promise<Collection<DOC>>}
   * @memberof BaseMongoRepository
   */
  // @ts-ignore
  private getCollection(): Promise<DocumentCollection<DOC> | EdgeCollection<DOC>> {
    // @ts-ignore
    return new Promise<DocumentCollection<DOC> | EdgeCollection<DOC>>(async (resolve, reject) => {
      const db = await this.dbSource.db;

      if (! this.options.edgeType) {
        const ourCollection = await db.collection(this.options.name);
        const exists = await ourCollection.exists();

        if (!exists) {
          this.logger.log( 'create document collection => ' + this.options.name);
          await ourCollection.create();
        }

        if (this.options.indexes) {
          for (const indexDefinition of this.options.indexes) {
            try {
              await this.ensureIndex(indexDefinition, ourCollection);
            } catch (indexErr) {
              // tslint:disable-next-line:no-console
              console.log(indexErr);
              if (
                this.options.overwrite &&
                this.options.name &&
                indexErr.name === 'MongoError' &&
                (indexErr.codeName === 'IndexKeySpecsConflict' || indexErr.codeName === 'IndexOptionsConflict')
              ) {
                // drop index and recreate
                try {
                  await ourCollection.dropIndex(indexDefinition.opts.name);
                  await this.ensureIndex(indexDefinition, ourCollection);
                } catch (recreateErr) {
                  reject(recreateErr);
                }
              } else {
                reject(indexErr);
              }
            }
          }
        }

      } else {
        const ourCollection = await db.edgeCollection(this.options.name);
        const exists = await ourCollection.exists();

        if (!exists) {
          this.logger.log( 'create document edge collection => ' + this.options.name);
          await ourCollection.create();
        }

        if (this.options.indexes) {
          for (const indexDefinition of this.options.indexes) {
            try {
              await this.ensureIndex(indexDefinition, ourCollection);
            } catch (indexErr) {
              // tslint:disable-next-line:no-console
              console.log(indexErr);
              if (
                this.options.overwrite &&
                this.options.name &&
                indexErr.name === 'MongoError' &&
                (indexErr.codeName === 'IndexKeySpecsConflict' || indexErr.codeName === 'IndexOptionsConflict')
              ) {
                // drop index and recreate
                try {
                  await ourCollection.dropIndex(indexDefinition.opts.name);
                  await this.ensureIndex(indexDefinition, ourCollection);
                } catch (recreateErr) {
                  reject(recreateErr);
                }
              } else {
                reject(indexErr);
              }
            }
          }
        }
      }
    });
  }

  async ensureIndex(indexDefinition: ArangoIndexDefinition, ourCollection: DocumentCollection | EdgeCollection) {
    if (indexDefinition.type === 'hash') {
      await ourCollection.createHashIndex(indexDefinition.fields, indexDefinition.opts);
    } else if (indexDefinition.type === 'fulltext') {
      await ourCollection.createFulltextIndex(indexDefinition.fields, indexDefinition.minLength);
    } else if (indexDefinition.type === 'geo') {
      await ourCollection.createGeoIndex(indexDefinition.fields, indexDefinition.opts);
    } else if (indexDefinition.type === 'persistent') {
      await ourCollection.createPersistentIndex(indexDefinition.fields, indexDefinition.opts);
    } else if (indexDefinition.type === 'skiplist') {
      await ourCollection.createSkipList(indexDefinition.fields, indexDefinition.opts);
    } else if (indexDefinition.type === 'ttl') {
      throw new Error('Not implemented');
    }
  }

  /**
   * Apply functions to a record based on the type of event
   *
   * @private
   * @param {string} type any of the valid types, PRE_KEY POST_KEY
   * @param {string[]} fns any of the valid functions: update, updateOne, save, create, find, findOne, findMany
   * @param {*} document The document to apply functions to
   * @returns {Promise<DOC>}
   * @memberof BaseMongoRepository
   */
  private async invokeEvents(type: string, fns: DataEvents[], document: any | any[]): Promise<any> {
    const test = Reflect.getMetadata('entity', this) || [];
    if (Array.isArray(document)) {
      const docs: any[] = [];
      for (let doc of document) {
        for (const fn of fns) {
          const events = Reflect.getMetadata(`${type}_${fn}`, this) || [];
          for (const event of events) {
            doc = event.bind(this)(document);
            if (doc !== undefined && typeof doc.then === 'function') {
              doc = await doc;
            }
            docs.push(doc);
          }
        }
      }
      return docs;
    }

    for (const fn of fns) {
      const events = Reflect.getMetadata(`${type}_${fn}`, this) || [];
      for (const event of events) {
        document = event.bind(this)(document);
        if (document !== undefined && typeof document.then === 'function') {
          document = await document;
        }
      }
    }

    return document;
  }

  public count() {
    // this._count = count;
    return this;
  }

  public initTenantKeys() {
    // TODO: Initialize tenant data isolation
  }

  public onSave(): { createdAt: string; updatedAt: string } {
    return {
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
    };
  }

  public onUpdate(): any {
    return {
      $set: {
        updatedAt: new Date().toISOString(),
      },
    };
  }

  private async saveToCache(key: string, data: DOC | any): Promise<DOC|any> {
    if (this.cacheStore) {
      const cacheKey = `${this.options.name}/${key}`;
      await this.cacheStore.set<DOC>(cacheKey, data);
    }
  }

  private async runFindQuery(conditions: any, options?: QueryArgsOptions): Promise<DOC | any | DOC[]> {
    const db = await this.dbSource.db;

    const query = this.parseFindQuery(arangoQueryBuilder(conditions, this.options.name, true));
    const cursor = await db.query(query, {
      count: options.count,
      batchSize: options.limit || 50,
      cache: options.cache,
    });

    if (options.toObject) {
      return await cursor.next() as DOC;
    } else {
      if (await cursor.hasNext()) {
        return await cursor.nextBatch() as DOC[];
      }
    }
  }

  private async runOneQuery(conditions: any, options?: QueryArgsOptions): Promise<DOC | any | DOC[]> {
    const db = await this.dbSource.db;
    const query = this.parseOneQuery(conditions);

    const cursor = await db.query(query, {
      count: options.count,
      batchSize: options.limit || 50,
      cache: options.cache,
    });

    if (options.toObject) {
      return await cursor.next() as DOC;
    } else {
      if (await cursor.hasNext()) {
        return await cursor.nextBatch() as DOC[];
      }
    }
  }

  private async runManyByIdQuery(ids: any, options?: QueryArgsOptions): Promise<DOC | any | DOC[]> {
    const db = await this.dbSource.db;
    const query = this.parseFindQuery(`doc._id IN ${ids}`);

    const cursor = await db.query(query, {
      count: options.count,
      batchSize: options.limit || 50,
      cache: options.cache,
    });

    if (options.toObject) {
      return await cursor.next() as DOC;
    } else {
      if (await cursor.hasNext()) {
        return await cursor.nextBatch() as DOC[];
      }
    }
  }

  private parseFindQuery(query?: string): AqlQuery {

    if (query) {
      return {
        query: `
          FOR doc IN @@collection
            FILTER ${query}
            RETURN doc
        `,
        bindVars: {
          '@@collection': this.options.name,
        },
      };
    }

    return {
      query: `
          FOR doc IN @@collection
            RETURN doc
        `,
      bindVars: {
        '@@collection': this.options.name,
      },
    };
  }

  private parseOneQuery(query: string): AqlQuery {

    if (!query) {
      return null;
    }

    return aql`RETURN DOCUMENT(${this.options.name}, ${query})`;
  }

  private parseDeleteQuery(query: string): AqlQuery {

    if (!query) {
      return null;
    }

    return aql`
      FOR doc IN ${this.options.name}
        REPLACE doc._key
        WITH { replaced: true }
        OPTIONS { exclusive: true }
        RETURN OLD
    `;
  }

  private async retrieveFromCache(key: string): Promise<DOC | any | DOC[]> {
    if (this.cacheStore) {
      const cacheKey = `${this.options.name}/${key}`;
      const cacheData = await this.cacheStore.get<DOC>(cacheKey);

      if (cacheData !== undefined && typeof cacheData !== 'undefined') {
        return cacheData;
      }
    }
  }
}

interface QueryArgsOptions {
  toObject?: boolean;
  returnNew?: boolean;
  count?: boolean;
  cache?: boolean;
  limit?: number;
}
