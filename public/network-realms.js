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
const distanceTo = (a, b) => {
  const [xa, ya, za] = a;
  const [xb, yb, zb] = b;
  const dx = xa - xb;
  const dy = ya - yb;
  const dz = za - zb;
  return Math.sqrt(dx*dx + dy*dy + dz*dz);
};
const boxContains = (box, point) => {
  const {min, max} = box;
  if (typeof point?.[0] !== 'number') {
    debugger;
  }
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

    this.headTracker = headTracker || new HeadTracker();
  }
  setHeadTracker(headTracker) {
    this.headTracker = headTracker;
  }
  isLinked() {
    debugger;
    return this.headTracker.isLinked();
  }
  updateHeadRealm(headPosition) {
   debugger;
  }
  setHeadRealm(realm) {
    debugger;
    this.headTracker.setHeadRealm(realm);
  }
}

//

class HeadTracker extends EventTarget {
  constructor() {
    super();
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

    if (this.isLinked()) {
      const newHeadRealm = _getHeadRealm(headPosition, Array.from(this.#connectedRealms.keys()));
      if (!this.#headRealm) {
        this.#headRealm = newHeadRealm;
      } else {
        const oldHeadRealm = this.#headRealm;
        if (newHeadRealm.key !== oldHeadRealm.key) {
          this.#headRealm = newHeadRealm;

          if (!Array.from(this.#connectedRealms.keys())[0].parent.tx.running) {
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
  }
  linkRealm(realm) {
    /* if (this.#connectedRealms.has(realm)) {
      debugger;
    } */
    let val = this.#connectedRealms.get(positionKey) ?? 0;
    val++;
    this.#connectedRealms.set(realm, val);
  }
  unlinkRealm(realm) {
    /* if (!this.#connectedRealms.has(realm)) {
      debugger;
    } */
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
  }
  setHeadRealm(realm) {
    // nothing
  } */
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
    console.log('entity tracker link map', realm, map);

    // bind local array maps to virtual maps
    const _getOrCreateVirtualMap = (arrayIndexId) => {
      let virtualMap = this.virtualMaps.get(map.arrayIndexId);
      if (!virtualMap) {
        // console.log('*** create new', arrayIndexId);
        virtualMap = new HeadlessVirtualEntityMap(arrayIndexId); // XXX pass through head tracker?
        // XXX emit virtual entity create event to bind head tracker?
        if (!map.arrayIndexId) {
          debugger;
        }
        this.virtualMaps.set(map.arrayIndexId, virtualMap);

        virtualMap.addEventListener('garbagecollect', e => {
          this.dispatchEvent(new MessageEvent('entityremove', {
            data: {
              entityId: arrayIndexId,
              entity: virtualMap,
              // realm,
            },
          }));
        });
      } else {
        // console.log('*** create old', arrayIndexId);
      }
      return virtualMap;
    };

    const added = !this.virtualMaps.has(map.arrayIndexId);
    const virtualMap = _getOrCreateVirtualMap(map.arrayIndexId);
    // console.log('link map', this.r, realm.key, Array.from(this.virtualMaps.entries()), map.arrayIndexId);
    
    // XXX 'preentityadd' event to capture the link event
    // XXX or, capture the missing links in needledentityadd construction (VirtualWorld entityadd handler)
    virtualMap.link(map.arrayId, realm);
    if (added) {
      /* if (this.headTracker) {
        const initialPosition = map.getKey('position');
        if (initialPosition) {
          this.headTracker.updateHeadRealm(initialPosition);
        }
      } */

      this.dispatchEvent(new MessageEvent('entityadd', { // XXX
        data: {
          entityId: map.arrayIndexId,
          entity: virtualMap,
          // realm,
        },
      }));
    }
    return virtualMap;
  }
  unlinkMap(realm, arrayId, arrayIndexId) {
    console.log('entity tracker unlink map', realm, arrayIndexId);

    // if (window.lol) {
    //   debugger;
    // }

    const virtualMap = this.virtualMaps.get(arrayIndexId);
    if (!virtualMap) {
      debugger;
    }
    virtualMap.unlink(arrayId, realm);
  }
  // each realm will only be linked once
  #linkInternal(arrayId, realm) {
    const key = arrayId + ':' + realm.key;

    if (!this.linkStacks) {
      this.linkStacks = new Map();
      this.linkStacks.set(key, new Error().stack);
    }

    const {dataClient} = realm;
    const dcArray = dataClient.getArray(arrayId); // note: auto listen

    const localVirtualMaps = new Map();

    const addKey = 'add.' + dcArray.arrayId;
    // console.log('listen add', addKey);
    const onadd = e => {
      const {arrayIndexId} = e.data;
      const map = dcArray.getMap(arrayIndexId, {
        listen: false,
      });
      console.log('VirtualEntityArray got entity add', this, arrayIndexId, realm.key, map);
      const virtualMap = this.linkMap(realm, map);
      localVirtualMaps.set(arrayIndexId, virtualMap);
    };
    dcArray.dataClient.addEventListener(addKey, onadd);
    const removeKey = 'remove.' + dcArray.arrayId;
    const onremove = e => {
      const {arrayIndexId} = e.data;
      console.log('VirtualEntityArray got entity remove', this, arrayIndexId, realm.key, e.data);
      if (window.lol) {
        debugger;
      }
      this.unlinkMap(realm, dcArray.arrayId, arrayIndexId);
      localVirtualMaps.delete(arrayIndexId);
    };
    dcArray.dataClient.addEventListener(removeKey, onremove); // XXX listen to the base dataClient events, not each listener dcarray
    
    const removeArrayKey = 'removeArray.' + dcArray.arrayId;
    const onremovearray = e => {
      // console.log('got remove array', this, e.data);
      const linkedArrayIds = Array.from(localVirtualMaps.keys());
      for (const arrayIndexId of linkedArrayIds) {
        console.log('VirtualEntityArray got entity array remove', this, arrayIndexId, realm.key, e.data);
        if (window.lol) {
          debugger;
        }
        this.unlinkMap(realm, dcArray.arrayId, arrayIndexId);
        localVirtualMaps.delete(arrayIndexId);
      }
    };
    dcArray.dataClient.addEventListener(removeArrayKey, onremovearray);

    const importArrayKey = 'importArray.' + arrayId;
    const onimportarray = e => {
      const {arrayCrdtExport, mapCrdtExports} = e.data;
      for (const arrayIndexId in arrayCrdtExport) {
        const map = dcArray.dataClient.getArrayMap(arrayId, arrayIndexId, {
          listen: false,
        });
        console.log('VirtualEntityArray got entity import', this, arrayIndexId, realm.key, map);
        const virtualMap = this.linkMap(realm, map);
        localVirtualMaps.set(arrayIndexId, virtualMap);
      }
    };
    dcArray.dataClient.addEventListener(importArrayKey, onimportarray);

    // initial listen for existing elements
    const arrayIndexIds = dcArray.getKeys();
    for (const arrayIndexId of arrayIndexIds) {
      const map = new DCMap(arrayId, arrayIndexId, realm.dataClient);
      console.log('VirtualEntityArray got entity add', this, arrayIndexId, realm.key, map);
      const virtualMap = this.linkMap(realm, map);
      localVirtualMaps.set(arrayIndexId, virtualMap);
    }

    // console.log('link key', key);
    this.cleanupFns.set(key, () => {
      const key = arrayId + ':' + realm.key;
      // console.log('unlink key', key);

      // unbind array virtual maps
      dcArray.unlisten();
      dcArray.dataClient.removeEventListener(addKey, onadd);
      dcArray.dataClient.removeEventListener(removeKey, onremove);
      dcArray.dataClient.removeEventListener(removeArrayKey, onremovearray);
      dcArray.dataClient.removeEventListener(importArrayKey, onimportarray);

      for (const arrayIndexId of localVirtualMaps.keys()) {
        this.unlinkMap(realm, dcArray.arrayId, arrayIndexId);
      }

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
  link(arrayId, realm) { // XXX pass in array id?
    this.#linkInternal(arrayId, realm);
    return true;
    /* if (!this.linkedRealms.has(realm.key)) {
      this.linkedRealms.set(realm.key, 1);
      this.#linkInternal(arrayId, realm);
      return true;
    } else {
      let numRealms = this.linkedRealms.get(realm.key);
      numRealms++;
      this.linkedRealms.set(realm.key, numRealms);
      return false;
    } */
  }
  #unlinkInternal(arrayId, realm) {
    const key = arrayId + ':' + realm.key;
    this.cleanupFns.get(key)();
    this.cleanupFns.delete(key);
  }
  // returns whether the realm was unlinked
  unlink(arrayId, realm) {
    this.#unlinkInternal(arrayId, realm);
    return true;
    /* let numRealms = this.linkedRealms.get(realm.key);
    numRealms--;
    if (numRealms > 0) {
      this.linkedRealms.set(realm.key, numRealms);
      return false;
    } else {
      this.#unlinkInternal(arrayId, realm);
      this.linkedRealms.delete(realm.key);
      return true;
    } */
  }
}

class VirtualPlayer extends HeadTrackedEntity {
  constructor(arrayId, arrayIndexId, realms, name, opts) {
    super(opts?.headTracker);

    this.arrayId = arrayId;
    this.arrayIndexId = arrayIndexId;
    this.realms = realms;
    this.name = name;

    if (!this.headTracker) {
      debugger;
    }

    const readableHeadTracker = this.headTracker.getReadable();
    this.playerApps = new VirtualEntityArray('playerApps:' + this.arrayIndexId, this.realms, {
      headTracker: readableHeadTracker,
      entityTracker: opts?.entityTracker,
    });
    this.playerActions = new VirtualEntityArray('playerActions:' + this.arrayIndexId, this.realms, {
      headTracker: readableHeadTracker,
      entityTracker: opts?.entityTracker,
    });
    this.cleanupMapFns = new Map();

    /* console.log('player apps listen');
    this.playerApps.addEventListener('entityadd', e => {
      console.log('add player app', e.data, this.playerApps.getSize());
    });
    this.playerApps.addEventListener('entityremove', e => {
      console.log('remove player app', e.data);
    });
    this.playerActions.addEventListener('entityadd', e => {
      console.log('add player action', e.data);
    });
    this.playerActions.addEventListener('entityremove', e => {
      console.log('remove player action', e.data);
    }); */
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
        // XXX listen for this in the local player renderer
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
        // XXX listen for this in the local player renderer
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
    if (!this.headTracker) {
      debugger;
    }
    this.headTracker.linkRealm(realm);
    
    const {dataClient} = realm;
    const map = dataClient.getArrayMap(this.arrayId, this.arrayIndexId);
    const update = e => {
      const {key, val} = e.data;

      // console.log('virtual player map got update', this.name, e);
      this.dispatchEvent(new MessageEvent('update', {
        data: e.data,
      }));

      if (key === positionKey) {
        this.headTracker.updateHeadRealm(val);
      }
    };
    map.addEventListener('update', update);
    
    // console.log('player apps link', realm.key);
    this.playerApps.link(realm);
    this.playerActions.link(realm);

    this.cleanupMapFns.set(realm, () => {
      this.headTracker.unlinkRealm(realm);
      
      map.unlisten();
      map.removeEventListener('update', update);

      // console.log('player apps unlink', realm.key);
      this.playerApps.unlink(realm);
      this.playerActions.unlink(realm);
    });
  }
  unlink(realm) {
    this.cleanupMapFns.get(realm)();
    this.cleanupMapFns.delete(realm);
  }
  setKeyValue(key, val) {
    const headRealm = this.headTracker.getHeadRealm();
    const {dataClient, networkedDataClient} = headRealm;
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
        entityTracker: this.opts?.entityTracker,
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

    this.headTracker = opts?.headTracker ?? null;
    this.entityTracker = opts?.entityTracker ?? null;

    this.needledVirtualEntities = new Map(); // entity -> needled entity

    this.entityTracker.addEventListener('entityadd', e => {
      // console.log('virtual entity add', e.data);
      const {entityId, entity} = e.data;
      const needledEntity = new NeedledVirtualEntityMap(entity, this.headTracker);
      
      const onlink = e => {
        const {realm} = e.data;
        needledEntity.headTracker.linkRealm(realm);
      };
      needledEntity.addEventListener('link', onlink);

      const onunlink = e => {
        const {realm} = e.data;
        needledEntity.headTracker.unlinkRealm(realm);
      };
      needledEntity.addEventListener('unlink', onunlink);

      needledEntity.cleanupFn = () => {
        needledEntity.removeEventListener('link', onlink);
        needledEntity.removeEventListener('unlink', onunlink);
      };
      this.needledVirtualEntities.set(entity, needledEntity);
      this.dispatchEvent(new MessageEvent('needledentityadd', {
        data: {
          entityId,
          needledEntity,
        },
      }));
    });
    this.entityTracker.addEventListener('entityremove', e => {
      console.log('entity tracker remove', e.data);
      const {entityId, entity} = e.data;

      const needledEntity = this.needledVirtualEntities.get(entity);
      if (!needledEntity) {
        debugger;
      }
      needledEntity.cleanupFn();
      this.needledVirtualEntities.delete(entity);

      this.dispatchEvent(new MessageEvent('needledentityremove', {
        data: {
          entityId,
          needledEntity,
        },
      }));
    });
  }
  addEntityAt(arrayIndexId, val, realm) {
    // XXX remove this deadhand to retain objects
    const deadHandUpdate = realm.dataClient.deadHandArrayMap(this.arrayId, arrayIndexId, this.parent.playerId);
    realm.emitUpdate(deadHandUpdate);
    
    const array = new DCArray(this.arrayId, realm.dataClient);
    const {
      map,
      update,
    } = array.addAt(arrayIndexId, val);
    realm.emitUpdate(update);

    return map;
  }
  getSize() {
    return this.entityTracker.getSize();
  }
  /* addEntity(val, realm) {
    return this.addEntityAt(makeId(), val, realm);
  } */
  /* first() {
    for (const map of this.virtualMaps.values()) {
      return map;
    }
    return null;
  } */
  getVirtualMapAt(index) {
    let arrayIndexId = null;
    let i = 0;
    for (const arrayIndexId_ of this.entityTracker.virtualMaps.keys()) {
      if (i === index) {
        arrayIndexId = arrayIndexId_;
        break;
      }
      i++;
    }
    const entityMap = this.entityTracker.virtualMaps.get(arrayIndexId);
    if (!entityMap) {
      debugger;
    }
    const needledEntity = this.needledVirtualEntities.get(entityMap);
    if (!needledEntity) {
      debugger;
    }
    return needledEntity;
  }
  toArray() {
    const headRealm = this.headTracker.getHeadRealm();
    const array = headRealm.dataClient.getArray(this.arrayId, {
      listen: false,
    });
    return array.toArray();
  }
  linkedRealms = new Map();
  link(realm) {
    const {dataClient} = realm;
    const dcArray = dataClient.getArray(this.arrayId, {
      listen: false,
    });
    
    // console.log('link', this.r, this.arrayId, dcArray.toArray());

    if (!this.linkedRealms.has(realm.key)) {
      this.linkedRealms.set(realm.key, new Error().stack);
    } else {
      debugger;
    }

    // link the entity tracker
    this.entityTracker.link(this.arrayId, realm);

    this.cleanupFns.set(realm, () => {
      // unlink the entity tracker
      this.entityTracker.unlink(this.arrayId, realm); // XXX track by arrayId as well
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

// one per arrayIndexId per EntityTracker
class HeadlessVirtualEntityMap extends EventTarget {
  constructor(arrayIndexId) {
    super();

    this.arrayIndexId = arrayIndexId;

    this.maps = new Map(); // bound dc maps
    this.cleanupFns = new Map();
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
  link(arrayId, realm) {
    console.log('link realm', realm.key, arrayId, this.arrayIndexId);

    const key = arrayId + ':' + realm.key;
    if (this.links.has(key)) { // XXX need to support multi-link based on arrayId
      debugger;
    }
    this.links.add(key);

    // listen
    const map = new DCMap(arrayId, this.arrayIndexId, realm.dataClient);
    map.listen();
    const update = e => {
      const {key, val} = e.data;
        
      // only route if this is the linked data client
      this.dispatchEvent(new MessageEvent('update', {
        data: e.data,
      }));

      if (key === positionKey) {
        this.updateHeadRealm(val);
      }
    };
    map.addEventListener('update', update);

    this.maps.set(key, {
      map,
      realm,
    });

    this.dispatchEvent(new MessageEvent('link', {
      data: {
        realm,
      },
    }));

    this.cleanupFns.set(key, () => {
      map.unlisten();
      map.removeEventListener('update', update);

      this.dispatchEvent(new MessageEvent('unlink', {
        data: {
          realm,
        },
      }));
    });
  }
  unlink(arrayId, realm) {
    console.log('unlink realm', realm.key, this.arrayIndexId);

    // const map = this.maps.get(realm);
    // if (!map) {
    //   debugger;
    // }
    const key = arrayId + ':' + realm.key;
    if (!this.links.has(key)) {
      debugger;
    }
    this.links.delete(key);

    // const {arrayIndexId} = map;

    this.cleanupFns.get(key)();
    this.cleanupFns.delete(key);

    /* if (this.maps.size >= 2 || window.lol) {
      window.lol = true;
      debugger;
    } */

    this.maps.delete(key);

    // garbage collect
    if (this.maps.size === 0) {
      console.log('garbage collect virtual entity map', arrayId, this.arrayIndexId);
      if (/playerApps/.test(this.parent.arrayId)) {
        debugger;
      }
      this.dispatchEvent(new MessageEvent('garbagecollect'));
    }
  }
  /* unlinkFilter(fn) {
    for (const [key, {map, realm}] of this.maps.entries()) {
      if (fn(map.arrayIndexId, map)) {
        this.unlink(map.arrayId, realm);
      }
    }
  } */
}

class NeedledVirtualEntityMap extends HeadTrackedEntity {
  constructor(entityMap, headTracker) {
    super(headTracker);

    this.entityMap = entityMap; // headless entity map
  }
  get(key) {
    const realm = this.headTracker.getHeadRealm();
    const map = this.entityMap.getHeadMapFromRealm(realm);
    if (!map) {
      debugger;
    }
    /* const map = headRealm.dataClient.getArrayMap(this.parent.arrayId, this.arrayIndexId, {
      listen: false,
    }); */
    return map.getKey(key);
  }
  set(key, val) {
    const realm = this.headTracker.getHeadRealm();
    const map = this.entityMap.getHeadMapFromRealm(realm);
    if (!map) {
      debugger;
    }
    const update = map.setKeyValueUpdate(key, val);
    console.log('got update', update);
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
  }
  toObject() {
    const realm = this.headTracker.getHeadRealm();
    const map = this.entityMap.getHeadMapFromRealm(realm);
    if (!map?.toObject) {
      debugger;
    }
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

    this.worldApps = new VirtualEntityArray(arrayId, realms, opts);
    const needledEntityCleanupFns = new Map();
    this.worldApps.addEventListener('needledentityadd', e => {
      // XXX this needs to filter for the arrayId we are interested in
      // XXX we really need two different entity trackers: apps and actions

      console.log('world needled app add', e.data);
      const {needledEntity} = e.data;
      let position = needledEntity.entityMap.getInitial('position');
      console.log('needled identity add', needledEntity, position);
      if (!position) {
        position = [0, 0, 0];
      }
      if (needledEntity.entityMap.maps.size !== 1) {
        debugger;
        throw new Error('expected a single value at binding time');
      }
      const realm = needledEntity.entityMap.maps.values().next().value.map.dataClient.userData.realm;
      needledEntity.headTracker.setHeadRealm(realm);

      const update = e => {
        const {key, val} = e.data;
        console.log('needled entity got update', {key, val}); // XXX need to update the position of playerApps before dropping them to the world
        if (key === positionKey) {
          needledEntity.headTracker.updateHeadRealm(val);
        }
      };
      needledEntity.addEventListener('update', update);

      needledEntityCleanupFns.set(needledEntity, e => {
        needledEntity.removeEventListener('update', update);  
      });
    });
    /* this.worldApps.addEventListener('needledentityremove', e => {
      const {needledEntity} = e.data;
      // console.log('needled identity remove', needledEntity);
    }); */
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
    this.headTracker = new HeadTracker();
    this.entityTracker = new EntityTracker();
    this.localPlayer = new VirtualPlayer('players', this.playerId, this, 'local', {
      headTracker: this.headTracker,
      entityTracker: this.entityTracker,
    });

    this.players = new VirtualPlayersArray('players', this, {
      headTracker: this.headTracker,
      entityTracker: this.entityTracker,
    });
    this.headTracker.addEventListener('migrate', function(e) { // XXX bind local this -> this.localPlayer
      const {oldHeadRealm, newHeadRealm} = e.data;

      if (typeof this.arrayIndexId !== 'string') {
        debugger;
      }

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
      console.log('move realm ', playerId, oldHeadRealm.key, ' -> ', newHeadRealm.key);

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
      /* const _emitLiveHands = realm => {
        const liveHandupdate = realm.dataClient.liveHandKeys(deadHandKeys, this.realms.playerId);
        realm.emitUpdate(liveHandupdate);
      }; */
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
    }.bind(this.localPlayer));
    
    this.world = new VirtualWorld('worldApps', this, {
      entityTracker: this.entityTracker,
    });
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
    const headRealm = _getHeadRealm(this.localPlayer.headPosition, this.connectedRealms);
    headRealm.sendChatMessage(message);
  }
  async updatePosition(position, realmSize) {
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
              this.players.link(realm);
              this.localPlayer.link(realm);
              this.world.link(realm);
              this.irc.link(realm);
              
              try {
                await realm.connect();
              } catch(err) {
                this.players.unlink(realm);
                this.localPlayer.unlink(realm);
                this.world.unlink(realm);
                this.irc.unlink(realm);
                throw err;
              }
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
          const appVals = [
            {
              start_url: 'rock',
              position: new Float32Array(3),
            },
            {
              start_url: 'rock',
              position: new Float32Array(3),
            }
          ];
          const appIds = Array(appVals.length);
          for (let i = 0; i < appIds.length; i++) {
            appIds[i] = makeId();
          }
          console.log('initialize player', position);
          this.localPlayer.initializePlayer({
            position,
            cursorPosition: new Float32Array(3),
            name: 'Hanna',
          }, {
            appVals,
            appIds,
            actionVals: [
              {
                action: 'wear',
                appId: appIds[0],
              },
              {
                action: 'wear',
                appId: appIds[1],
              },
            ],
          });
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
      this.localPlayer.setKeyValue('position', position);
    }
  }
}