import {zbencode, zbdecode} from "./encoding.mjs";

function makeid(length) {
  var result           = '';
  var characters       = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789';
  var charactersLength = characters.length;
  for ( var i = 0; i < length; i++ ) {
    result += characters.charAt(Math.floor(Math.random() * charactersLength));
 }
 return result;
}
const makeId = () => makeid(5);
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
    // console.log('dc map listen', setKey);
    const setFn = e => {
      const {key, epoch, val} = e.data;
      // console.log('capture set data 1', e.data);
      this.dispatchEvent(new MessageEvent('set', {
        data: {
          key,
          epoch,
          val,
        },
      }));
      // console.log('capture set data 2', e.data);
    };
    this.dataClient.addEventListener(setKey, setFn);
    this.cleanupFn = () => {
      this.dataClient.removeEventListener(setKey, setFn);
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
  listen() {
    const addKey = 'add.' + this.arrayId;
    const addFn = e => {
      const {
        arrayIndexId,
        val,
      } = e.data;
      const map = new DCMap(arrayId, arrayIndexId, this.dataClient);
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

    // this.storage = storage;
    // this.websocket = websocket;

    this.crdt = crdt;
  }
  static UPDATE_METHODS = {
    SET: 1,
    ADD: 2,
    REMOVE: 3,
    ROLLBACK: 4,
  };

  // for both client and server
  serializeMessage(m) {
    const parsedMessage = this.parseMessage(m);
    const {type, arrayId, arrayIndexId} = parsedMessage;
    switch (type) {
      case 'set': {
        const {key, epoch, val} = m.data;
        return zbencode({
          method: DataClient.UPDATE_METHODS.SET,
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
          method: DataClient.UPDATE_METHODS.ADD,
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
          method: DataClient.UPDATE_METHODS.REMOVE,
          args: [
            arrayId,
            arrayIndexId,
          ],
        });
      }
      case 'rollback': {
        const {arrayIndexId, key, oldEpoch, oldVal} = m.data;
        return zbencode({
          method: DataClient.UPDATE_METHODS.ROLLBACK,
          args: [
            arrayIndexId,
            key,
            oldEpoch,
            oldVal,
          ],
        });
      }
    }
  }
  applyUint8Array(uint8Array, {
    force = false, // force if it's coming from the server
  } = {}) {
    let rollback = null;
    let update = null;

    const {method, args} = zbdecode(uint8Array);
    switch (method) {
      case DataClient.UPDATE_METHODS.SET: {
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
              arrayIndexId,
              key,
              oldEpoch,
              oldVal,
            }
          })
        }
        break;
      }
      case DataClient.UPDATE_METHODS.ADD: {
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
      case DataClient.UPDATE_METHODS.REMOVE: {
        const [arrayId, arrayIndexId] = args;
        let array = this.crdt.get(arrayId);
        if (!array) {
          array = {};
          this.crdt.set(arrayId, array);
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
      case DataClient.UPDATE_METHODS.ROLLBACK: {
        const [arrayIndexId, key, epoch, val] = args;
        const object = this.crdt.get(arrayIndexId);
        if (object) {
          if (object[key]) {
            object[key][0] = epoch;
            object[key][1] = val;
          } else {
            object[key] = [epoch, val];
          }

          update = new MessageEvent('set.' + arrayIndexId, {
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
          throw new Error('unrecognized message type: ' + m.type);
        }
      }
    }
  }
  triggerSave(m) {
    const {type, arrayId, arrayIndexId} = this.parseMessage(m);

    if (type === 'set') {
      saveKeyFn(arrayIndexId);
    } else if (type === 'add' || type === 'remove') {
      saveKeyFn(arrayIndexId);
      saveKeyFn(arrayId);
    } else {
      throw new Error('unrecognized message type: ' + m.type);
    }
  }
  emitUpdate(messageEvent) {
    // console.log('emit', messageEvent);
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

    const o = map.toObject();
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