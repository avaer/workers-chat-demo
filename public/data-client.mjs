import {zbencode, zbdecode} from "./encoding.mjs";
import {UPDATE_METHODS} from "./update-types.js";
import {parseUpdateObject, makeId} from "./util.mjs";

//

const convertValToCrdtVal = val => {
  const startEpoch = 0;
  const crdtVal = {};
  for (const k in val) {
    const v = val[k];
    crdtVal[k] = [startEpoch, v];
  }
  return crdtVal;
}
const convertCrdtValToVal = crdtVal => {
  const val = {};
  for (const k in crdtVal) {
    const [epoch, v] = crdtVal[k];
    val[k] = v;
  }
  return val;
}

const convertMapToObject = map => {
  const o = {};
  for (const [key, val] of map) {
    o[key] = val;
  }
  return o;
};
const convertObjectToMap = map => {
  const o = new Map();
  for (const key in map) {
    const val = map[key];
    o.set(key, val);
  }
  return o;
};

//

export class DCMap extends EventTarget {
  constructor(arrayId, arrayIndexId, dataClient) {
    super();

    this.arrayId = arrayId;
    this.arrayIndexId = arrayIndexId;
    this.dataClient = dataClient;

    this.cleanupFn = null;
  }
  getRawObject() {
    return this.dataClient.crdt.get(this.arrayIndexId);
  }
  toObject() {
    const object = this.getRawObject();
    // console.log('to object', object);
    if (object) {
      const result = {};
      for (const key in object) {
        const [epoch, val] = object[key];
        result[key] = val;
      }
      return result;
    } else {
      return {};
    }
  }
  getKey(key) {
    const object = this.getRawObject();
    if (object) {
      const valSpec = object[key];
      if (valSpec !== undefined) {
        const [epoch, val] = valSpec;
        return val;
      } else {
        return undefined;
      }
    } else {
      return undefined;
    }
  }
  getEpoch(key) {
    const object = this.getRawObject();
    if (object) {
      const valSpec = object[key];
      if (valSpec !== undefined) {
        const [epoch, val] = valSpec;
        return epoch;
      } else {
        return 0;
      }
    } else {
      return 0;
    }
  }

  // client
  setKeyEpochValue(key, epoch, val) {
    let object = this.getRawObject();
    if (!object) {
      object = {};
      this.dataClient.crdt.set(this.arrayIndexId, object);
    }
    if (object[key]) {
      object[key][0] = epoch;
      object[key][1] = val;
    } else {
      object[key] = [epoch, val];
    }
  }

  setKeyValueUpdate(key, val) {
    const oldEpoch = this.getEpoch(key);
    const newEpoch = oldEpoch + 1;
    this.setKeyEpochValue(key, newEpoch, val);

    return new MessageEvent('set.' + this.arrayId + '.' + this.arrayIndexId, {
      data: {
        key,
        epoch: newEpoch,
        val,
      }
    });
  }
  setKeyEpochValueUpdate(key, epoch, val) {
    this.setKeyEpochValue(key, epoch, val);

    return new MessageEvent('set.' + this.arrayId + '.' + this.arrayIndexId, {
      data: {
        key,
        epoch,
        val,
      }
    });
  }
  removeUpdate() {
    this.dataClient.crdt.delete(this.arrayIndexId);

    let array = this.dataClient.crdt.get(this.arrayId);
    if (!array) {
      throw new Error('remove from nonexistent array!');
    }
    delete array[this.arrayIndexId];
    
    return new MessageEvent('remove.' + this.arrayId, {
      data: {
        arrayIndexId: this.arrayIndexId,
      },
    });
  }

  // server
  trySetKeyEpochValue(key, epoch, val) {
    let object = this.getRawObject();
    if (!object) {
      object = {};
      this.dataClient.crdt.set(this.arrayIndexId, object);
    }

    const oldEpoch = object[key] ? object[key][0] : 0;
    if (epoch > oldEpoch) {
      if (object[key]) {
        object[key][0] = epoch;
        object[key][1] = val;
      } else {
        object[key] = [epoch, val];
      }
      return undefined;
    } else {
      return object[key];
    }
  }
  listen() {
    const setKey = 'set.' + this.arrayId + '.' + this.arrayIndexId;
    // console.log('map listen', setKey);
    const setFn = e => {
      // console.log('map set fn', setKey, e.data);
      const {key, epoch, val} = e.data;
      // console.log('capture set data 1', e.data);
      this.dispatchEvent(new MessageEvent('update', {
        data: {
          key,
          epoch,
          val,
        },
      }));
      // console.log('capture set data 2', e.data);
    };
    this.dataClient.addEventListener(setKey, setFn);

    const removeKey = 'remove.' + this.arrayId;
    const removeFn = e => {
      const {arrayIndexId} = e.data;
      // console.log('player check remove', arrayIndexId, this.arrayIndexId);
      if (arrayIndexId === this.arrayIndexId) {
        this.dispatchEvent(new MessageEvent('remove', {
          data: {
            arrayIndexId,
          },
        }));
      }
    };
    this.dataClient.addEventListener(removeKey, removeFn);
    
    this.cleanupFn = () => {
      // console.log('map unlink', setKey);
      this.dataClient.removeEventListener(setKey, setFn);
      this.dataClient.removeEventListener(removeKey, removeFn);
    };
  }
  destroy() {
    if (this.cleanupFn) {
      this.cleanupFn();
      this.cleanupFn = null;
    }
  }
}
export class DCArray extends EventTarget {
  constructor(arrayId, dataClient) {
    super();
    this.arrayId = arrayId;
    this.dataClient = dataClient;

    this.cleanupFn = null;
  }
  getMap(arrayIndexId) {
    const map = new DCMap(this.arrayId, arrayIndexId, this.dataClient);
    map.listen();
    return map;
  }
  toArray() {
    const array = this.dataClient.crdt.get(this.arrayId);
    if (array) {
      const arrayMaps = [];
      for (const arrayIndexId in array) {
        const crdtVal = this.dataClient.crdt.get(arrayIndexId);
        const val = convertCrdtValToVal(crdtVal);
        // console.log('array crdt val', {array, arrayIndexId, crdtVal, val});
        arrayMaps.push(val);
      }
      return arrayMaps;
    } else {
      return [];
    }
  }
  add(val) {
    return this.dataClient.createArrayMapElement(this.arrayId, val);
  }
  addAt(arrayIndexId, val) {
    return this.dataClient.addArrayMapElement(this.arrayId, arrayIndexId, val);
  }
  listen() {
    const addKey = 'add.' + this.arrayId;
    const addFn = e => {
      const {
        arrayIndexId,
        val,
      } = e.data;
      const map = new DCMap(this.arrayId, arrayIndexId, this.dataClient);
      this.dispatchEvent(new MessageEvent('add', {
        data: {
          arrayIndexId,
          map,
          val,
        },
      }));
    };
    this.dataClient.addEventListener(addKey, addFn);

    const removeKey = 'remove.' + this.arrayId;
    const removeFn = e => {
      const {
        arrayIndexId,
      } = e.data;
      this.dispatchEvent(new MessageEvent('remove', {
        data: {
          arrayIndexId,
        },
      }));
    };
    this.dataClient.addEventListener(removeKey, removeFn);

    this.cleanupFn = () => {
      this.dataClient.removeEventListener(addKey, addFn);
      this.dataClient.removeEventListener(removeKey, removeFn);
    };
  }
  destroy() {
    if (this.cleanupFn) {
      this.cleanupFn();
      this.cleanupFn = null;
    }
  }
}
export class DataClient extends EventTarget {
  constructor({
    crdt = null,
  } = {}) {
    super();

    this.crdt = crdt;
  }

  // for both client and server
  serializeMessage(m) {
    const parsedMessage = this.parseMessage(m);
    const {type, arrayId, arrayIndexId} = parsedMessage;
    switch (type) {
      case 'import': {
        const {crdtExport} = parsedMessage;
        return zbencode({
          method: UPDATE_METHODS.IMPORT,
          args: [
            crdtExport,
          ],
        });
      }
      case 'set': {
        const {key, epoch, val} = m.data;
        return zbencode({
          method: UPDATE_METHODS.SET,
          args: [
            arrayId,
            arrayIndexId,
            key,
            epoch,
            val,
          ],
        });
      }
      case 'add': {
        const {arrayIndexId, val} = m.data;
        return zbencode({
          method: UPDATE_METHODS.ADD,
          args: [
            arrayId,
            arrayIndexId,
            val,
          ],
        });
      }
      case 'remove': {
        const {arrayIndexId} = m.data;
        return zbencode({
          method: UPDATE_METHODS.REMOVE,
          args: [
            arrayId,
            arrayIndexId,
          ],
        });
      }
      case 'rollback': {
        const {arrayId, arrayIndexId, key, oldEpoch, oldVal} = m.data;
        return zbencode({
          method: UPDATE_METHODS.ROLLBACK,
          args: [
            arrayId,
            arrayIndexId,
            key,
            oldEpoch,
            oldVal,
          ],
        });
      }
    }
  }
  getImportMessage() {
    const crtdObject = convertMapToObject(this.crdt);
    const crdtExport = zbencode(crtdObject);
    return new MessageEvent('import', {
      data: {
        crdtExport,
      },
    });
  }
  applyUint8Array(uint8Array, opts) {
    const updateObject = parseUpdateObject(uint8Array);
    return this.applyUpdateObject(updateObject, opts);
  }
  applyUpdateObject(updateObject, {
    force = false, // force if it's coming from the server
  } = {}) {
    let rollback = null;
    let update = null;

    const {method, args} = updateObject;
    switch (method) {
      case UPDATE_METHODS.IMPORT: {
        const [crdtExport] = args;
        // console.log('importing export', crdtExport, zbdecode(crdtExport));
        this.crdt = convertObjectToMap(zbdecode(crdtExport));
        update = new MessageEvent('import', {
          data: {
            crdtExport,
          },
        });
        break;
      }
      case UPDATE_METHODS.SET: {
        const [arrayId, arrayIndexId, key, epoch, val] = args;
        const arrayMap = new DCMap(arrayId, arrayIndexId, this);
        let oldObject;
        if (force) {
          arrayMap.setKeyEpochValue(key, epoch, val);
        } else {
          oldObject = arrayMap.trySetKeyEpochValue(key, epoch, val);
        }
        if (oldObject === undefined) {
          // accept update
          update = new MessageEvent('set.' + arrayId + '.' + arrayIndexId, {
            data: {
              key,
              epoch,
              val,
            },
          });
        } else {
          const [oldEpoch, oldVal] = oldObject;
          // reject update and roll back
          rollback = new MessageEvent('rollback', {
            data: {
              arrayId,
              arrayIndexId,
              key,
              oldEpoch,
              oldVal,
            }
          })
        }
        break;
      }
      case UPDATE_METHODS.ADD: {
        const [arrayId, arrayIndexId, val] = args;
        const crdtVal = convertValToCrdtVal(val);
        this.crdt.set(arrayIndexId, crdtVal);
        
        let array = this.crdt.get(arrayId);
        if (!array) {
          array = {};
          this.crdt.set(arrayId, array);
        }
        array[arrayIndexId] = true;

        update = new MessageEvent('add.' + arrayId, {
          data: {
            // arrayId,
            arrayIndexId,
            val,
          },
        });
        // console.log('add event', update);
        break;
      }
      case UPDATE_METHODS.REMOVE: {
        const [arrayId, arrayIndexId] = args;
        let array = this.crdt.get(arrayId);
        if (!array) {
          throw new Error('remove from nonexistent array!');
          // array = {};
          // this.crdt.set(arrayId, array);
        }
        delete array[arrayIndexId];

        update = new MessageEvent('remove.' + arrayId, {
          data: {
            // arrayId,
            arrayIndexId,
          },
        });
        break;
      }
      case UPDATE_METHODS.ROLLBACK: {
        const [arrayId, arrayIndexId, key, epoch, val] = args;
        const object = this.crdt.get(arrayIndexId);
        if (object) {
          if (object[key]) {
            object[key][0] = epoch;
            object[key][1] = val;
          } else {
            object[key] = [epoch, val];
          }

          update = new MessageEvent('set.' + arrayId + '.' + arrayIndexId, {
            data: {
              key,
              epoch,
              val,
            },
          });
        } else {
          throw new Error('got rollback for nonexistent object');
        }

        break;
      }
    }
    // this.storage = zbdecode(new Uint8Array(arrayBuffer));
    // const rollbackUint8Array = new Uint8Array(0);
    return {
      rollback,
      update,
    };
  }

  // for server
  parseMessage(m) {
    const match = m.type.match(/^set\.(.+?)\.(.+?)$/);
    if (match) {
      const arrayId = match[1];
      const arrayIndexId = match[2];
      const {key, epoch, val} = m.data;
      return {
        type: 'set',
        arrayId,
        arrayIndexId,
        key,
        epoch,
        val,
      };
    } else {
      const match = m.type.match(/^add\.(.+?)$/);
      if (match) {
        const arrayId = match[1];
        const {arrayIndexId, val} = m.data;
        return {
          type: 'add',
          arrayId,
          arrayIndexId,
          val,
        };
      } else {
        const match = m.type.match(/^remove\.(.+?)$/);
        if (match) {
          const arrayId = match[1];
          const {arrayIndexId} = m.data;
          return {
            type: 'remove',
            arrayId,
            arrayIndexId,
          };
        } else {
          if (m.type === 'rollback') {
            const {arrayId, arrayIndexId, key, oldEpoch, oldVal} = m.data;
            return {
              type: 'rollback',
              arrayId,
              arrayIndexId,
              key,
              oldEpoch,
              oldVal,
            };
          } else if (m.type === 'import') {
            return {
              type: 'import',
              crdtExport: m.data.crdtExport,
            };
          } else {
            throw new Error('unrecognized message type: ' + m.type);
          } 
        }
      }
    }
  }
  getSaveKeys(m) {
    const {type, arrayId, arrayIndexId} = this.parseMessage(m);

    const saveKeys = [];
    const saveKeyFn = name => {
      saveKeys.push(name);
    };

    if (type === 'set') {
      saveKeyFn(arrayIndexId);
    } else if (type === 'add' || type === 'remove') {
      saveKeyFn(arrayIndexId);
      saveKeyFn(arrayId);
    } else if (type === 'rollback') {
      saveKeyFn(arrayIndexId);
    } else if (type === 'import') {
      // console.warn('should find out how to save all keys...');
      // saveKeyFn('crdt');
      saveKeyFn('*');
    } else {
      throw new Error('unrecognized message type: ' + m.type);
    }

    return saveKeys;
  }
  emitUpdate(messageEvent) {
    // console.log('emit update', messageEvent.type);
    this.dispatchEvent(messageEvent);
  }
  
  // for client
  getArray(arrayId) {
    const array = new DCArray(arrayId, this);
    array.listen();
    return array;
  }
  getArrayMap(arrayId, arrayIndexId) {
    const map = new DCMap(arrayId, arrayIndexId, this);
    map.listen();
    return map;
  }
  createArrayMapElement(arrayId, val = {}) {
    const arrayIndexId = makeId();
    return this.addArrayMapElement(arrayId, arrayIndexId, val);
  }
  addArrayMapElement(arrayId, arrayIndexId, val = {}) {
    const crdtVal = convertValToCrdtVal(val);
    this.crdt.set(arrayIndexId, crdtVal);
    
    let array = this.crdt.get(arrayId);
    if (!array) {
      array = {};
      this.crdt.set(arrayId, array);
    }
    array[arrayIndexId] = true;
    // console.log('add map element', {array, arrayIndexId});

    const map = new DCMap(arrayId, arrayIndexId, this);
    map.listen();

    // const o = map.toObject();
    // console.log('add map element readback', {array, arrayIndexId, o, val});

    const update = new MessageEvent('add.' + arrayId, {
      data: {
        // arrayId,
        arrayIndexId,
        val,
      },
    });
    return {map, update};
  }
  removeArrayMapElement(arrayId, arrayIndexId) {
    let array = this.crdt.get(arrayId);
    if (!array) {
      array = {};
      this.crdt.set(arrayId, array);
    }
    if (array[arrayIndexId]) {
      if (this.crdt.has(arrayIndexId)) {
        this.crdt.delete(arrayIndexId);
        delete array[arrayIndexId];

        const update = new MessageEvent('remove.' + arrayId, {
          data: {
            // arrayId,
            arrayIndexId,
          },
        });
        return update;
      } else {
        throw new Error('array index id not found in crdt');
      }
    } else {
      throw new Error('array index not found in array');
    }
  }
  readBinding(arrayNames) {
    let arrays = {};
    let arrayMaps = {};
    if (this.crdt) {
      arrayNames.forEach(arrayId => {
        const array = this.crdt.get(arrayId);
        const localArrayMaps = [];
        if (array) {
          for (const arrayIndexId in array) {
            const arrayMap = new DCMap(arrayId, arrayIndexId, this);
            arrayMap.listen();
            localArrayMaps.push(arrayMap);
          }
        }

        arrays[arrayId] = new DCArray(arrayId, this);
        arrays[arrayId].listen();
        arrayMaps[arrayId] = localArrayMaps;
      });
      return {
        arrays,
        arrayMaps,
      };
    } else {
      throw new Error('crdt was not initialized; it has not gotten its first message');
    }
  }
}

//

export class NetworkedDataClient extends EventTarget {
  constructor(dataClient, ws) {
    super();

    this.dataClient = dataClient;
    this.ws = ws;
  }
  static handlesMethod(method) {
    return [
      UPDATE_METHODS.IMPORT,
      UPDATE_METHODS.SET,
      UPDATE_METHODS.ADD,
      UPDATE_METHODS.REMOVE,
      UPDATE_METHODS.ROLLBACK,
    ].includes(method);
  }
  async connect() {
    await new Promise((resolve, reject) => {
      resolve = (resolve => () => {
        resolve();
        _cleanup();
      })(resolve);
      reject = (reject => () => {
        reject();
        _cleanup();
      })(reject);
      
      this.ws.addEventListener('open', resolve);
      this.ws.addEventListener('error', reject);

      const _cleanup = () => {
        this.ws.removeEventListener('open', resolve);
        this.ws.removeEventListener('error', reject);
      };
    });
    // console.log('connect');

    const _waitForInitialImport = async () => {
      await new Promise((resolve, reject) => {
        const initialMessage = e => {
          if (e.data instanceof ArrayBuffer && e.data.byteLength > 0) {
            const updateBuffer = e.data;
            const uint8Array = new Uint8Array(updateBuffer);
            const updateObject = parseUpdateObject(uint8Array);
            
            const {method, args} = updateObject;
            if (method === UPDATE_METHODS.IMPORT) {
              const [crdtExport] = args;
              // console.log('data init', {crdtExport});
    
              resolve({
                crdtExport,
              });
              this.ws.removeEventListener('message', initialMessage);
            }
          }
        };
        this.ws.addEventListener('message', initialMessage);
      });
    };
    await _waitForInitialImport();

    const mainMessage = e => {
      if (e.data instanceof ArrayBuffer && e.data.byteLength > 0) {
        const updateBuffer = e.data;
        const uint8Array = new Uint8Array(updateBuffer);
        const updateObject = parseUpdateObject(uint8Array);

        const {method} = updateObject;
        if (NetworkedDataClient.handlesMethod(method)) {
          const {
            rollback,
            update,
          } = this.dataClient.applyUpdateObject(updateObject, {force: true}); // force since coming from the server
          if (rollback) {
            console.warn('rollback', rollback);
            throw new Error('unexpected rollback');
          }

          /* this.dispatchEvent(new MessageEvent('update', {
            data: {
              update,
            },
          })); */

          this.dataClient.emitUpdate(update);

          const saveKeys = this.dataClient.getSaveKeys(update);
          this.dispatchEvent(new MessageEvent('save', {
            data: {
              saveKeys,
            },
          }));
        }
      }
    };
    this.ws.addEventListener('message', mainMessage);
  }
  send(msg) {
    // const buffer = msg.slice().buffer;
    // console.log('send', buffer);
    // this.ws.send(buffer);
    this.ws.send(msg);
  }
}