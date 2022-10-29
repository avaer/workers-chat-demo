import {DataClient, NetworkedDataClient, DCMap, DCArray, convertCrdtValToVal} from './data-client.mjs';
import {NetworkedIrcClient} from './irc-client.js';
import {NetworkedAudioClient} from './audio-client.js';
import {createWs, makePromise, makeId} from './util.mjs';

//

const positionKey = 'position';

//

const arrayEquals = (a, b) => {
  if (a.length !== b.length) {
    return false;
  } else {
    for (let i = 0; i < a.length; i++) {
      if (a[i] !== b[i]) {
        return false;
      }
    }
    return true;
  }
};
/* const distanceTo = (a, b) => {
  const [xa, ya, za] = a;
  const [xb, yb, zb] = b;
  const dx = xa - xb;
  const dy = ya - yb;
  const dz = za - zb;
  return Math.sqrt(dx*dx + dy*dy + dz*dz);
}; */
const boxContains = (box, point) => {
  const {min, max} = box;
  /* if (typeof point?.[0] !== 'number') {
    debugger;
  } */
  const [x, y, z] = point;
  return x >= min[0] && x < max[0] &&
    y >= min[1] && y < max[1] &&
    z >= min[2] && z < max[2];
};
const makeTransactionHandler = () => {
  const queue = [];
  async function handle(fn) {
    if (!handle.running) {
      handle.running = true;
      let result;
      let error;
      try {
        result = await fn();
      } catch (err) {
        error = err;
      }
      handle.running = false;
      if (queue.length > 0) {
        queue.shift()();
      }
      if (!error) {
        return result;
      } else {
        throw error;
      }
    } else {
      const promise = makePromise();
      queue.push(promise.resolve);
      await promise;
      return handle(fn);
    }
  }
  handle.running = false; 
  return handle;
};

//

const _getHeadRealm = (position, realms) => {
  for (const realm of realms) {
    if (realm.connected) {
      const box = {
        min: realm.min,
        max: [
          realm.min[0] + realm.size,
          realm.min[1] + realm.size,
          realm.min[2] + realm.size,
        ],
      };
      // console.log('check box', box.min, box.max, position);
      if (boxContains(box, position)) {
        // console.log('got head', realm.min);
        return realm;
      }
    }
  }
  return null;
}

//

class HeadTrackedEntity extends EventTarget {
  constructor(headTracker) {
    super();

    this.headTracker = headTracker || new HeadTracker('entity', this);
  }
  setHeadTracker(headTracker) {
    this.headTracker = headTracker;
  }
  /* isLinked() {
    debugger;
    return this.headTracker.isLinked();
  }
  updateHeadRealm(headPosition) {
   debugger;
  }
  setHeadRealm(realm) {
    debugger;
    this.headTracker.setHeadRealm(realm);
  } */
}

//

class HeadTracker extends EventTarget {
  constructor(name, parent) {
    super();

    // console.log('new head tracker', new Error().stack);

    this.name = name;
    this.parent = parent;
  }
  #headRealm = null;
  #connectedRealms = new Map();
  getHeadRealm() {
    /* if (!this.#headRealm) {
      debugger;
      throw new Error('head tracker has no head! need to call updateHeadRealm()');
    } */
    if (this.#connectedRealms.size === 1) {
      return this.#connectedRealms.keys().next().value;
    } else if (this.#headRealm) {
      /* if (this.#headRealm.ws.readyState !== 1) {
        debugger;
        throw new Error('head realm is not connected');
      } */
      return this.#headRealm;
    } else {
      debugger;
      throw new Error('head tracker has no head! need to call updateHeadRealm()');
    }
  }
  hasHeadRealm() {
    return this.#connectedRealms.size === 1 || this.#headRealm !== null;
  }
  getReadable() {
    return new ReadableHeadTracker(this);
  }
  updateHeadRealm(headPosition) {
    if (!headPosition || isNaN(headPosition[0]) || isNaN(headPosition[1]) || isNaN(headPosition[2])) {
      throw new Error('try to update head realm for unpositioned player: ' + headPosition.join(','));
    }

    /* const onclose = e => {
      if (this.#headRealm.ws.readyState !== 1) {
        debugger;
      }
    }; */

    if (this.isLinked()) {
      const newHeadRealm = _getHeadRealm(headPosition, Array.from(this.#connectedRealms.keys()));
      if (!this.#headRealm) {
        this.#headRealm = newHeadRealm;
        // this.#headRealm.ws.addEventListener('close', onclose);
      } else {
        const oldHeadRealm = this.#headRealm;
        if (newHeadRealm.key !== oldHeadRealm.key) {
          this.#headRealm = newHeadRealm;
          // this.#headRealm.ws.addEventListener('close', onclose);

          if (!Array.from(this.#connectedRealms.keys())[0].parent.tx.running) {
            debugger;
            throw new Error('migration happening outside of a lock -- wrap in realms.tx()');
          }

          this.dispatchEvent(new MessageEvent('migrate', {
            data: {
              oldHeadRealm,
              newHeadRealm,
            },
          }));
        }
      }
    } else {
      debugger;
      throw new Error('try to get head realm for fully unlinked player ' + this.playerId);
    }
  }
  isLinked() {
    return this.#connectedRealms.size > 0;
  }
  setHeadRealm(realm) {
    this.#headRealm = realm;
    // const onclose = e => {
    //   if (this.#headRealm.ws.readyState !== 1) {
    //     debugger;
    //   }
    // };
    // this.#headRealm.ws.addEventListener('close', onclose);
    const self = this;
    this.#headRealm.ws.close = (close => function() {
      // console.log('got realm', self, realm);
      if (self.#headRealm === realm) {
        self.#headRealm = null;
      }
      return close.apply(this, arguments);
    })(this.#headRealm.ws.close);
  }
  linkRealm(realm) {
    /* if (this.#connectedRealms.has(realm)) {
      debugger;
    } */
    let val = this.#connectedRealms.get(realm) ?? 0;
    val++;
    this.#connectedRealms.set(realm, val);
  }
  unlinkRealm(realm) {
    if (!this.#connectedRealms.has(realm)) {
      debugger;
    }
    let val = this.#connectedRealms.get(realm);
    val--;
    if (val <= 0) {
      this.#connectedRealms.delete(realm);
    }
  }
}
class ReadableHeadTracker extends EventTarget {
  constructor(writable) {
    super();

    this.writable = writable;

    writable.addEventListener('migrate', e => {
      this.dispatchEvent(new MessageEvent('migrate', {
        data: e.data,
      }));
    });
  }
  getHeadRealm() {
    return this.writable.getHeadRealm();
  }
  /* isLinked() {
    return this.writable.isLinked();
  } */
  setHeadRealm(realm) {
    // nothing
  }
  linkRealm(realm) {
    // nothing
  }
  unlinkRealm(realm) {
    // nothing
  }
  updateHeadRealm(headPosition) {
    // nothing
  }
}

//

// let etCount = 0;
class EntityTracker extends EventTarget {
  constructor() {
    super();

    // console.log('make entity tracker', new Error().stack);
    // if (etCount > 0) {
    //   debugger;
    // }
    // etCount++;

    this.virtualMaps = new Map();
    this.linkedRealms = new Map();
    this.cleanupFns = new Map();

    this.stack = new Error().stack;
  }
  getSize() {
    return this.virtualMaps.size;
  }
  linkMap(realm, map) {
    // sanityCheck();

    // bind local array maps to virtual maps
    const _getOrCreateVirtualMap = (arrayIndexId) => {
      let virtualMap = this.virtualMaps.get(map.arrayIndexId);
      if (!virtualMap) {
        // console.log('*** create new', map.arrayId, arrayIndexId);
        virtualMap = new HeadlessVirtualEntityMap(arrayIndexId);
        if (!map.arrayIndexId) {
          debugger;
        }
        this.virtualMaps.set(map.arrayIndexId, virtualMap);

        virtualMap.addEventListener('garbagecollect', e => {
          this.virtualMaps.delete(map.arrayIndexId);

          this.dispatchEvent(new MessageEvent('entityremove', {
            data: {
              entityId: arrayIndexId,
              entity: virtualMap,
              // realm,
            },
          }));
        });
      } else {
        // console.log('*** create old', map.arrayId, arrayIndexId);
      }
      return virtualMap;
    };

    // sanityCheck();

    const added = !this.virtualMaps.has(map.arrayIndexId);
    const virtualMap = _getOrCreateVirtualMap(map.arrayIndexId);

    // sanityCheck();

    virtualMap.link(map.arrayId, realm);
    // sanityCheck();
    if (added) {
      this.dispatchEvent(new MessageEvent('entityadd', {
        data: {
          entityId: map.arrayIndexId,
          entity: virtualMap,
          // realm,
        },
      }));
      // sanityCheck();
    }
    return virtualMap;
  }
  unlinkMap(realm, arrayId, arrayIndexId) {
    // console.log('entity tracker unlink map', realm, arrayIndexId);

    // if (window.lol) {
    //   debugger;
    // }

    const virtualMap = this.virtualMaps.get(arrayIndexId);
    if (!virtualMap) {
      debugger;
    }
    virtualMap.unlink(arrayId, realm);

    // this.virtualMaps.delete(arrayIndexId);
  }
  // each realm will only be linked once
  #linkInternal(arrayId, realm) {
    const key = arrayId + ':' + realm.key;

    if (this.cleanupFns.get(key)) {
      debugger;
    }

    if (!this.linkStacks) {
      this.linkStacks = new Map();
      this.linkStacks.set(key, new Error().stack);
    }

    const {dataClient} = realm;
    const dcArray = dataClient.getArray(arrayId); // note: auto listen

    
    // if (/worldApps/.test(arrayId)) {
    //   window.dcArray = dcArray;
    //   window.dcArraySize = dcArray.getSize();
    // }
    
    const localVirtualMaps = new Map();
    const _bind = map => {
      const virtualMap = this.linkMap(realm, map);
      localVirtualMaps.set(map.arrayIndexId, virtualMap);
    };
    const _unbind = arrayIndexId => {
      this.unlinkMap(realm, dcArray.arrayId, arrayIndexId);
      localVirtualMaps.delete(arrayIndexId);
    };
    const _bindAll = linkedArrayIds => {
      for (const arrayIndexId of linkedArrayIds) {
        const map = dcArray.dataClient.getArrayMap(arrayId, arrayIndexId, {
          listen: false,
        });
        _bind(map);
      }
    };
    const _unbindAll = linkedArrayIds => {
      for (const arrayIndexId of linkedArrayIds) {
        _unbind(arrayIndexId);
      }
    };

    const onimport = e => {
      if (localVirtualMaps.size !== 0) {
        debugger;
      }
      // if (/worldApps/.test(arrayId) && realm.key === '300:0:300') {
        const keys = dcArray.getKeys();
        for (const arrayIndexId of keys) {
          const map = dcArray.dataClient.getArrayMap(arrayId, arrayIndexId, {
            listen: false,
          });
          _bind(map);
        }

        // XXX need to initialize links here
        // debugger;
      // }
    };
    dcArray.dataClient.addEventListener('import', onimport);

    const addKey = 'add.' + dcArray.arrayId;
    // console.log('listen add', addKey);
    const onadd = e => {
      // if (/worldApps/.test(arrayId)) {
      //   debugger;
      // }
      const {arrayIndexId} = e.data;
      const map = dcArray.getMap(arrayIndexId, {
        listen: false,
      });
      _bind(map);
    };
    dcArray.dataClient.addEventListener(addKey, onadd);
    const removeKey = 'remove.' + dcArray.arrayId;
    const onremove = e => {
      // if (/worldApps/.test(arrayId)) {
      //   debugger;
      // }
      const {arrayIndexId} = e.data;
      _unbind(arrayIndexId);
    };
    dcArray.dataClient.addEventListener(removeKey, onremove);
    
    const removeArrayKey = 'removeArray.' + dcArray.arrayId;
    const onremovearray = e => {
      // if (/worldApps/.test(arrayId)) {
        // debugger;
      // }
      // console.log('got remove array', this, e.data);
      const linkedArrayIds = Array.from(localVirtualMaps.keys());
      _unbindAll(linkedArrayIds);
      localVirtualMaps.clear();
    };
    dcArray.dataClient.addEventListener(removeArrayKey, onremovearray);

    const importArrayKey = 'importArray.' + dcArray.arrayId;
    const onimportarray = e => {
      // if (/worldApps/.test(arrayId)) {
      //   debugger;
      // }
      // XXX it better be our array
      const {arrayCrdtExport, mapCrdtExports} = e.data;
      // debugger;
      const linkedArrayIds = Object.keys(arrayCrdtExport);
      _bindAll(linkedArrayIds);
    };
    dcArray.dataClient.addEventListener(importArrayKey, onimportarray);

    // initial listen for existing elements
    const arrayIndexIds = dcArray.getKeys();
    /* if (arrayIndexIds.length > 0) {
      debugger;
    } */
    for (const arrayIndexId of arrayIndexIds) {
      const map = new DCMap(arrayId, arrayIndexId, realm.dataClient);
      _bind(map);
    }

    // console.log('link key', key);
    this.cleanupFns.set(key, () => {
      // console.log('unlink key', key);

      // if (/worldApps/.test(arrayId)) {
      //   debugger;
      // }

      // unbind array virtual maps
      dcArray.unlisten();
      dcArray.dataClient.removeEventListener('import', onimport);
      dcArray.dataClient.removeEventListener(addKey, onadd);
      dcArray.dataClient.removeEventListener(removeKey, onremove);
      dcArray.dataClient.removeEventListener(removeArrayKey, onremovearray);
      dcArray.dataClient.removeEventListener(importArrayKey, onimportarray);

      for (const arrayIndexId of localVirtualMaps.keys()) {
        // console.log('unlink', [realm, dcArray.arrayId, arrayIndexId]);
        this.unlinkMap(realm, dcArray.arrayId, arrayIndexId);
      }
      // localVirtualMaps.clear();

      /* for (const localVirtualMap of localVirtualMaps.values()) {
        if (!localVirtualMap.unlinkFilter) {
          debugger;
        }
        localVirtualMap.unlinkFilter((arrayIndexId, map) => {
          if (!map?.dataClient?.userData?.realm) {
            debugger;
          }
          return realm === map.dataClient.userData.realm;
        });
      } */
    });
  }
  // returns whether the realm was linked
  link(arrayId, realm) {
    this.#linkInternal(arrayId, realm);
  }
  #unlinkInternal(arrayId, realm) {
    const key = arrayId + ':' + realm.key;
    if (!this.cleanupFns.get(key)) {
      debugger;
    }
    this.cleanupFns.get(key)();
    this.cleanupFns.delete(key);
  }
  // returns whether the realm was unlinked
  unlink(arrayId, realm) {
    this.#unlinkInternal(arrayId, realm);
  }
}

class VirtualPlayer extends HeadTrackedEntity {
  constructor(arrayId, arrayIndexId, realms, name, opts) {
    super(opts?.headTracker);

    this.arrayId = arrayId;
    this.arrayIndexId = arrayIndexId;
    this.realms = realms;
    this.name = name;

    const readableHeadTracker = this.headTracker.getReadable();
    this.playerApps = new VirtualEntityArray('playerApps:' + this.arrayIndexId, this.realms, {
      headTracker: readableHeadTracker,
      entityTracker: opts?.appsEntityTracker,
    });
    this.playerActions = new VirtualEntityArray('playerActions:' + this.arrayIndexId, this.realms, {
      headTracker: readableHeadTracker,
      entityTracker: opts?.actionsEntityTracker,
    });
    this.cleanupMapFns = new Map();
  }
  initializePlayer(o, {
    appVals = [],
    appIds = [],
    actionVals = [],
    actionValIds = [],
  } = {}) {
    this.headTracker.updateHeadRealm(o.position);
    const headRealm = this.headTracker.getHeadRealm();

    const _initializeApps = () => {
      for (let i = 0; i < appVals.length; i++) {
        const appVal = appVals[i];
        const appId = appIds[i] ?? makeId();
        const deadHandUpdate = headRealm.dataClient.deadHandArrayMap(this.playerApps.arrayId, appId, this.realms.playerId);
        headRealm.emitUpdate(deadHandUpdate);

        // console.log('initialize player add player app 1', appVal, appId);
        const map = this.playerApps.addEntityAt(appId, appVal, headRealm);
        // console.log('initialize player add player app 2', appVal, appId, map);
      }
    };
    _initializeApps();

    const _initializeActions = () => {
      for (let i = 0; i < actionVals.length; i++) {
        const actionVal = actionVals[i];
        const actionId = actionValIds[i] ?? makeId();
        const deadHandUpdate = headRealm.dataClient.deadHandArrayMap(this.playerActions.arrayId, actionId, this.realms.playerId);
        headRealm.emitUpdate(deadHandUpdate);

        // console.log('add entity 1');
        const map = this.playerActions.addEntityAt(actionId, actionVal, headRealm);
        // console.log('added player action', actionVal, actionId, map);
        // console.log('add entity 2');
      }
    };
    _initializeActions();

    const _initializePlayer = () => {
      const deadHandUpdate = headRealm.dataClient.deadHandArrayMap(this.arrayId, this.arrayIndexId, this.realms.playerId);
      headRealm.emitUpdate(deadHandUpdate);
      
      const playersArray = headRealm.dataClient.getArray(this.arrayId, {
        listen: false,
      });
      const {
        // map,
        update,
      } = playersArray.addAt(this.arrayIndexId, o, {
        listen: false,
      });
      headRealm.emitUpdate(update);
    };
    _initializePlayer();
  }
  link(realm) {
    const {dataClient} = realm;
    const map = dataClient.getArrayMap(this.arrayId, this.arrayIndexId); // note: this map might not exist in the crdt yet
    const update = e => {
      const {key, val} = e.data;
      
      this.dispatchEvent(new MessageEvent('update', {
        data: e.data,
      }));

      if (key === positionKey) {
        this.headTracker.updateHeadRealm(val);
      }
    };
    map.addEventListener('update', update);
    
    // XXX need to handle initial position set here
    // XXX note however that it won't be here on the first tick, because the first tick is just the link before the connect
    // XXX therefore we probably need to listen to the array wait here, so we get it once we connect
    // XXX OR, we can defer ream linking until the connection succeeds and the data is ready to read here (and update the head tracker)
    // debugger;
    
    // link child arrays
    this.playerApps.link(realm);
    this.playerActions.link(realm);
    
    // link initial position
    this.headTracker.linkRealm(realm);
    const _initHeadRealmFromPosition = () => {
      const position = map.getKey(positionKey);
      this.headTracker.updateHeadRealm(position);
    };

    const parentArray = new DCArray(this.arrayId, realm.dataClient);
    const addKey = 'add.' + parentArray.arrayId;
    const onParentArrayAdd = e => {
      if (e.data.key === this.arrayIndexId) {
        _initHeadRealmFromPosition();
      }
    };
    if (parentArray.hasKey(this.arrayIndexId)) {
      // if the object exists in the array, we can initialize the head tracker now
      _initHeadRealmFromPosition();
    } else {
      // else if the object does not exist in the array, we need to wait for it to be added
      parentArray.listen();
      parentArray.addEventListener(addKey, onParentArrayAdd);
    }

    // cleanup
    this.cleanupMapFns.set(realm, () => {
      this.headTracker.unlinkRealm(realm);
      
      map.unlisten();
      map.removeEventListener('update', update);

      this.playerApps.unlink(realm);
      this.playerActions.unlink(realm);

      parentArray.unlisten();
      parentArray.removeEventListener(addKey);
    });
  }
  unlink(realm) {
    this.cleanupMapFns.get(realm)();
    this.cleanupMapFns.delete(realm);
  }
  getKey(key) {
    const headRealm = this.headTracker.getHeadRealm();
    const {dataClient} = headRealm;
    const valueMap = dataClient.getArrayMap(this.arrayId, this.arrayIndexId, {
      listen: false,
    });
    return valueMap.getKey(key);
  }
  setKeyValue(key, val) {
    const headRealm = this.headTracker.getHeadRealm();
    const {dataClient} = headRealm;
    const valueMap = dataClient.getArrayMap(this.arrayId, this.arrayIndexId, {
      listen: false,
    });
    const update = valueMap.setKeyValueUpdate(key, val);
    headRealm.emitUpdate(update);
  }
}

class VirtualPlayersArray extends EventTarget {
  constructor(arrayId, parent, opts) {
    super();

    this.arrayId = arrayId;
    this.parent = parent;
    this.opts = opts;

    this.virtualPlayers = new Map();
    this.cleanupFns = new Map();
  }
  getOrCreateVirtualPlayer(playerId) {
    let virtualPlayer = this.virtualPlayers.get(playerId);
    if (!virtualPlayer) {
      virtualPlayer = new VirtualPlayer(this.arrayId, playerId, this.parent, 'remote', {
        appsEntityTracker: this.opts?.appsEntityTracker,
        actionsEntityTracker: this.opts?.actionsEntityTracker,
      });
      this.virtualPlayers.set(playerId, virtualPlayer);
    }
    return virtualPlayer;
  }
  link(realm) {
    const {dataClient, networkedDataClient, networkedAudioClient} = realm;

    const _linkData = () => {
      const playersArray = dataClient.getArray(this.arrayId);

      const _linkPlayer = arrayIndexId => {
        const playerId = arrayIndexId;
        if (playerId === this.parent.playerId) {
          // this.parent.localPlayer;
        } else {
          const created = !this.virtualPlayers.has(playerId);
          const virtualPlayer = this.getOrCreateVirtualPlayer(playerId);
          virtualPlayer.link(realm);
          if (created) {
            this.dispatchEvent(new MessageEvent('join', {
              data: {
                player: virtualPlayer,
                playerId,
              },
            }));
          }
        }
      };
      const _unlinkPlayer = arrayIndexId => {
        const playerId = arrayIndexId;

        if (playerId == this.parent.playerId) {
          // this.parent.localPlayer;
        } else {
          const virtualPlayer = this.virtualPlayers.get(playerId);
          if (virtualPlayer) {
            virtualPlayer.unlink(realm);
            if (!virtualPlayer.headTracker.isLinked()) {
              this.virtualPlayers.delete(playerId);
              
              virtualPlayer.dispatchEvent(new MessageEvent('leave'));
              this.dispatchEvent(new MessageEvent('leave', {
                data: {
                  player: virtualPlayer,
                  playerId,
                },
              }));
            }
          } else {
            console.warn('removing nonexistent player', playerId, this.players);
          }
        }
      };

      const onadd = e => {
        // console.log('got player add', e.data);
        const {arrayIndexId, map, val} = e.data;
        _linkPlayer(arrayIndexId);
      };
      playersArray.addEventListener('add', onadd);

      const onremove = e => {
        // console.log('got player remove', e.data);
        const {arrayIndexId} = e.data;
        _unlinkPlayer(arrayIndexId);
      };
      playersArray.addEventListener('remove', onremove);

      /* const importArrayKey = 'importArray.' + this.arrayId;
      const onimportarray = e => {
        console.log('got player importarray', e.data);
        // const {arrayIndexId} = e.data;
      };
      dataClient.addEventListener(importArrayKey, onimportarray);

      const importMapKey = 'importMap.' + this.arrayId;
      const onimportmap = e => {
        const {arrayIndexId} = e.data;
        _linkPlayer(arrayIndexId);
      };
      dataClient.addEventListener(importMapKey, onimportmap); */

      // link initial players
      for (const arrayIndexId of playersArray.getKeys()) {
        _linkPlayer(arrayIndexId);
      }

      this.cleanupFns.set(networkedDataClient, () => {
        playersArray.unlisten();

        playersArray.removeEventListener('add', onadd);
        playersArray.removeEventListener('remove', onremove);

        // dataClient.removeEventListener(importArrayKey, onimportarray);
        // dataClient.removeEventListener(importMapKey, onimportmap);
      });
    };
    _linkData();

    const _linkAudio = () => {
      const audiostreamstart = e => {
        this.dispatchEvent(new MessageEvent('audiostreamstart', {
          data: e.data,
        }));
      };
      /* if (!networkedAudioClient) {
        debugger;
      } */
      networkedAudioClient.addEventListener('audiostreamstart', audiostreamstart);
      const audiostreamend = e => {
        this.dispatchEvent(new MessageEvent('audiostreamend', {
          data: e.data,
        }));
      };
      networkedAudioClient.addEventListener('audiostreamend', audiostreamend);

      this.cleanupFns.set(networkedAudioClient, () => {
        networkedAudioClient.removeEventListener('audiostreamstart', audiostreamstart);
        networkedAudioClient.removeEventListener('audiostreamend', audiostreamend);
      });
    };
    _linkAudio();
  }
  unlink(realm) {
    const {networkedDataClient, networkedAudioClient} = realm;

    this.cleanupFns.get(networkedDataClient)();
    this.cleanupFns.delete(networkedDataClient);

    this.cleanupFns.get(networkedAudioClient)();
    this.cleanupFns.delete(networkedAudioClient);
  }
}
class VirtualEntityArray extends VirtualPlayersArray {
  constructor(arrayId, realms, opts) {
    super(arrayId, realms);

    // note: the head tracker is only for passing down to needled virtual entities we create
    // we do not use the head tracker in this class, because arrays do not have a head
    this.headTracker = opts?.headTracker ?? null;
    this.entityTracker = opts?.entityTracker ?? null;

    this.needledVirtualEntities = new Map(); // entity -> needled entity

    this.entityTracker.addEventListener('entityadd', e => {
      const {entityId, entity} = e.data;
      sanityCheck();
      const needledEntity = new NeedledVirtualEntityMap(entity, this.headTracker);

      // needledEntity.toObject();

      needledEntity.cleanupFn = () => {
        needledEntity.destroy();
        this.dispatchEvent(new MessageEvent('needledentityremove', {
          data: {
            entityId,
            needledEntity,
          },
        }));
      };
      this.needledVirtualEntities.set(entity, needledEntity);

      sanityCheck();

      // XXX this emit should not be passthrough, but a saturation accumulator for whether this exact array view currently sees the entity
      this.dispatchEvent(new MessageEvent('needledentityadd', {
        data: {
          entityId,
          needledEntity,
        },
      }));
      sanityCheck();
    });
    this.entityTracker.addEventListener('entityremove', e => {
      const {entityId, entity} = e.data;

      const needledEntity = this.needledVirtualEntities.get(entity);
      needledEntity.cleanupFn();
      this.needledVirtualEntities.delete(entity);
    });

    const needledEntityCleanupFns = new Map();
    this.addEventListener('needledentityadd', e => {
      const {needledEntity} = e.data;
      // if (window.lol) {
      //   debugger;
      // }
      let position = needledEntity.entityMap.getInitial(positionKey);
      if (!position) {
        position = [0, 0, 0];
      }
      if (needledEntity.entityMap.maps.size !== 1) {
        debugger;
        throw new Error('expected a single value at binding time');
      }
      const realm = needledEntity.entityMap.maps.values().next().value.map.dataClient.userData.realm;
      if (!realm) {
        debugger;
      }
      needledEntity.headTracker.setHeadRealm(realm);

      const update = e => {
        const {key, val} = e.data;
        if (key === positionKey) {
          needledEntity.headTracker.updateHeadRealm(val);
        }
      };
      needledEntity.addEventListener('update', update);

      needledEntityCleanupFns.set(needledEntity, e => {
        needledEntity.removeEventListener('update', update);  
      });
    });
    this.addEventListener('needledentityremove', e => {
      const {needledEntity} = e.data;
      needledEntityCleanupFns.get(needledEntity)();
      needledEntityCleanupFns.delete(needledEntity);
    });
  }
  addEntityAt(arrayIndexId, val, realm) {
    const deadHandUpdate = realm.dataClient.deadHandArrayMap(this.arrayId, arrayIndexId, this.parent.playerId);
    realm.emitUpdate(deadHandUpdate);
    
    const array = new DCArray(this.arrayId, realm.dataClient);
    const {
      map,
      update,
    } = array.addAt(arrayIndexId, val);
    realm.emitUpdate(update);

    const liveHandUpdate = realm.dataClient.liveHandArrayMap(this.arrayId, arrayIndexId, this.parent.playerId);
    realm.emitUpdate(liveHandUpdate);

    return map;
  }
  getSize() {
    return this.entityTracker.getSize();
  }
  addEntity(val, realm) {
    return this.addEntityAt(makeId(), val, realm);
  }
  /* first() {
    for (const map of this.virtualMaps.values()) {
      return map;
    }
    return null;
  } */
  getVirtualMap(arrayIndexId) {
    const entityMap = this.entityTracker.virtualMaps.get(arrayIndexId);
    const needledEntity = this.needledVirtualEntities.get(entityMap);
    return needledEntity;
  }
  getVirtualMapAt(index) {
    return Array.from(this.needledVirtualEntities.values())[index];
  }
  getKeys() {
    return Array.from(this.needledVirtualEntities.keys()).map(entityMap => {
      return entityMap.arrayIndexId;
    });
  }
  toArray() {
    return Array.from(this.needledVirtualEntities.values()).map(needledEntity => {
      const realm = needledEntity.headTracker.getHeadRealm();
      const entityMap = needledEntity.entityMap;
      const headMap = entityMap.getHeadMapFromRealm(realm);
      return headMap.toObject();
    });
  }
  linkedRealms = new Map();
  link(realm) {
    // const {dataClient} = realm;
    // const dcArray = dataClient.getArray(this.arrayId, {
    //   listen: false,
    // });
    
    // console.log('link', this.r, this.arrayId, dcArray.toArray());

    if (!this.linkedRealms.has(realm.key)) {
      this.linkedRealms.set(realm.key, new Error().stack);
    } else {
      debugger;
    }

    // link the entity tracker
    // if (/worldApps/.test(this.arrayId)) {
    //   debugger;
    // }
    this.entityTracker.link(this.arrayId, realm);

    this.cleanupFns.set(realm, () => {
      // unlink the entity tracker
      this.entityTracker.unlink(this.arrayId, realm);
    });
  }
  unlink(realm) {
    // if (/playerApps/.test(this.arrayId)) {
    //   console.log('unlink realm', this.arrayId, realm.key);
    // }
    if (this.linkedRealms.has(realm.key)) {
      this.linkedRealms.delete(realm.key);
    } else {
      debugger;
    }

    this.cleanupFns.get(realm)();
    this.cleanupFns.delete(realm);
  }
}

//

class VirtualIrc {
  constructor(parent) {
    this.parent = parent;
    this.cleanupFns = new Map();
  }
  link(realm) {
    const {networkedIrcClient} = realm;

    // note: this is not a good place for this, since it doesn't have to do with players
    // it's here for convenience
    const onchat = e => {
      this.parent.dispatchEvent(new MessageEvent('chat', {
        data: e.data,
      }));
    };
    networkedIrcClient.addEventListener('chat', onchat);

    this.cleanupFns.set(networkedIrcClient, () => {
      // networkedIrcClient.removeEventListener('join', onjoin);
      // networkedIrcClient.removeEventListener('leave', onleave);
      networkedIrcClient.removeEventListener('chat', onchat);
    });
  }
  unlink(realm) {
    const {networkedIrcClient} = realm;

    this.cleanupFns.get(networkedIrcClient)();
    this.cleanupFns.delete(networkedIrcClient);
  }
}

//

window.bannedLinks = [];

// one per arrayIndexId per EntityTracker
class HeadlessVirtualEntityMap extends EventTarget {
  constructor(arrayIndexId) {
    super();

    this.arrayIndexId = arrayIndexId;

    this.maps = new Map(); // bound dc maps
    this.cleanupFns = new Map();
    this.linkStacks = new Map();
  }
  /* getHeadMap() {
    // try to use a map from the current head realm
    const headRealm = this.headTracker.getHeadRealm();
    if (headRealm) {
      const map = this.getHeadMapFromRealm(headRealm);
      if (!map) {
        debugger;
      }
      return map;
    }
    // otherwise, try to use the only map
    if (this.maps.size === 1) {
      return this.maps.values().next().value.map;
    } else {
      return null;
    }
  } */
  getInitial(key) { // can only be used if there is one bound map
    if (this.maps.size !== 1) {
      debugger;
      throw new Error('cannot get initial value: ' + this.maps.size);
    } else {
      const map = this.maps.values().next().value.map;
      return map.getKey(key);
    }
  }
  getHeadMapFromRealm(realm) {
    for (const map of this.maps.values()) {
      if (map.map.dataClient === realm.dataClient) {
        return map.map;
      }
    }
    debugger;
    return null;
  }
  links = new Set();
  lastLinks = [];
  bannedLinks = [];
  link(arrayId, realm) {
    const key = arrayId + ':' + realm.key;

    // if (window.lol && realm.key === '0:0:0') {
    //   debugger;
    // }

    if (this.bannedLinks.includes(key)) {
      debugger;
    }
    if (this.links.has(key)) {
      debugger;
    }
    this.lastLinks.push([
      key,
      new Error().stack,
    ]);
    this.links.add(key);
    this.linkStacks.set(key, new Error().stack);

    // listen
    const map = new DCMap(arrayId, this.arrayIndexId, realm.dataClient);
    map.listen();
    this.maps.set(key, {
      map,
      realm,
    });

    const update = e => {
      this.dispatchEvent(new MessageEvent('update', {
        data: e.data,
      }));
    };
    map.addEventListener('update', update);

    // if (/worldApps/.test(arrayId)) {
    //   debugger;
    // }

    // XXX listen for this at the needled entity level, in order to headTracker.linkRealm(realm)
    this.dispatchEvent(new MessageEvent('link', {
      data: {
        realm,
      },
    }));

    this.cleanupFns.set(key, () => {
      map.removeEventListener('update', update);

      this.dispatchEvent(new MessageEvent('unlink', {
        data: {
          realm,
        },
      }));
    });
  }
  unlink(arrayId, realm) {
    // console.log('unlink realm', realm.key, this.arrayIndexId);

    const key = arrayId + ':' + realm.key;

    // if (/worldApps/.test(arrayId)) {
    // if (window.lol) {  
      // debugger;
      this.bannedLinks.push([
        key,
        new Error().stack,
      ]);
    // }
    // }

    if (!this.links.has(key)) {
      debugger;
    }
    this.links.delete(key);

    if (!this.maps.has(key)) {
      debugger;
    }
    this.maps.delete(key);

    this.cleanupFns.get(key)();
    this.cleanupFns.delete(key);

    // garbage collect
    // console.log('check maps size', arrayId, Array.from(this.maps.keys()), Array.from(this.maps.values()));
    if (this.maps.size === 0) {
      // console.log('garbage collect virtual entity map', arrayId, this.arrayIndexId);
      // if (/playerApps/.test(arrayId)) {
      //   debugger;
      // }
      this.dispatchEvent(new MessageEvent('garbagecollect'));
    }
  }
}

class NeedledVirtualEntityMap extends HeadTrackedEntity {
  constructor(entityMap, headTracker) {
    super(headTracker);

    this.entityMap = entityMap; // headless entity map

    const onlink = e => {
      const {realm} = e.data;
      // console.log('needled entity map link', realm.key);
      this.headTracker.linkRealm(realm);
    };
    this.entityMap.addEventListener('link', onlink);
    const onunlink = e => {
      const {realm} = e.data;
      // console.log('needled entity map unlink', realm.key);
      this.headTracker.unlinkRealm(realm);
    };
    this.entityMap.addEventListener('unlink', onunlink);

    this.destroy = () => {
      this.entityMap.removeEventListener('link', onlink);
      this.entityMap.removeEventListener('unlink', onunlink);
    };

    for (const {map, realm} of this.entityMap.maps.values()) {
      this.headTracker.linkRealm(realm);
    }

    // if (!this.toObject()) {
    //   debugger;
    // }
  }
  get(key) {
    const realm = this.headTracker.getHeadRealm();
    const map = this.entityMap.getHeadMapFromRealm(realm);
    // if (!map) {
    //   debugger;
    // }
    /* const map = headRealm.dataClient.getArrayMap(this.parent.arrayId, this.arrayIndexId, {
      listen: false,
    }); */
    return map.getKey(key);
  }
  set(key, val) {
    const realm = this.headTracker.getHeadRealm();
    const map = this.entityMap.getHeadMapFromRealm(realm);
    // if (!map) {
    //   debugger;
    // }
    const update = map.setKeyValueUpdate(key, val);
    // console.log('got update', update);
    realm.emitUpdate(update);
  }
  remove() {
    const realm = this.headTracker.getHeadRealm();
    const map = this.entityMap.getHeadMapFromRealm(realm);
    if (!map) {
      debugger;
    }
    const array = map.dataClient.getArray(map.arrayId, map.arrayIndexId, {
      listen: false,
    });
    /* const array = headRealm.dataClient.getArray(this.parent.arrayId, {
      listen: false,
    }); */
    const update = array.removeAt(this.entityMap.arrayIndexId);
    realm.emitUpdate(update);

    // the head might have changed if it pointed at this entity map
    // in that case, we need to update the head as if this were an initialization
    // this.snapHeadRealm();
  }
  /* snapHeadRealm() {
    if (this.entityMap.maps.size > 0) {
      const initialPosition = this.entityMap.getInitial(positionKey);
      if (initialPosition) {
        this.headTracker.updateHeadRealm(initialPosition);
      }
    }
  } */
  toObject() {
    const realm = this.headTracker.getHeadRealm();
    const map = this.entityMap.getHeadMapFromRealm(realm);
    // if (!map?.toObject) {
    //   debugger;
    // }
    return map.toObject();
  }
}

//

export class NetworkRealm extends EventTarget {
  constructor(min, size, parent) {
    super();
    
    this.min = min;
    this.size = size;
    this.parent = parent;

    this.key = min.join(':');
    this.connected = false;
    
    const dc1 = new DataClient({
      crdt: new Map(),
      userData: {
        realm: this,
      },
    });
    this.dataClient = dc1;
    this.ws = null;
    this.networkedDataClient = new NetworkedDataClient(dc1, {
      userData: {
        realm: this,
      },
    });
    this.networkedIrcClient = new NetworkedIrcClient(this.parent.playerId);
    this.networkedAudioClient = new NetworkedAudioClient(this.parent.playerId);
  }
  /* sendRegisterMessage() {
    this.networkedIrcClient.sendRegisterMessage();
  } */
  sendChatMessage(message) {
    this.networkedIrcClient.sendChatMessage(message);
  }
  async connect() {
    const ws1 = createWs('realm:' + this.key, this.parent.playerId);
    ws1.binaryType = 'arraybuffer';
    this.ws = ws1;
    await Promise.all([
      this.networkedDataClient.connect(ws1),
      this.networkedIrcClient.connect(ws1),
      this.networkedAudioClient.connect(ws1),
    ]);
    this.connected = true;
  }
  disconnect() {
    this.ws.close();
    /* const updates = this.dataClient.clearUpdates();
    console.log('realm disconnect', updates);
    for (const update of updates) {
      this.dataClient.emitUpdate(update);
    } */
    this.connected = false;
  }
  emitUpdate(update) {
    // if (update.type === 'add.worldApps') {
    //   console.log('emit update to realm', this.key, update.type, update);
    // }
    this.dataClient.emitUpdate(update);
    this.networkedDataClient.emitUpdate(update);
  }
}

//

class VirtualWorld extends EventTarget {
  constructor(arrayId, realms, opts) {
    super();

    this.worldApps = new VirtualEntityArray(arrayId, realms, {
      entityTracker: opts?.entityTracker,
    });
  }
  link(realm) {
    this.worldApps.link(realm);
  }
  unlink(realm) {
    this.worldApps.unlink(realm);
  }
}

//

export class NetworkRealms extends EventTarget {
  constructor(playerId) {
    super();

    this.playerId = playerId;

    this.lastPosition = [NaN, NaN, NaN];
    this.headTracker = new HeadTracker('localPlayer', this);
    this.appsEntityTracker = new EntityTracker();
    this.actionsEntityTracker = new EntityTracker();
    this.localPlayer = new VirtualPlayer('players', this.playerId, this, 'local', {
      headTracker: this.headTracker,
      appsEntityTracker: this.appsEntityTracker,
      actionsEntityTracker: this.actionsEntityTracker,
    });
    this.world = new VirtualWorld('worldApps', this, {
      entityTracker: this.appsEntityTracker,
    });

    this.players = new VirtualPlayersArray('players', this, {
      appsEntityTracker: this.appsEntityTracker,
      actionsEntityTracker: this.actionsEntityTracker,
    });
    this.headTracker.addEventListener('migrate', function(e) { // note: binding local this -> this.localPlayer
      const {oldHeadRealm, newHeadRealm} = e.data;

      // old objects
      const oldPlayersArray = oldHeadRealm.dataClient.getArray(this.arrayId, {
        listen: false,
      });
      const oldPlayerAppsArray = oldHeadRealm.dataClient.getArray('playerApps:' + this.realms.playerId, {
        listen: false,
      });
      const oldPlayerActionsArray = oldHeadRealm.dataClient.getArray('playerActions:' + this.realms.playerId, {
        listen: false,
      });
      const oldPlayerMap = oldPlayersArray.getMap(this.arrayIndexId, {
        listen: false,
      });

      // new objects
      const newPlayersArray = newHeadRealm.dataClient.getArray(this.arrayId, {
        listen: false,
      });
      const newPlayerAppsArray = newHeadRealm.dataClient.getArray('playerApps:' + this.realms.playerId, {
        listen: false,
      });
      const newPlayerActionsArray = newHeadRealm.dataClient.getArray('playerActions:' + this.realms.playerId, {
        listen: false,
      });

      const playerId = this.realms.playerId;
      // console.log('move realm ', playerId, oldHeadRealm.key, ' -> ', newHeadRealm.key);

      // set dead hands
      const deadHandKeys = [
        this.arrayId + '.' + this.arrayIndexId, // player
        'playerApps:' + this.arrayIndexId, // playerApps
        'playerActions:' + this.arrayIndexId, // playerActions
      ];
      const _emitDeadHands = realm => {
        const deadHandupdate = realm.dataClient.deadHandKeys(deadHandKeys, this.realms.playerId);
        realm.emitUpdate(deadHandupdate);
      };
      // const _emitLiveHands = realm => {
      //   const liveHandupdate = realm.dataClient.liveHandKeys(deadHandKeys, this.realms.playerId);
      //   realm.emitUpdate(liveHandupdate);
      // };
      _emitDeadHands(oldHeadRealm);
      _emitDeadHands(newHeadRealm);

      // add new
      // import apps
      const playerAppsImportMessage = newPlayerAppsArray.importArrayUpdate(oldPlayerAppsArray);
      newHeadRealm.emitUpdate(playerAppsImportMessage);
      // import actions
      const playerActionsImportMessage = newPlayerActionsArray.importArrayUpdate(oldPlayerActionsArray);
      newHeadRealm.emitUpdate(playerActionsImportMessage);
      // import player
      const playerImportMessage = newPlayersArray.importMapUpdate(oldPlayerMap);
      newHeadRealm.emitUpdate(playerImportMessage);

      // delete old
      // delete apps
      const playerAppsDeleteMessage = oldPlayerAppsArray.removeArrayUpdate();
      oldHeadRealm.emitUpdate(playerAppsDeleteMessage);
      // delete actions
      const playerActionsDeleteMessage = oldPlayerActionsArray.removeArrayUpdate();
      oldHeadRealm.emitUpdate(playerActionsDeleteMessage);
      // delete player
      const oldPlayerRemoveUpdate = oldPlayerMap.removeUpdate();
      oldHeadRealm.emitUpdate(oldPlayerRemoveUpdate);

      // _emitLiveHands(oldHeadRealm);
    }.bind(this.localPlayer));
    
    this.irc = new VirtualIrc(this);
    this.connectedRealms = new Set();
    this.tx = makeTransactionHandler();
  }
  getVirtualPlayers() {
    return this.players;
  }
  getVirtualWorld() {
    return this.world;
  }
  getClosestRealm(position) {
    for (const realm of this.connectedRealms) {
      if (realm.connected) {
        const box = {
          min: realm.min,
          max: [
            realm.min[0] + realm.size,
            realm.min[1] + realm.size,
            realm.min[2] + realm.size,
          ],
        };
        // console.log('check box', box.min, box.max, position);
        if (boxContains(box, position)) {
          // console.log('got head', realm.min);
          return realm;
        }
      }
    }
    return null;
  }
  enableMic() {
    // XXX this needs to be a per-realm thing
    throw new Error('not implemented');
  }
  disableMic() {
    throw new Error('not implemented');
  }
  sendChatMessage(message) {
    const headRealm = this.localPlayer.headTracker.getHeadRealm();
    headRealm.sendChatMessage(message);
  }
  async updatePosition(position, realmSize, {
    onConnect,
  } = {}) {
    position = position.slice();

    const snappedPosition = position.map(v => Math.floor(v / realmSize) * realmSize);
    if (!arrayEquals(snappedPosition, this.lastPosition)) {
      this.lastPosition[0] = snappedPosition[0];
      this.lastPosition[1] = snappedPosition[1];
      this.lastPosition[2] = snappedPosition[2];

      await this.tx(async () => {
        const oldNumConnectedRealms = this.connectedRealms.size;

        const candidateRealms = [];
        for (let dz = -1; dz <= 1; dz++) {
          for (let dx = -1; dx <= 1; dx++) {
            const min = [
              Math.floor((snappedPosition[0] + dx * realmSize) / realmSize) * realmSize,
              0,
              Math.floor((snappedPosition[2] + dz * realmSize) / realmSize) * realmSize,
            ];
            const realm = new NetworkRealm(min, realmSize, this);
            candidateRealms.push(realm);
          }
        }

        // check if we need to connect to new realms
        const connectPromises = [];
        for (const realm of candidateRealms) {
          let foundRealm = null;
          for (const connectedRealm of this.connectedRealms) {
            if (connectedRealm.key === realm.key) {
              foundRealm = connectedRealm;
              break;
            }
          }

          if (!foundRealm) {
            realm.dispatchEvent(new Event('connecting'));
            this.dispatchEvent(new MessageEvent('realmconnecting', {
              data: {
                realm,
              },
            }));

            const connectPromise = (async () => {
              // try to connect
              // this.players.link(realm);
              // this.localPlayer.link(realm);
              // this.world.link(realm);
              // this.irc.link(realm);
              
              // try {
                await realm.connect();
              // } catch(err) {
                // this.players.unlink(realm);
                // this.localPlayer.unlink(realm);
                // this.world.unlink(realm);
                // this.irc.unlink(realm);
                // throw err;
              // }

              this.players.link(realm);
              this.localPlayer.link(realm);
              this.world.link(realm);
              this.irc.link(realm);

              this.connectedRealms.add(realm);

              // emit event
              realm.dispatchEvent(new Event('connect'));
              this.dispatchEvent(new MessageEvent('realmjoin', {
                data: {
                  realm,
                },
              }));
            })();
            connectPromises.push(connectPromise);
          }
        }
        await Promise.all(connectPromises);

        // if this is the first network configuration, initialize our local player
        if (oldNumConnectedRealms === 0 && connectPromises.length > 0) {
          onConnect && onConnect(position);
        }

        // check if we need to disconnect from any realms
        const oldRealms = [];
        for (const connectedRealm of this.connectedRealms) {
          if (!candidateRealms.find(candidateRealm => candidateRealm.key === connectedRealm.key)) {
            this.players.unlink(connectedRealm);
            this.localPlayer.unlink(connectedRealm);
            this.world.unlink(connectedRealm);
            this.irc.unlink(connectedRealm);

            connectedRealm.disconnect();
            this.connectedRealms.delete(connectedRealm);
            oldRealms.push(connectedRealm);
          }
        }
        for (const oldRealm of oldRealms) {
          this.dispatchEvent(new MessageEvent('realmleave', {
            data: {
              realm: oldRealm,
            },
          }));
        }

        // emit the fact that the network was reconfigured
        this.dispatchEvent(new MessageEvent('networkreconfigure'));
      });
    }

    if (this.localPlayer.headTracker.hasHeadRealm()) {
      this.localPlayer.setKeyValue(positionKey, position);
    }
  }
}