class RestTimestamp {
  constructor(value) {
    this.rawValue = typeof value === 'string' ? value : null;
    this.value = value instanceof Date ? value : new Date(value);
  }

  static fromDate(value) {
    return new RestTimestamp(value);
  }

  static fromISOString(value) {
    return new RestTimestamp(value);
  }

  toDate() {
    return new Date(this.value.getTime());
  }

  toISOString() {
    return this.rawValue || this.value.toISOString();
  }
}

const SERVER_TIMESTAMP = Object.freeze({ __firestoreServerTimestamp: true });

const RestFieldValue = Object.freeze({
  serverTimestamp() {
    return SERVER_TIMESTAMP;
  }
});

function encodePath(path) {
  return String(path).split('/').map(encodeURIComponent).join('/');
}

function encodeValue(value) {
  if (value === SERVER_TIMESTAMP) {
    return { timestampValue: new Date().toISOString() };
  }
  if (value instanceof RestTimestamp) {
    return { timestampValue: value.toISOString() };
  }
  if (value instanceof Date) {
    return { timestampValue: value.toISOString() };
  }
  if (value instanceof RestDocumentReference) {
    return { referenceValue: value.database.documentName(value.path) };
  }
  if (value === null) return { nullValue: null };
  if (typeof value === 'string') return { stringValue: value };
  if (typeof value === 'boolean') return { booleanValue: value };
  if (typeof value === 'number') {
    return Number.isInteger(value)
      ? { integerValue: String(value) }
      : { doubleValue: value };
  }
  if (Array.isArray(value)) {
    return {
      arrayValue: {
        values: value.filter(item => item !== undefined).map(encodeValue)
      }
    };
  }
  if (value && typeof value === 'object') {
    return { mapValue: { fields: encodeFields(value) } };
  }
  throw new TypeError(`Unsupported Firestore value: ${typeof value}`);
}

function encodeFields(data) {
  const fields = {};
  for (const [key, value] of Object.entries(data || {})) {
    if (value !== undefined) fields[key] = encodeValue(value);
  }
  return fields;
}

function decodeValue(value) {
  if (!value || Object.hasOwn(value, 'nullValue')) return null;
  if (Object.hasOwn(value, 'stringValue')) return value.stringValue;
  if (Object.hasOwn(value, 'booleanValue')) return value.booleanValue;
  if (Object.hasOwn(value, 'integerValue')) return Number(value.integerValue);
  if (Object.hasOwn(value, 'doubleValue')) return Number(value.doubleValue);
  if (Object.hasOwn(value, 'timestampValue')) return new RestTimestamp(value.timestampValue);
  if (Object.hasOwn(value, 'bytesValue')) return value.bytesValue;
  if (Object.hasOwn(value, 'referenceValue')) return value.referenceValue;
  if (Object.hasOwn(value, 'geoPointValue')) return value.geoPointValue;
  if (Object.hasOwn(value, 'arrayValue')) {
    return (value.arrayValue.values || []).map(decodeValue);
  }
  if (Object.hasOwn(value, 'mapValue')) {
    return decodeFields(value.mapValue.fields || {});
  }
  return null;
}

function decodeFields(fields) {
  const data = {};
  for (const [key, value] of Object.entries(fields || {})) {
    data[key] = decodeValue(value);
  }
  return data;
}

class RestDocumentSnapshot {
  constructor(reference, document) {
    this.ref = reference;
    this.id = reference.id;
    this.exists = Boolean(document);
    this.document = document;
  }

  data() {
    return this.exists ? decodeFields(this.document.fields || {}) : undefined;
  }

  get updateTime() {
    return this.document?.updateTime
      ? new RestTimestamp(this.document.updateTime)
      : null;
  }
}

class RestQuerySnapshot {
  constructor(documents) {
    this.docs = documents;
    this.size = documents.length;
    this.empty = documents.length === 0;
  }

  forEach(callback) {
    this.docs.forEach(callback);
  }
}

class RestDocumentReference {
  constructor(database, path) {
    this.database = database;
    this.path = path;
    this.id = path.split('/').at(-1);
  }

  collection(name) {
    return new RestCollectionReference(this.database, `${this.path}/${name}`);
  }

  async get() {
    const document = await this.database.getDocument(this.path);
    return new RestDocumentSnapshot(this, document);
  }

  set(data, options = {}) {
    return this.database.setDocument(this.path, data, Boolean(options.merge));
  }

  update(data, precondition = {}) {
    return this.database.setDocument(this.path, data, true, precondition);
  }

  delete() {
    return this.database.deleteDocument(this.path);
  }
}

class RestQuery {
  constructor(
    database,
    path,
    filters = [],
    orderings = [],
    resultLimit = null,
    startAfterValues = []
  ) {
    this.database = database;
    this.path = path;
    this.filters = filters;
    this.orderings = orderings;
    this.resultLimit = resultLimit;
    this.startAfterValues = startAfterValues;
  }

  where(fieldPath, operator, value) {
    return new RestQuery(
      this.database,
      this.path,
      [...this.filters, { fieldPath, operator, value }],
      this.orderings,
      this.resultLimit,
      this.startAfterValues
    );
  }

  orderBy(fieldPath, direction = 'asc') {
    return new RestQuery(
      this.database,
      this.path,
      this.filters,
      [...this.orderings, { fieldPath, direction }],
      this.resultLimit,
      this.startAfterValues
    );
  }

  limit(value) {
    return new RestQuery(
      this.database,
      this.path,
      this.filters,
      this.orderings,
      Number(value),
      this.startAfterValues
    );
  }

  startAfter(...values) {
    return new RestQuery(
      this.database,
      this.path,
      this.filters,
      this.orderings,
      this.resultLimit,
      values
    );
  }

  get() {
    return this.database.runQuery(
      this.path,
      this.filters,
      this.orderings,
      this.resultLimit,
      this.startAfterValues
    );
  }
}

class RestCollectionReference extends RestQuery {
  doc(id) {
    return new RestDocumentReference(this.database, `${this.path}/${id}`);
  }

  async add(data) {
    const reference = this.doc(crypto.randomUUID());
    await reference.set(data);
    return reference;
  }

  get() {
    if (this.filters.length || this.orderings.length || this.resultLimit !== null) {
      return super.get();
    }
    return this.database.listCollection(this.path);
  }
}

class RestWriteBatch {
  constructor(database) {
    this.database = database;
    this.writes = [];
  }

  delete(reference, precondition = {}) {
    const write = { delete: this.database.documentName(reference.path) };
    if (precondition.lastUpdateTime) {
      write.currentDocument = {
        updateTime: precondition.lastUpdateTime instanceof RestTimestamp
          ? precondition.lastUpdateTime.toISOString()
          : new Date(precondition.lastUpdateTime).toISOString()
      };
    }
    this.writes.push(write);
    return this;
  }

  async commit() {
    await this.database.commit(this.writes);
    return [];
  }
}

class RestBulkWriter {
  constructor(database) {
    this.database = database;
    this.writes = [];
  }

  delete(reference) {
    this.writes.push({ delete: this.database.documentName(reference.path) });
  }

  set(reference, data, options = {}) {
    const write = {
      update: {
        name: this.database.documentName(reference.path),
        fields: encodeFields(data)
      }
    };
    if (options.merge) {
      write.updateMask = { fieldPaths: Object.keys(data) };
    }
    this.writes.push(write);
  }

  async close() {
    for (let offset = 0; offset < this.writes.length; offset += 500) {
      await this.database.commit(this.writes.slice(offset, offset + 500));
    }
  }
}

const QUERY_OPERATORS = Object.freeze({
  '==': 'EQUAL',
  '!=': 'NOT_EQUAL',
  '<': 'LESS_THAN',
  '<=': 'LESS_THAN_OR_EQUAL',
  '>': 'GREATER_THAN',
  '>=': 'GREATER_THAN_OR_EQUAL',
  'array-contains': 'ARRAY_CONTAINS',
  in: 'IN',
  'not-in': 'NOT_IN',
  'array-contains-any': 'ARRAY_CONTAINS_ANY'
});

class FirestoreRestDatabase {
  constructor(firebaseApp, projectId) {
    this.firebaseApp = firebaseApp;
    this.projectId = projectId;
    this.databaseRoot = `projects/${projectId}/databases/(default)`;
    this.apiRoot = `https://firestore.googleapis.com/v1/${this.databaseRoot}`;
  }

  collection(name) {
    return new RestCollectionReference(this, name);
  }

  batch() {
    return new RestWriteBatch(this);
  }

  bulkWriter() {
    return new RestBulkWriter(this);
  }

  documentName(path) {
    return `${this.databaseRoot}/documents/${path}`;
  }

  async accessToken() {
    const token = await this.firebaseApp.options.credential.getAccessToken();
    return token.access_token;
  }

  async request(url, options = {}, allowNotFound = false) {
    const token = await this.accessToken();
    const response = await fetch(url, {
      ...options,
      headers: {
        Authorization: `Bearer ${token}`,
        'Content-Type': 'application/json',
        ...(options.headers || {})
      }
    });

    if (allowNotFound && response.status === 404) return null;
    if (!response.ok) {
      const message = await response.text();
      throw new Error(`Firestore REST ${response.status}: ${message}`);
    }
    if (response.status === 204) return null;
    return response.json();
  }

  getDocument(path) {
    return this.request(
      `${this.apiRoot}/documents/${encodePath(path)}`,
      {},
      true
    );
  }

  async listCollection(path) {
    const documents = [];
    let pageToken = '';
    do {
      const query = new URLSearchParams({ pageSize: '1000' });
      if (pageToken) query.set('pageToken', pageToken);
      const result = await this.request(
        `${this.apiRoot}/documents/${encodePath(path)}?${query}`
      );
      documents.push(...(result.documents || []));
      pageToken = result.nextPageToken || '';
    } while (pageToken);

    return new RestQuerySnapshot(documents.map(document => {
      const id = document.name.split('/').at(-1);
      return new RestDocumentSnapshot(
        new RestDocumentReference(this, `${path}/${id}`),
        document
      );
    }));
  }

  async setDocument(path, data, merge, precondition = {}) {
    const query = new URLSearchParams();
    if (merge) {
      for (const fieldPath of Object.keys(data)) {
        query.append('updateMask.fieldPaths', fieldPath);
      }
    }
    if (precondition.lastUpdateTime) {
      const updateTime = precondition.lastUpdateTime instanceof RestTimestamp
        ? precondition.lastUpdateTime.toISOString()
        : new Date(precondition.lastUpdateTime).toISOString();
      query.set('currentDocument.updateTime', updateTime);
    } else if (typeof precondition.exists === 'boolean') {
      query.set('currentDocument.exists', String(precondition.exists));
    }
    const suffix = query.size ? `?${query}` : '';
    return this.request(`${this.apiRoot}/documents/${encodePath(path)}${suffix}`, {
      method: 'PATCH',
      body: JSON.stringify({ fields: encodeFields(data) })
    });
  }

  async deleteDocument(path) {
    await this.request(`${this.apiRoot}/documents/${encodePath(path)}`, {
      method: 'DELETE'
    }, true);
  }

  async getAll(...references) {
    if (references.length === 0) return [];
    const result = await this.request(`${this.apiRoot}/documents:batchGet`, {
      method: 'POST',
      body: JSON.stringify({ documents: references.map(ref => this.documentName(ref.path)) })
    });
    const found = new Map(
      result.filter(item => item.found).map(item => [item.found.name, item.found])
    );
    return references.map(reference => new RestDocumentSnapshot(
      reference,
      found.get(this.documentName(reference.path)) || null
    ));
  }

  async runQuery(path, filters, orderings, resultLimit, startAfterValues = []) {
    const segments = path.split('/');
    const collectionId = segments.at(-1);
    const parentPath = segments.slice(0, -1).join('/');
    const structuredQuery = { from: [{ collectionId }] };

    if (filters.length) {
      const fieldFilters = filters.map(filter => ({
        fieldFilter: {
          field: { fieldPath: filter.fieldPath },
          op: QUERY_OPERATORS[filter.operator],
          value: encodeValue(filter.value)
        }
      }));
      structuredQuery.where = fieldFilters.length === 1
        ? fieldFilters[0]
        : { compositeFilter: { op: 'AND', filters: fieldFilters } };
    }
    if (orderings.length) {
      structuredQuery.orderBy = orderings.map(ordering => ({
        field: { fieldPath: ordering.fieldPath },
        direction: ordering.direction.toLowerCase() === 'desc' ? 'DESCENDING' : 'ASCENDING'
      }));
    }
    if (resultLimit !== null) structuredQuery.limit = resultLimit;
    if (startAfterValues.length) {
      structuredQuery.startAt = {
        values: startAfterValues.map(encodeValue),
        before: false
      };
    }

    const parentSuffix = parentPath ? `/${encodePath(parentPath)}` : '';
    const result = await this.request(
      `${this.apiRoot}/documents${parentSuffix}:runQuery`,
      { method: 'POST', body: JSON.stringify({ structuredQuery }) }
    );
    const documents = result.filter(item => item.document).map(item => item.document);
    return new RestQuerySnapshot(documents.map(document => {
      const id = document.name.split('/').at(-1);
      return new RestDocumentSnapshot(
        new RestDocumentReference(this, `${path}/${id}`),
        document
      );
    }));
  }

  async commit(writes) {
    if (writes.length === 0) return;
    await this.request(`${this.apiRoot}/documents:commit`, {
      method: 'POST',
      body: JSON.stringify({ writes })
    });
  }
}

function createFirestoreRest(firebaseApp, projectId) {
  return new FirestoreRestDatabase(firebaseApp, projectId);
}

module.exports = {
  createFirestoreRest,
  FieldValue: RestFieldValue,
  Timestamp: RestTimestamp
};
