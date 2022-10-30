import {zbencode, zbdecode} from "./encoding.mjs";
import {UPDATE_METHODS} from "./update-types.js";
import {
  parseUpdateObject,
  makeId,
  serializeMessage,
} from "./util.mjs";

//

export const convertValToCrdtVal = val => {
  const startEpoch = 0;
  const crdtVal = {};
  for (const k in val) {
    const v = val[k];
    crdtVal[k] = [startEpoch, v];
  }
  return crdtVal;
}
export const convertCrdtValToVal = crdtVal => {
  const val = {};
  for (const k in crdtVal) {
    const [epoch, v] = crdtVal[k];
    val[k] = v;
  }
  return val;
}

export const convertMapToObject = map => {
  const o = {};
  for (const [key, val] of map) {
    o[key] = val;
  }
  return o;
};
export const convertObjectToMap = map => {
  const o = new Map();
  for (const key in map) {
    const val = map[key];
    o.set(key, val);
  }
  return o;
};

//

const _key = (arrayId, arrayIndexId) => `${arrayId}:${arrayIndexId}`;
export class DCMap extends EventTarget {
  constructor(arrayId, arrayIndexId, dataClient) {
    super();

    // if (arrayId === undefined || arrayIndexId === undefined) {
    //   debugger;
    // }

    this.arrayId = arrayId;
    this.arrayIndexId = arrayIndexId;
    this.dataClient = dataClient;

    this.cleanupFn = null;
  }
  key() {
    return _key(this.arrayId, this.arrayIndexId);
  }
  getRawObject() {
    const key = this.key();
    const crdtWrap = this.dataClient.crdt.get(key);
    const rawObject = crdtWrap[1];
    return rawObject;
  }
  setRawObject(rawObject, epoch) {
    const key = this.key();
    const crdtWrap = [
      epoch,
      rawObject,
    ];
    this.dataClient.crdt.set(key, crdtWrap);
  }
  getEpoch() {
    const key = this.key();
    const crdtWrap = this.dataClient.crdt.get(key);
    const epoch = crdtWrap[0];
    return epoch;
  }
  toObject() {
    const object = this.getRawObject();
    if (object) {
      const result = {};
      for (const key in object) {
        const [epoch, val] = structuredClone(object[key]);
        result[key] = val;
      }
      return result;
    } else {
      debugger;
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
      debugger;
      throw new Error('setKeyEpochValue on nonexistent object');
    }
    if (object[key]) { // already had key; update
      object[key][0] = epoch;
      object[key][1] = val;
    } else { // did not have key; add
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
    const key = this.key();
    this.dataClient.crdt.delete(key);
    
    let array = this.dataClient.crdt.get(this.arrayId);
    if (!array) {
      throw new Error('remove from nonexistent array!');
    }
    delete array[this.arrayIndexId];
    
    return new MessageEvent('remove.' + this.arrayId, {
      data: {
        arrayIndexId: this.arrayIndexId, // XXX is this needed?
      },
    });
  }

  // server
  trySetKeyEpochValue(key, epoch, val) {
    let object = this.getRawObject();
    if (!object) {
      object = {};
      this.setRawObject(object, 0);
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
    const setFn = e => {
      const {key, epoch, val} = e.data;
      this.dispatchEvent(new MessageEvent('update', {
        data: {
          key,
          epoch,
          val,
        },
      }));
    };
    this.dataClient.addEventListener(setKey, setFn);

    const removeKey = 'remove.' + this.arrayId;
    const removeFn = e => {
      const {arrayIndexId} = e.data;
      if (arrayIndexId === this.arrayIndexId) {
        this.dispatchEvent(new MessageEvent('remove', {
          data: {
            arrayIndexId,
          },
        }));
      }
    };
    this.dataClient.addEventListener(removeKey, removeFn);

    /* const importMapKey = 'importMap.' + this.arrayId;
    const importMapFn = e => {
      const {arrayIndexId} = e.data;
      const key = this.getKey();
      const map = this.dataClient.crdt.get(key);
      const array = this.dataClient.crdt.get(this.arrayId);
      console.log('dc handle import map', {array, map});
    };
    this.dataClient.addEventListener(importMapKey, importMapFn); */

    // listener
    // this.dataClient.arrayMapListeners.set(this.arrayIndexId, this);
    
    this.cleanupFn = () => {
      // console.log('map unlink', setKey);
      this.dataClient.removeEventListener(setKey, setFn);
      this.dataClient.removeEventListener(removeKey, removeFn);
      // this.dataClient.removeEventListener(importMapKey, importMapFn);

      // listener
      // this.dataClient.arrayMapListeners.delete(this.arrayIndexId);
    };
  }
  unlisten() {
    if (this.cleanupFn) {
      this.cleanupFn();
      this.cleanupFn = null;
    }
  }
}

//

export class DCArray extends EventTarget {
  constructor(arrayId, dataClient) {
    super();

    // if (!arrayId) {
    //   debugger;
    // }
    this.arrayId = arrayId;
    this.dataClient = dataClient;

    // this.r = Math.random();
    // this.stack = new Error().stack;
    this.cleanupFn = null;
  }
  getKeys() {
    const array = this.dataClient.crdt.get(this.arrayId);
    if (array) {
      return Object.keys(array);
    } else {
      return [];
    }
  }
  getMap(arrayIndexId, {listen = true} = {}) {
    const map = new DCMap(this.arrayId, arrayIndexId, this.dataClient);
    listen && map.listen();
    return map;
  }
  hasKey(key) {
    const array = this.dataClient.crdt.get(this.arrayId);
    if (array) {
      if (array[key] !== undefined) {
        // debugger;
        return true;
      } else {
        return false;
      }
    } else {
      return false;
    }
  }
  getIndex(index, opts) {
    const array = this.dataClient.crdt.get(this.arrayId);
    if (array) {
      let i = 0;
      for (const k in array) {
        if (i === index) {
          return this.getMap(k, opts);
        }
        i++;
      }
      return undefined;
    } else {
      return undefined;
    }
  }
  getSize() {
    const array = this.dataClient.crdt.get(this.arrayId);
    return array ? Object.keys(array).length : 0;
  }
  toArray() {
    const array = this.dataClient.crdt.get(this.arrayId);
    if (array) {
      const arrayMaps = [];
      for (const arrayIndexId in array) {
        const key = _key(this.arrayId, arrayIndexId);
        const crdtWrap = this.dataClient.crdt.get(key);
        const crdtVal = crdtWrap[1];
        const val = convertCrdtValToVal(crdtVal);
        arrayMaps.push(val);
      }
      // if (arrayMaps.length > 0 && window.lol) {
      //   debugger;
      // }
      return arrayMaps;
    } else {
      return [];
    }
  }
  importMapUpdate(map) {
    const rawObject = map.getRawObject();
    const crdtExport = structuredClone(rawObject);

    // map
    const key = _key(this.arrayId, map.arrayIndexId);
    this.dataClient.crdt.set(key, crdtExport);

    // array
    let array = this.dataClient.crdt.get(this.arrayId);
    if (!array) {
      array = {};
      this.dataClient.crdt.set(this.arrayId, array);
    }
    array[map.arrayIndexId] = true;

    // console.log('import map db write', array);

    return new MessageEvent('importMap.' + this.arrayId, {
      data: {
        arrayIndexId: map.arrayIndexId,
        crdtExport,
      },
    });
  }
  importArrayUpdate(array) {
    const arrayVal = array.dataClient.crdt.get(array.arrayId);
    const arrayCrdtExport = structuredClone(arrayVal);
    this.dataClient.crdt.set(array.arrayId, arrayCrdtExport);

    const mapCrdtExports = {};
    for (const arrayIndexId in arrayVal) {
      const map = array.getMap(arrayIndexId, {
        listen: false,
      });
      const mapVal = map.getRawObject();
      const mapCrdtExport = structuredClone(mapVal);
      const key = _key(array.arrayId, arrayIndexId);
      this.dataClient.crdt.set(key, mapCrdtExport);
      mapCrdtExports[arrayIndexId] = mapCrdtExport;
    }
    return new MessageEvent('importArray.' + this.arrayId, {
      data: {
        arrayCrdtExport,
        mapCrdtExports,
      },
    });
  }
  add(val, epoch, opts) {
    return this.dataClient.createArrayMapElement(this.arrayId, val, epoch, opts);
  }
  addAt(arrayIndexId, val, epoch, opts) {
    return this.dataClient.addArrayMapElement(this.arrayId, arrayIndexId, val, epoch, opts);
  }
  removeAt(arrayIndexId) {
    return this.dataClient.removeArrayMapElement(this.arrayId, arrayIndexId);
  }
  removeArrayUpdate() {
    let array = this.dataClient.crdt.get(this.arrayId);
    if (!array) {
      throw new Error('remove nonexistent array!');
    }
    const mapKeys = Object.keys(array);
    
    // delete the array
    this.dataClient.crdt.delete(this.arrayId);

    // delete the maps, too
    for (const arrayIndexId of mapKeys) {
      const key = _key(this.arrayId, arrayIndexId);
      this.dataClient.crdt.delete(key);
    }

    return new MessageEvent('removeArray.' + this.arrayId, {
      data: {},
    });
  }
  // arrayListeners = new Map();
  listen() {
    const _addMap = (arrayIndexId, val, epoch) => {
      if (epoch === undefined) {
        // debugger;
        epoch = 0;
      }
      const map = new DCMap(this.arrayId, arrayIndexId, this.dataClient);
      this.dispatchEvent(new MessageEvent('add', {
        data: {
          arrayIndexId,
          map,
          val,
          epoch,
        },
      }));
    };

    const addKey = 'add.' + this.arrayId;
    const addFn = e => {
      const {
        arrayIndexId,
        val,
      } = e.data;
      _addMap(arrayIndexId, val);
    };
    this.dataClient.addEventListener(addKey, addFn);

    const removeKey = 'remove.' + this.arrayId;
    const removeFn = e => {
      const {
        arrayIndexId,
      } = e.data;
      // console.log('data client remove', {arrayId: this.arrayId, arrayIndexId});
      this.dispatchEvent(new MessageEvent('remove', {
        data: {
          arrayIndexId,
        },
      }));
    };
    this.dataClient.addEventListener(removeKey, removeFn);

    const importMapKey = 'importMap.' + this.arrayId;
    const importMapFn = e => {
      const {arrayIndexId, crdtExport} = e.data;
      const val = convertCrdtValToVal(crdtExport);
      _addMap(arrayIndexId, val);
    };
    this.dataClient.addEventListener(importMapKey, importMapFn);

    const importArrayKey = 'importArray.' + this.arrayId;
    const importArrayFn = e => {
      const {
        arrayCrdtExport,
        mapsCrdtExports,
      } = e.data;

      for (const arrayIndexId in mapsCrdtExports) {
        const map = mapsCrdtExports[arrayIndexId];
        const val = convertCrdtValToVal(map);
        _addMap(arrayIndexId, val);
      }
    };
    this.dataClient.addEventListener(importArrayKey, importArrayFn);

    // listener
    // if (this.arrayListeners.has(this.arrayId)) {
    //   console.log('double listen');
    //   debugger;
    // } else {
    //   console.log('single listen');
    // }
    // this.arrayListeners.set(this.arrayId, this);

    this.cleanupFn = () => {
      this.dataClient.removeEventListener(addKey, addFn);
      this.dataClient.removeEventListener(removeKey, removeFn);
      this.dataClient.removeEventListener(importMapKey, importMapFn);
      // this.dataClient.removeEventListener(importArrayKey, importArrayFn);

      // listener
      // this.arrayListeners.delete(this.arrayId);
    };
  }
  unlisten() {
    if (this.cleanupFn) {
      this.cleanupFn();
      this.cleanupFn = null;
    }
  }
}
export class DataClient extends EventTarget {
  constructor({
    crdt = null,
    userData = null,
  } = {}) {
    super();

    this.crdt = crdt;
    this.userData = userData;
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
      case 'importMap': {
        const {arrayId, arrayIndexId, crdtExport} = parsedMessage;
        return zbencode({
          method: UPDATE_METHODS.IMPORT_MAP,
          args: [
            arrayId,
            arrayIndexId,
            crdtExport,
          ],
        });
      }
      case 'importArray': {
        const {arrayId, arrayCrdtExport, mapCrdtExports} = parsedMessage;
        return zbencode({
          method: UPDATE_METHODS.IMPORT_ARRAY,
          args: [
            arrayId,
            arrayCrdtExport,
            mapCrdtExports,
          ],
        });
      }
      case 'sync': {
        return zbencode({
          method: UPDATE_METHODS.SYNC,
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
        const {arrayIndexId, val, epoch} = m.data;
        return zbencode({
          method: UPDATE_METHODS.ADD,
          args: [
            arrayId,
            arrayIndexId,
            val,
            epoch,
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
      case 'removeArray': {
        return zbencode({
          method: UPDATE_METHODS.REMOVE_ARRAY,
          args: [
            arrayId,
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
      case 'deadhand': {
        // console.log('serialize dead hand');
        // debugger;
        const {keys, deadHand} = m.data;
        return zbencode({
          method: UPDATE_METHODS.DEAD_HAND,
          args: [
            keys,
            deadHand,
          ],
        });
      }
      case 'livehand': {
        // console.log('serialize live hand');
        // debugger;
        const {keys, liveHand} = m.data;
        return zbencode({
          method: UPDATE_METHODS.LIVE_HAND,
          args: [
            keys,
            liveHand,
          ],
        });
      }
      default: {
        throw new Error('invalid message type: ' + type);
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
  getSyncMessage() {
    return new MessageEvent('sync');
  }
  deadHandKeys(keys, deadHand) {
    return new MessageEvent('deadhand', {
      data: {
        keys,
        deadHand,
      },
    });
  }
  deadHandArrayMap(arrayId, arrayIndexId, deadHand) {
    if (typeof arrayIndexId !== 'string') {
      debugger;
    }
    return this.deadHandKeys([arrayId + '.' + arrayIndexId], deadHand);
  }
  deadHandArrayMaps(arrayId, arrayIndexId, deadHand) {
    return this.deadHandKeys(arrayIndexId.map(arrayIndexId => arrayId + '.' + arrayIndexId), deadHand);
  }
  liveHandKeys(keys, liveHand) {
    return new MessageEvent('livehand', {
      data: {
        keys,
        liveHand,
      },
    });
  }
  liveHandArrayMap(arrayId, arrayIndexId, liveHand) {
    return this.liveHandKeys([arrayId + '.' + arrayIndexId], liveHand);
  }
  liveHandArrayMaps(arrayId, arrayIndex, liveHand) {
    return this.liveHandKeys(arrayIndex.map(arrayIndexId => arrayId + '.' + arrayIndexId), liveHand);
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
    // console.log('apply update object', {method, args});
    switch (method) {
      case UPDATE_METHODS.IMPORT: {
        const [crdtExport] = args;
        // console.log('importing export', crdtExport, zbdecode(crdtExport));
        this.crdt = convertObjectToMap(zbdecode(crdtExport));
        // console.log('crdt imported', this.crdt);
        update = new MessageEvent('import', {
          data: {
            crdtExport,
          },
        });
        break;
      }
      case UPDATE_METHODS.IMPORT_MAP: {
        const [arrayId, arrayIndexId, crdtExport] = args;

        // ensure the array exists
        let array = this.crdt.get(arrayId);
        if (!array) {
          array = {};
          this.crdt.set(arrayId, array);
        }

        // set the map
        const key = _key(arrayId, arrayIndexId);
        this.crdt.set(key, crdtExport);

        update = new MessageEvent('importMap.' + arrayId, {
          data: {
            arrayId,
            arrayIndexId,
            crdtExport,
          },
        });
        break;
      }
      case UPDATE_METHODS.IMPORT_ARRAY: {
        const [arrayId, arrayCrdtExport, mapsCrdtExports] = args;

        // set array
        this.crdt.set(arrayId, arrayCrdtExport);
        
        // set array maps
        for (const arrayIndexId in mapsCrdtExports) {
          const key = _key(arrayId, arrayIndexId);
          this.crdt.set(key, mapsCrdtExports[arrayIndexId]);
        }
        
        update = new MessageEvent('importArray.' + arrayId, {
          data: {
            arrayCrdtExport,
            mapsCrdtExports,
          },
        });
        break;
      }
      case UPDATE_METHODS.SET: {
        const [arrayId, arrayIndexId, key, epoch, val] = args;
        // console.log('apply update', {arrayId, arrayIndexId, key, epoch, val});
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
        const [arrayId, arrayIndexId, val, epoch] = args;
        const crdtVal = convertValToCrdtVal(val);
        
        const key = _key(arrayId, arrayIndexId);
        const crdtWrap = [
          epoch,
          crdtVal,
        ];
        this.crdt.set(key, crdtWrap);
        
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
          throw new Error('remove from nonexistent array: ' + arrayId);
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
      case UPDATE_METHODS.REMOVE_ARRAY: {
        const [arrayId] = args;
        let array = this.crdt.get(arrayId);
        if (!array) {
          throw new Error('remove from nonexistent array: ' + arrayId);
        }
        const mapKeys = Object.keys(array);
        delete array[arrayId];

        // remove the maps, too
        for (const mapKey of mapKeys) {
          this.crdt.delete(mapKey);
        }

        update = new MessageEvent('removeArray.' + arrayId, {
          data: {},
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
      case UPDATE_METHODS.DEAD_HAND: {
        const [keys, deadHand] = args;
        // console.log('handle dead hand', {arrayId, arrayIndexId, deadHand});
        this.dispatchEvent(new MessageEvent('deadhand', {
          data: {
            keys,
            deadHand,
          },
        }));
        break;
      }
      case UPDATE_METHODS.LIVE_HAND: {
        const [keys, liveHand] = args;
        // console.log('handle live hand', {arrayId, arrayIndexId, liveHand});
        this.dispatchEvent(new MessageEvent('livehand', {
          data: {
            keys,
            liveHand,
          },
        }));
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
        const {arrayIndexId, val, epoch} = m.data;
        return {
          type: 'add',
          arrayId,
          arrayIndexId,
          val,
          epoch,
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
          const match = m.type.match(/^removeArray\.(.+?)$/);
          if (match) {
            const arrayId = match[1];
            return {
              type: 'removeArray',
              arrayId,
            };
          } else {
            const match = m.type.match(/^importMap\.(.+?)$/);
            if (match) {
              const arrayId = match[1];
              return {
                type: 'importMap',
                arrayId,
                arrayIndexId: m.data.arrayIndexId,
                crdtExport: m.data.crdtExport,
              };
            } else {
              const match = m.type.match(/^importArray\.(.+?)$/);
              if (match) {
                const arrayId = match[1];
                return {
                  type: 'importArray',
                  arrayId,
                  arrayCrdtExport: m.data.arrayCrdtExport,
                  mapsCrdtExports: m.data.mapsCrdtExports,
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
                } else if (m.type === 'deadhand') {
                  const {keys, deadHand} = m.data;
                  return {
                    type: 'deadhand',
                    keys,
                    deadHand,
                  };
                } else if (m.type === 'livehand') {
                  const {keys, liveHand} = m.data;
                  return {
                    type: 'livehand',
                    keys,
                    liveHand,
                  };
                } else {
                  throw new Error('unrecognized message type: ' + m.type);
                }
              }
            }
          }
        }
      }
    }
  }
  getSaveKeys(m) {
    const mo = this.parseMessage(m);
    const {type, arrayId, arrayIndexId} = mo;

    const saveKeys = [];
    const saveKeyFn = name => {
      saveKeys.push(name);
    };

    if (type === 'set') {
      saveKeyFn(arrayIndexId);
    } else if (type === 'add' || type === 'remove') {
      saveKeyFn(arrayIndexId);
      saveKeyFn(arrayId);
    } else if (type === 'removeArray') {
      saveKeyFn(arrayId);
    } else if (type === 'rollback') {
      saveKeyFn(arrayIndexId);
    } else if (type === 'import') {
      // console.warn('should find out how to save all keys...');
      // saveKeyFn('crdt');
      saveKeyFn('*');
    } else if (type === 'importArray') {
      const {arrayCrdtExport, mapsCrdtExports} = mo;
      saveKeyFn(arrayId);
      // XXX
    } else if (type === 'importMap') {
      const {crdtExport} = mo;
      saveKeyFn(arrayIndexId);
      // XXX
    } else {
      debugger;
      throw new Error('unrecognized message type: ' + m.type);
    }

    return saveKeys;
  }
  emitUpdate(messageEvent) {
    // console.log('data client emit update', messageEvent.type);
    this.dispatchEvent(messageEvent);
  }
  
  // for client
  getArray(arrayId, {listen = true} = {}) {
    const array = new DCArray(arrayId, this);
    listen && array.listen();
    return array;
  }
  getArrayMap(arrayId, arrayIndexId, {listen = true} = {}) {
    const map = new DCMap(arrayId, arrayIndexId, this);
    listen && map.listen();
    return map;
  }
  createArrayMapElement(arrayId, val, epoch, opts) {
    const arrayIndexId = makeId();
    return this.addArrayMapElement(arrayId, arrayIndexId, val, epoch, opts);
  }
  addArrayMapElement(arrayId, arrayIndexId, val, epoch, {
    listen = true,
  } = {}) {
    if (typeof epoch !== 'number') {
      debugger;
    }

    const crdtVal = convertValToCrdtVal(val);
    
    const key = _key(arrayId, arrayIndexId);
    const crdtWrap = [
      epoch,
      crdtVal,
    ];
    this.crdt.set(key, crdtWrap);
    
    let array = this.crdt.get(arrayId);
    if (!array) {
      array = {};
      this.crdt.set(arrayId, array);
    }
    array[arrayIndexId] = true;

    const map = new DCMap(arrayId, arrayIndexId, this);
    listen && map.listen();

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
      const key = _key(arrayId, arrayIndexId);
      if (this.crdt.has(key)) {
        this.crdt.delete(key);

        delete array[arrayIndexId];

        const update = new MessageEvent('remove.' + arrayId, {
          data: {
            // arrayId,
            arrayIndexId,
          },
        });
        return update;
      } else {
        debugger;
        throw new Error('array map key not found in crdt');
      }
    } else {
      debugger;
      throw new Error('array index not found in array');
    }
  }
  clearUpdates() {
    // console.log('clearing', Array.from(this.arrayListeners.entries()), Array.from(this.arrayMapListeners.entries()));
    const updates = [];
    for (const map of this.arrayMapListeners.values()) {
      const update = map.clearUpdate();
      // this.emitUpdate(update);
      updates.push(update);
    }
    // currently, arrays cannot be removed
    // XXX in that case, we don't need to track this.arrayListeners?
    // for (const array of this.arrayListeners.values()) {
    //   const update = array.clearUpdate();
    //   this.emitUpdate(update);
    // }
    return updates;
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
  constructor(dataClient, {
    userData = {},
  } = {}) {
    super();

    this.dataClient = dataClient;
    this.userData = userData;

    this.ws = null;
  }
  static handlesMethod(method) {
    return [
      UPDATE_METHODS.IMPORT,
      UPDATE_METHODS.IMPORT_MAP,
      UPDATE_METHODS.IMPORT_ARRAY,
      UPDATE_METHODS.SYNC,
      UPDATE_METHODS.SET,
      UPDATE_METHODS.ADD,
      UPDATE_METHODS.REMOVE,
      UPDATE_METHODS.REMOVE_ARRAY,
      UPDATE_METHODS.ROLLBACK,
      UPDATE_METHODS.DEAD_HAND,
      UPDATE_METHODS.LIVE_HAND,
    ].includes(method);
  }
  async connect(ws) {
    this.ws = ws;

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
              
              const importMessage = new MessageEvent('import', {
                data: {
                  crdtExport,
                },
              });
              const uint8Array = serializeMessage(importMessage);
              const updateObject = parseUpdateObject(uint8Array);

              const {
                rollback,
                update,
              } = this.dataClient.applyUpdateObject(updateObject, {
                force: true, // since coming from the server
              });
              if (rollback) {
                throw new Error('initial import failed 1');
              }
              if (update) {
                this.dataClient.emitUpdate(update);
              } else {
                throw new Error('initial import failed 2');
              }

              resolve();
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
  disconnect() {
  }
  send(msg) {
    this.ws.send(msg);
  }
  emitUpdate(update) {
    // console.log('emit update on network', update, new Error().stack);
    this.send(this.dataClient.serializeMessage(update));
  }
}