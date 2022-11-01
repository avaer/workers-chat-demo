import {DataClient, NetworkedDataClient, DCMap, DCArray} from './data-client.mjs';
import {NetworkedIrcClient} from './irc-client.js';
import {NetworkedAudioClient, createMicrophoneSource} from './audio-client.js';
import {
  createWs,
  makePromise,
  makeId,
  parseUpdateObject,
  serializeMessage,
} from './util.mjs';

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
const boxContains = (box, point) => {
  const {min, max} = box;
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
      if (boxContains(box, position)) {
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

    this.headTracker = headTracker || new HeadTracker(this);
  }
}

//

class HeadTracker extends EventTarget {
  constructor(headTrackedEntity) {
    super();

    this.headTrackedEntity = headTrackedEntity;
    
    this.onMigrate = null;
  }
  #cachedHeadRealm = null;
  #connectedRealms = new Map(); // realm -> link count
  getHeadRealm() {
    // XXX this method can be optimized with a cache
    if (this.#connectedRealms.size === 1) { // by far the most common case
      return this.#connectedRealms.keys().next().value;
    } else {
      const {arrayId, arrayIndexId} = this.headTrackedEntity;
      let dcMaps = [];
      for (const realm of this.#connectedRealms.keys()) {
        const {dataClient} = realm;
        const dcArray = dataClient.getArray(arrayId, {
          listen: false,
        });
        // console.log('got dc array', dcArray, dcArray.toArray());
        if (dcArray.hasKey(arrayIndexId)) {
          const dcMap = dcArray.getMap(arrayIndexId, {
            listen: false,
          });
          dcMaps.push(dcMap);
        } else {
          // nothing
        }
      }

      if (dcMaps.length > 0) {
        let dcMap;
        if (dcMaps.length === 1) {
          dcMap = dcMaps[0];
        } else {
          dcMaps = dcMaps.sort((a, b) => {
            return b.getMapEpoch() - a.getMapEpoch();
          });
          dcMap = dcMaps[0];
        }
        return dcMap.dataClient.userData.realm;
      } else {
        // XXX if we got here, that means that this entity does not exist in the data.
        // XXX if the caller is trying to create this data, they should call getHeadRealmForCreate() instead
        debugger;
        throw new Error('cannot get head realm: entity does not exist in data');
      }
    }
  }
  getHeadRealmForCreate(position) {
    const headRealm = _getHeadRealm(position, this.#connectedRealms.keys());
    return headRealm;
  }
  async updateHeadRealm(headPosition) {
    if (this.isLinked()) {
      const newHeadRealm = _getHeadRealm(headPosition, Array.from(this.#connectedRealms.keys()));
      if (!this.#cachedHeadRealm) {
        this.#cachedHeadRealm = newHeadRealm;
        // console.log('init head realm', newHeadRealm.key);
      } else {
        const oldHeadRealm = this.#cachedHeadRealm;
        if (newHeadRealm.key !== oldHeadRealm.key) {          
          this.#cachedHeadRealm = newHeadRealm;
            
          this.onMigrate && await this.onMigrate(new MessageEvent('migrate', {
            data: {
              oldHeadRealm,
              newHeadRealm,
            },
          }));
        } else {
          console.log('keys same! why are you updating me?');
          debugger;
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
  linkRealm(realm) {
    let val = this.#connectedRealms.get(realm) ?? 0;
    val++;
    this.#connectedRealms.set(realm, val);
  }
  unlinkRealm(realm) {
    let val = this.#connectedRealms.get(realm);
    val--;
    if (val <= 0) {
      this.#connectedRealms.delete(realm);
    }
  }
}

//

class EntityTracker extends EventTarget {
  constructor() {
    super();

    this.virtualMaps = new Map();
    this.linkedRealms = new Map();
    this.cleanupFns = new Map();
  }
  getSize() {
    return this.virtualMaps.size;
  }
  linkMap(realm, map) {
    // bind local array maps to virtual maps
    const _getOrCreateVirtualMap = (arrayIndexId) => {
      let virtualMap = this.virtualMaps.get(map.arrayIndexId);
      if (!virtualMap) {
        // console.log('*** create new', map.arrayId, arrayIndexId);
        virtualMap = new HeadlessVirtualEntityMap(arrayIndexId);
        this.virtualMaps.set(map.arrayIndexId, virtualMap);

        virtualMap.addEventListener('garbagecollect', e => {
          this.virtualMaps.delete(map.arrayIndexId);

          this.dispatchEvent(new MessageEvent('entityremove', {
            data: {
              entityId: arrayIndexId,
              entity: virtualMap,
            },
          }));
        });
      } else {
        // console.log('*** create old', map.arrayId, arrayIndexId);
      }
      return virtualMap;
    };

    const added = !this.virtualMaps.has(map.arrayIndexId);
    const virtualMap = _getOrCreateVirtualMap(map.arrayIndexId);

    virtualMap.link(map.arrayId, realm);

    if (added) {
      this.dispatchEvent(new MessageEvent('entityadd', {
        data: {
          entityId: map.arrayIndexId,
          entity: virtualMap,
        },
      }));
    }
    return virtualMap;
  }
  unlinkMap(realm, arrayId, arrayIndexId) {
    // console.log('entity tracker unlink map', realm, arrayIndexId);

    const virtualMap = this.virtualMaps.get(arrayIndexId);
    virtualMap.unlink(arrayId, realm);

  }
  // each realm will only be linked once
  #linkInternal(arrayId, realm) {
    const key = arrayId + ':' + realm.key;

    // if (this.cleanupFns.get(key)) {
    //   debugger;
    // }

    if (!this.linkStacks) {
      this.linkStacks = new Map();
    }
    /*if (this.linkStacks.has(key)) {
      debugger;
    } */
    this.linkStacks.set(key, new Error().stack);

    const {dataClient} = realm;
    const dcArray = dataClient.getArray(arrayId); // note: auto listen
    
    const localVirtualMaps = new Map();
    const _bind = map => {
      globalThis.linkStacks = this.linkStacks;
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
      const {arrayIndexId} = e.data;
      const map = dcArray.getMap(arrayIndexId, {
        listen: false,
      });
      // console.log('got', map, new Error().stack);
      _bind(map);
    };
    dcArray.dataClient.addEventListener(addKey, onadd);
    const removeKey = 'remove.' + dcArray.arrayId;
    const onremove = e => {
      const {arrayIndexId} = e.data;
      _unbind(arrayIndexId);
    };
    dcArray.dataClient.addEventListener(removeKey, onremove);
    
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

    this.headTracker = new HeadTracker(this);

    // const readableHeadTracker = this.headTracker.getReadable();
    this.playerApps = new VirtualEntityArray('playerApps:' + this.arrayIndexId, this.realms, {
      // headTracker: readableHeadTracker,
      entityTracker: opts?.appsEntityTracker,
    });
    this.playerActions = new VirtualEntityArray('playerActions:' + this.arrayIndexId, this.realms, {
      // headTracker: readableHeadTracker,
      // entityTracker: opts?.actionsEntityTracker,
      entityTracker: new EntityTracker(),
    });
    this.cleanupMapFns = new Map();
  }
  initializePlayer(o, {
    appVals = [],
    appIds = [],
    actionVals = [],
    actionValIds = [],
  } = {}) {
    const headRealm = this.headTracker.getHeadRealmForCreate(o.position);
    // console.log('initialize player', o, headRealm);

    console.log('initialize app', headRealm.key, o.position.join(','));

    const _initializeApps = () => {
      for (let i = 0; i < appVals.length; i++) {
        const appVal = appVals[i];
        const appId = appIds[i] ?? makeId();
        const deadHandUpdate = headRealm.dataClient.deadHandArrayMap(this.playerApps.arrayId, appId, this.realms.playerId);
        headRealm.emitUpdate(deadHandUpdate);

        // console.log('initialize app 1', headRealm.key, appId, appVal);
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
      const epoch = 0;
      const {
        // map,
        update,
      } = playersArray.addAt(this.arrayIndexId, o, epoch, {
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
      this.dispatchEvent(new MessageEvent('update', {
        data: e.data,
      }));
    };
    map.addEventListener('update', update);
    
    // link child arrays
    this.playerApps.link(realm);
    this.playerActions.link(realm);
    
    // link initial position
    this.headTracker.linkRealm(realm);

    // cleanup
    this.cleanupMapFns.set(realm, () => {
      this.headTracker.unlinkRealm(realm);
      
      map.unlisten();
      map.removeEventListener('update', update);

      this.playerApps.unlink(realm);
      this.playerActions.unlink(realm);
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
    // globalThis.valueMap = valueMap;
    return valueMap.getKey(key);
  }
  getEpoch() {
    const headRealm = this.headTracker.getHeadRealm();
    const {dataClient} = headRealm;
    const valueMap = dataClient.getArrayMap(this.arrayId, this.arrayIndexId, {
      listen: false,
    });
    return valueMap.getEpoch();
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
        // actionsEntityTracker: this.opts?.actionsEntityTracker,
      });
      this.virtualPlayers.set(playerId, virtualPlayer);
    }
    return virtualPlayer;
  }
  getSize() {
    return this.virtualPlayers.size;
  }
  getValues() {
    return Array.from(this.virtualPlayers.values());
  }
  link(realm) {
    const {dataClient, networkedDataClient, networkedAudioClient} = realm;

    const _linkData = () => {
      const playersArray = dataClient.getArray(this.arrayId);

      // console.log('players array listen', this.arrayId, realm.key);

      const _linkPlayer = arrayIndexId => {
        // console.log('link player', arrayIndexId, realm.key);
        const playerId = arrayIndexId;
        if (playerId === this.parent.playerId) {
          // nothing
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

        // console.log('unlink player', arrayIndexId, realm.key);

        if (playerId == this.parent.playerId) {
          // nothing
        } else {
          const virtualPlayer = this.virtualPlayers.get(playerId);
          if (virtualPlayer) {
            // XXX this needs to handle the case where the user has moved across realms and then leaves
            // XXX this realm will be the same as when the player joined
            virtualPlayer.unlink(realm);
            // console.log('post unlink', arrayIndexId, realm.key);

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
        // console.log('player add', e.data);
        const {arrayIndexId, map, val} = e.data;
        _linkPlayer(arrayIndexId);
      };
      playersArray.addEventListener('add', onadd);

      const onremove = e => {
        // console.log('player remove', e.data, realm.key);
        const {arrayIndexId} = e.data;
        _unlinkPlayer(arrayIndexId);
      };
      playersArray.addEventListener('remove', onremove);

      // link initial players
      for (const arrayIndexId of playersArray.getKeys()) {
        // console.log('player initial', arrayIndexId);
        _linkPlayer(arrayIndexId);
      }

      this.cleanupFns.set(networkedDataClient, () => {
        playersArray.unlisten();

        // console.log('player unlisten', realm.key, new Error().stack);

        playersArray.removeEventListener('add', onadd);
        playersArray.removeEventListener('remove', onremove);
      });
    };
    _linkData();

    const _linkAudio = () => {
      const audiostreamstart = e => {
        this.dispatchEvent(new MessageEvent('audiostreamstart', {
          data: e.data,
        }));
      };
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
    // this.headTracker = opts?.headTracker ?? null;
    this.entityTracker = opts?.entityTracker ?? null;

    this.needledVirtualEntities = new Map(); // entity -> needled entity

    const onentityadd = e => {
      // console.log('entity add', e.data);
      const {entityId, entity} = e.data;

      // console.log('entity add', arrayId, entityId, entity);
      
      // sanityCheck();
      const needledEntity = new NeedledVirtualEntityMap(arrayId, entity);

      needledEntity.cleanupFn = () => {
        needledEntity.destroy();

        this.needledVirtualEntities.delete(entity);

        this.dispatchEvent(new MessageEvent('needledentityremove', {
          data: {
            entityId,
            needledEntity,
          },
        }));
      };
      this.needledVirtualEntities.set(entity, needledEntity);

      // sanityCheck();

      this.dispatchEvent(new MessageEvent('needledentityadd', {
        data: {
          entityId,
          needledEntity,
        },
      }));
      // sanityCheck();
    };
    this.entityTracker.addEventListener('entityadd', onentityadd);
    const onentityremove = e => {
      const {entityId, entity} = e.data;

      // console.log('entity remove', arrayId, entityId, entity);

      if (!this.needledVirtualEntities.has(entity)) {
        debugger;
      }
      const needledEntity = this.needledVirtualEntities.get(entity);
      needledEntity.cleanupFn();
    };
    this.entityTracker.addEventListener('entityremove', onentityremove);

    // console.log('adding defaults', arrayId, this.entityTracker.virtualMaps, this.entityTracker.virtualMaps.size);
    for (const [entityId, entity] of this.entityTracker.virtualMaps.entries()) {
      // console.log('add initial entity', arrayId, entityId, entity);
      onentityadd(new MessageEvent('entityadd', {
        data: {
          entityId,
          entity,
        },
      }));
    }
  }
  addEntityAt(arrayIndexId, val, realm) {
    const deadHandUpdate = realm.dataClient.deadHandArrayMap(this.arrayId, arrayIndexId, this.parent.playerId);
    realm.emitUpdate(deadHandUpdate);
    
    const array = new DCArray(this.arrayId, realm.dataClient);
    const epoch = 0;
    const {
      map,
      update,
    } = array.addAt(arrayIndexId, val, epoch);
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
  getValues() {
    return Array.from(this.needledVirtualEntities.values());
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
    // console.log('link', key, this.links.size);
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

      if (!this.links.has(key)) {
        debugger;
      }
      this.links.delete(key);
      // console.log('unlink', key, this.links.size);
  
      if (!this.maps.has(key)) {
        debugger;
      }
      this.maps.delete(key);

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

    this.cleanupFns.get(key)();
    this.cleanupFns.delete(key);

    // garbage collect
    // console.log('check maps size', arrayId, this.maps.size);
    if (this.maps.size === 0) {
      // console.log('garbage collect virtual entity map', arrayId, this.arrayIndexId);
      // if (/playerApps/.test(arrayId)) {
      //   debugger;
      // }
      // debugger;
      this.dispatchEvent(new MessageEvent('garbagecollect'));
    }
  }
}

class NeedledVirtualEntityMap extends HeadTrackedEntity {
  constructor(arrayId, entityMap) {
    super();

    this.arrayId = arrayId;
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
  }
  /* get arrayId() {
    return this.arrayId;
  }
  set arrayId(arrayId) {
    throw new Error('cannot set arrayId');
  } */
  get arrayIndexId() {
    return this.entityMap.arrayIndexId;
  }
  set arrayIndexId(arrayIndexId) {
    throw new Error('cannot set arrayIndexId');
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

    this.microphoneSource = null;
  }
  sendChatMessage(message) {
    this.networkedIrcClient.sendChatMessage(message);
  }
  async connect() {
    const ws1 = createWs('realm:' + this.key, this.parent.playerId);
    ws1.binaryType = 'arraybuffer';
    this.ws = ws1;
    this.ws.onerror = err => {
      console.warn(err.stack);
      debugger;
    };
    await Promise.all([
      this.networkedDataClient.connect(ws1).then(() => {
        // console.log('done 1');
      }),
      this.networkedIrcClient.connect(ws1).then(() => {
        // console.log('done 1');
      }),
      this.networkedAudioClient.connect(ws1).then(() => {
        // console.log('done 1');
      }),
    ]);
    this.connected = true;
  }
  *getClearUpdateFns() {
    const playersArray = this.dataClient.getArray('players', {
      listen: false,
    });

    // players
    const playerIds = playersArray.getKeys();
    for (const playerId of playerIds) {
      // if (playerId === this.parent.playerId) {
      //   debugger;
      //   throw new Error('would have removed self during clear!');
      // }
      // if (typeof playerId !== 'string' || typeof this.parent.playerId !== 'string') {
      //   debugger;
      // }

      const playerAppsArray = this.dataClient.getArray('playerApps:' + playerId, {
        listen: false,
      });
      const playerActionsArray = this.dataClient.getArray('playerActions:' + playerId, {
        listen: false,
      });

      // actions
      for (const actionId of playerActionsArray.getKeys()) {
        yield () => playerActionsArray.removeAt(actionId);
      }
      // apps
      for (const appId of playerAppsArray.getKeys()) {
        yield () => playerAppsArray.removeAt(appId);
      }
      // player
      yield () => playersArray.removeAt(playerId);
    }
  }
  flush() {
    const clearUpdateFns = this.getClearUpdateFns();
    for (const clearUpdateFn of clearUpdateFns) {
      const clearUpdate = clearUpdateFn();
      this.dataClient.emitUpdate(clearUpdate);
    }
  }
  disconnect() {
    this.ws.close();
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
    this.appsEntityTracker = new EntityTracker();
    // this.actionsEntityTracker = new EntityTracker();
    this.localPlayer = new VirtualPlayer('players', this.playerId, this, 'local', {
      appsEntityTracker: this.appsEntityTracker,
      // actionsEntityTracker: this.actionsEntityTracker,
    });
    this.world = new VirtualWorld('worldApps', this, {
      entityTracker: this.appsEntityTracker,
    });

    this.players = new VirtualPlayersArray('players', this, {
      appsEntityTracker: this.appsEntityTracker,
      // actionsEntityTracker: this.actionsEntityTracker,
    });
    this.localPlayer.headTracker.onMigrate = async e => {
      const {oldHeadRealm, newHeadRealm} = e.data;

      console.log('migrate', oldHeadRealm.key, '->', newHeadRealm.key);

      // old objects
      const oldPlayersArray = oldHeadRealm.dataClient.getArray(this.localPlayer.arrayId, {
        listen: false,
      });
      const oldPlayerAppsArray = oldHeadRealm.dataClient.getArray('playerApps:' + this.playerId, {
        listen: false,
      });
      const oldPlayerActionsArray = oldHeadRealm.dataClient.getArray('playerActions:' + this.playerId, {
        listen: false,
      });
      const oldPlayerMap = oldPlayersArray.getMap(this.playerId, {
        listen: false,
      });

      // new objects
      const newPlayersArray = newHeadRealm.dataClient.getArray(this.localPlayer.arrayId, {
        listen: false,
      });
      const newPlayerAppsArray = newHeadRealm.dataClient.getArray('playerApps:' + this.playerId, {
        listen: false,
      });
      const newPlayerActionsArray = newHeadRealm.dataClient.getArray('playerActions:' + this.playerId, {
        listen: false,
      });
      // set dead hands
      const deadHandKeys = [
        this.localPlayer.arrayId + '.' + this.localPlayer.arrayIndexId, // player
        'playerApps:' + this.localPlayer.arrayIndexId, // playerApps
        'playerActions:' + this.localPlayer.arrayIndexId, // playerActions
      ];
      const _emitDeadHands = realm => {
        const deadHandupdate = realm.dataClient.deadHandKeys(deadHandKeys, this.playerId);
        realm.emitUpdate(deadHandupdate);
      };
      _emitDeadHands(oldHeadRealm);
      _emitDeadHands(newHeadRealm);

      // add new
      // import apps
      const _applyMessageToRealm = (realm, message) => {
        const uint8Array = serializeMessage(message);
        const updateObject = parseUpdateObject(uint8Array);
        const {
          rollback,
          update,
        } = realm.dataClient.applyUpdateObject(updateObject, {
          force: true, // since coming from the server
        });
        if (rollback) {
          throw new Error('migrate failed 1');
        }
        if (update) {
          realm.emitUpdate(update);
        } else {
          throw new Error('migrate failed 2');
        }
      };
      const _importPlayer = () => {
        const playerAppsImportMessages = oldPlayerAppsArray.importArrayUpdates();
        for (const m of playerAppsImportMessages) {
          _applyMessageToRealm(newHeadRealm, m);
        }
        // import actions
        const playerActionsImportMessages = oldPlayerActionsArray.importArrayUpdates();
        for (const m of playerActionsImportMessages) {
          _applyMessageToRealm(newHeadRealm, m);
        }
        // import player
        const playerImportMessage = oldPlayerMap.importMapUpdate();
        _applyMessageToRealm(newHeadRealm, playerImportMessage);
      };
      _importPlayer();

      // migrate networked audio client
      realms.migrateAudioRealm(oldHeadRealm, newHeadRealm);

      await realms.sync();

      // delete old
      // delete apps
      const _deleteOldArrayMaps = () => {
        for (const arrayIndexId of oldPlayerAppsArray.getKeys()) {
          const update = oldPlayerAppsArray.removeAt(arrayIndexId);
          oldHeadRealm.emitUpdate(update);
        }
        // delete actions
        for (const arrayIndexId of oldPlayerActionsArray.getKeys()) {
          const update = oldPlayerActionsArray.removeAt(arrayIndexId);
          oldHeadRealm.emitUpdate(update);
        }
        // delete player
        const oldPlayerRemoveUpdate = oldPlayerMap.removeUpdate();
        oldHeadRealm.emitUpdate(oldPlayerRemoveUpdate);
      };
      _deleteOldArrayMaps();
    };
    
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
        if (boxContains(box, position)) {
          return realm;
        }
      }
    }
    return null;
  }
  async sync() {
    // for all realms
    const promises = Array.from(this.connectedRealms.values()).map(async realm => {
      const {dataClient} = realm;

      const playersArray = dataClient.getArray('players', {
        listen: false,
      });
      const playersArrayMaps = playersArray.getMaps();
      let numPlayers = playersArrayMaps.filter(player => player.arrayIndexId !== this.playerId).length;
      // console.log('sync', numPlayers, playersArray.getKeys(), playersArrayMaps, this.playerId);
      if (numPlayers > 0) {
        const synId = makeId();
        const synMessage = dataClient.getSynMessage(synId);
        realm.networkedDataClient.emitUpdate(synMessage);
        // console.log('emit to ws', realm.key, playersArrayMaps.map(p => p.arrayIndexId), realm.networkedDataClient.ws.readyState);

        // wait for >= numPlayers synAcks, with a 2-second timeout
        await new Promise((accept, reject) => {
          let seenSynAcks = 0;
          const onSynAck = e => {
            if (e.data.synId === synId) {
              seenSynAcks++;
              if (seenSynAcks >= numPlayers) {
                cleanup();
                accept();
              }
            }
          };
          dataClient.addEventListener('synAck', onSynAck);

          const timeout = setTimeout(() => {
            console.log('timeout', realm.key, playersArrayMaps);
            cleanup();
            accept();
          }, 2000);

          const cleanup = () => {
            dataClient.removeEventListener('synAck', onSynAck);
            clearTimeout(timeout);
          };
        });
      } else {
        // throw new Error('expected at least 1 player');
      }
    });
    await Promise.all(promises);
  }
  isMicEnabled() {
    return !!this.microphoneSource;
  }
  toggleMic() {
    if (!this.isMicEnabled()) {
      this.enableMic();
    } else {
      this.disableMic();
    }
  }
  async enableMic() {
    if (!this.microphoneSource) {
      this.microphoneSource = await createMicrophoneSource();

      this.dispatchEvent(new MessageEvent('micenabled', {
        data: {},
      }));
      
      // get the head realm from the local player
      const headRealm = this.localPlayer.headTracker.getHeadRealm();
      if (!headRealm) {
        debugger;
      }
      const {networkedAudioClient} = headRealm;
      networkedAudioClient.addMicrophoneSource(this.microphoneSource);
    } else {
      debugger;
    }
  }
  disableMic() {
    if (this.microphoneSource) {
      const headRealm = this.localPlayer.headTracker.getHeadRealm();
      if (!headRealm) {
        debugger;
      }
      const {networkedAudioClient} = headRealm;
      networkedAudioClient.removeMicrophoneSource(this.microphoneSource);

      this.microphoneSource.destroy();

      this.microphoneSource = null;

      this.dispatchEvent(new MessageEvent('micdisabled', {
        data: {},
      }));
    } else {
      debugger;
    }
  }
  migrateAudioRealm(oldRealm, newRealm) {
    if (this.microphoneSource) {
      const {networkedAudioClient: oldNetworkedAudioClient} = oldRealm;
      const {networkedAudioClient: newNetworkedAudioClient} = newRealm;
      oldNetworkedAudioClient.removeMicrophoneSource(this.microphoneSource);
      newNetworkedAudioClient.addMicrophoneSource(this.microphoneSource);
    }
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
              
              try {
                await realm.connect();

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
              } catch (err) {
                console.warn(err.stack);
                throw err;
                /* realm.dispatchEvent(new Event('connecterror'));
                this.dispatchEvent(new MessageEvent('realmconnecterror', {
                  data: {
                    realm,
                  },
                })); */
              }
            })();
            connectPromises.push(connectPromise);
          }
        }
        await Promise.all(connectPromises);

        // if this is the first network configuration, initialize our local player
        if (oldNumConnectedRealms === 0 && connectPromises.length > 0) {
          onConnect && onConnect(position);
        } // else {
          // migrate localPlayer if needed
          // console.log('pre-migrate 1', position);
          await this.localPlayer.headTracker.updateHeadRealm(position);
          // console.log('post-migrate 1');
        // }

        // check if we need to disconnect from any realms
        const oldRealms = [];
        for (const connectedRealm of this.connectedRealms) {
          if (!candidateRealms.find(candidateRealm => candidateRealm.key === connectedRealm.key)) {
            // first, disconnect to make sure no corrupted state goes on the network
            connectedRealm.disconnect();

            // note: we must perform a flush before unlinking
            // otherwise, the remove handlers will be unlinked by the time we emit
            connectedRealm.flush();
            
            // unlink arrays
            this.players.unlink(connectedRealm);
            this.localPlayer.unlink(connectedRealm);
            this.world.unlink(connectedRealm);
            this.irc.unlink(connectedRealm);
            
            // bookkeeping
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
  }
}