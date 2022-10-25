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

class WritableHeadTracker extends EventTarget {
  constructor() {
    super();

    this.connectedRealms = new Map();
  }
  #headRealm = null;
  getHeadRealm() {
    if (!this.#headRealm) {
      console.warn('head tracker has no head! need to call updateHeadRealm()');
    }
    return this.#headRealm;
  }
  getReadable() {
    return new ReadableHeadTracker(this);
  }
  updateHeadRealm(headPosition) {
    if (!headPosition || isNaN(headPosition[0]) || isNaN(headPosition[1]) || isNaN(headPosition[2])) {
      throw new Error('try to update head realm for unpositioned player: ' + headPosition.join(','));
    }

    if (this.isLinked()) {
      const newHeadRealm = _getHeadRealm(headPosition, Array.from(this.connectedRealms.keys()));
      // console.log('update head realm', this.name, this.headRealm, newHeadRealm);
      if (!this.#headRealm) {
        this.#headRealm = newHeadRealm;
      } else {
        const oldHeadRealm = this.#headRealm;
        if (newHeadRealm.key !== oldHeadRealm.key) {
          this.#headRealm = newHeadRealm;

          if (!Array.from(this.connectedRealms.keys())[0].parent.tx.running) {
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
    return this.connectedRealms.size > 0;
  }
  setHeadRealm(realm) {
    this.#headRealm = realm;
  }
  linkRealm(realm) {
    /* if (this.connectedRealms.has(realm)) {
      debugger;
    } */
    let val = this.connectedRealms.get(positionKey) ?? 0;
    val++;
    this.connectedRealms.set(realm, val);
  }
  unlinkRealm(realm) {
    /* if (!this.connectedRealms.has(realm)) {
      debugger;
    } */
    let val = this.connectedRealms.get(realm);
    val--;
    if (val <= 0) {
      this.connectedRealms.delete(realm);
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

class EntityTracker extends EventTarget {
  constructor(arrayId, headTracker = null) {
    super();

    this.arrayId = arrayId;
    this.headTracker = headTracker;

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
      let virtualMap = this.virtualMaps.get(arrayIndexId);
      if (!virtualMap) {
        virtualMap = new VirtualEntityMap(arrayIndexId, this, {
          headTracker: this.headTracker,
        });
        this.virtualMaps.set(arrayIndexId, virtualMap);

        virtualMap.addEventListener('garbagecollect', e => {
          this.dispatchEvent(new MessageEvent('entityremove', {
            data: {
              entityId: arrayIndexId,
              entity: virtualMap,
              realm,
            },
          }));
        });
      }
      return virtualMap;
    };

    const added = !this.virtualMaps.has(map.arrayIndexId);
    const virtualMap = _getOrCreateVirtualMap(map.arrayIndexId);
    // console.log('link map', this.r, realm.key, Array.from(this.virtualMaps.entries()), map.arrayIndexId);
    virtualMap.link(realm);
    if (added) {
      if (this.headTracker) {
        const initialPosition = map.getKey('position');
        if (initialPosition) {
          this.headTracker.updateHeadRealm(initialPosition);
        }
      }

      this.dispatchEvent(new MessageEvent('entityadd', {
        data: {
          entityId: map.arrayIndexId,
          entity: virtualMap,
          realm,
        },
      }));
    }
    return virtualMap;
  }
  unlinkMap(realm, arrayIndexId) {
    // console.log('unlink map', this.r, realm.key, this.arrayId);
    const virtualMap = this.virtualMaps.get(arrayIndexId);
    if (!virtualMap) {
      debugger;
    }
    virtualMap.unlink(realm, arrayIndexId);
  }
  // each realm will only be linked once
  #linkInternal(realm) {
    const {dataClient} = realm;
    const dcArray = dataClient.getArray(this.arrayId); // note: auto listen

    const localVirtualMaps = new Map();

    const addKey = 'add.' + dcArray.arrayId;
    // console.log('listen add', addKey);
    const onadd = e => {
      const {arrayIndexId} = e.data;
      const map = dcArray.getMap(arrayIndexId, {
        listen: false,
      });
      // console.log('VirtualEntityArray got entity add', this, arrayIndexId, realm.key, map);
      const virtualMap = this.linkMap(realm, map);
      localVirtualMaps.set(arrayIndexId, virtualMap);
    };
    dcArray.dataClient.addEventListener(addKey, onadd);
    const removeKey = 'remove.' + dcArray.arrayId;
    const onremove = e => {
      const {arrayIndexId} = e.data;
      // console.log('VirtualEntityArray got entity remove', this, arrayIndexId, realm.key, e.data, listenStack);
      this.unlinkMap(realm, arrayIndexId);
      localVirtualMaps.delete(arrayIndexId);
    };
    dcArray.dataClient.addEventListener(removeKey, onremove); // XXX listen to the base dataClient events, not each listener dcarray
    
    const removeArrayKey = 'removeArray.' + dcArray.arrayId;
    const onremovearray = e => {
      // console.log('got remove array', this, e.data);
      const linkedArrayIds = Array.from(localVirtualMaps.keys());
      for (const arrayIndexId of linkedArrayIds) {
        this.unlinkMap(realm, arrayIndexId);
        localVirtualMaps.delete(arrayIndexId);
      }
    };
    dcArray.dataClient.addEventListener(removeArrayKey, onremovearray);

    const importArrayKey = 'importArray.' + this.arrayId;
    const onimportarray = e => {
      const {arrayCrdtExport, mapCrdtExports} = e.data;
      for (const arrayIndexId in arrayCrdtExport) {
        const map = dcArray.dataClient.getArrayMap(this.arrayId, arrayIndexId, {
          listen: false,
        });
        const virtualMap = this.linkMap(realm, map);
        localVirtualMaps.set(arrayIndexId, virtualMap);
      }
    };
    dcArray.dataClient.addEventListener(importArrayKey, onimportarray);

    // initial listen for existing elements
    const arrayIndexIds = dcArray.getKeys();
    for (const arrayIndexId of arrayIndexIds) {
      const map = new DCMap(this.arrayId, arrayIndexId, realm.dataClient);
      const virtualMap = this.linkMap(realm, map);
      localVirtualMaps.set(arrayIndexId, virtualMap);
    }

    this.cleanupFns.set(realm, () => {
      // console.log('unlisten add', addKey);

      // unbind array virtual maps
      dcArray.unlisten();
      dcArray.dataClient.removeEventListener(addKey, onadd);
      dcArray.dataClient.removeEventListener(removeKey, onremove);
      dcArray.dataClient.removeEventListener(removeArrayKey, onremovearray);
      dcArray.dataClient.removeEventListener(importArrayKey, onimportarray);

      for (const localVirtualMap of localVirtualMaps.values()) {
        if (!localVirtualMap.unlinkFilter) {
          debugger;
        }
        localVirtualMap.unlinkFilter((arrayIndexId, map) => {
          if (!map?.dataClient?.userData?.realm) {
            debugger;
          }
          return realm === map.dataClient.userData.realm;
        });
      }
    });
  }
  // returns whether the realm was linked
  link(realm) {
    if (!this.linkedRealms.has(realm.key)) {
      this.linkedRealms.set(realm.key, 1);
      this.#linkInternal(realm);
      return true;
    } else {
      let numRealms = this.linkedRealms.get(realm.key);
      numRealms++;
      this.linkedRealms.set(realm.key, numRealms);
      return false;
    }
  }
  #unlinkInternal(realm) {
    this.cleanupFns.get(realm)();
    this.cleanupFns.delete(realm);
  }
  // returns whether the realm was unlinked
  unlink(realm) {
    let numRealms = this.linkedRealms.get(realm.key);
    numRealms--;
    if (numRealms > 0) {
      this.linkedRealms.set(realm.key, numRealms);
      return false;
    } else {
      this.#unlinkInternal(realm);
      this.linkedRealms.delete(realm.key);
      return true;
    }
  }
}

//

class HeadTrackedEntity extends EventTarget {
  constructor(headTracker) {
    super();

    this.headTracker = headTracker || new WritableHeadTracker(this);
  }
  get headRealm() {
    debugger;
  }
  set headRealm(v) {
    debugger;
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

class VirtualPlayer extends HeadTrackedEntity {
  constructor(arrayId, arrayIndexId, realms, name) {
    super();

    this.arrayId = arrayId;
    this.arrayIndexId = arrayIndexId;
    this.realms = realms;
    this.name = name;

    this.headTracker.addEventListener('migrate', e => {
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
    });

    const readableHeadTracker = this.headTracker.getReadable();
    this.playerApps = new VirtualEntityArray('playerApps:' + this.arrayIndexId, this.realms, {
      headTracker: readableHeadTracker,
    });
    this.playerActions = new VirtualEntityArray('playerActions:' + this.arrayIndexId, this.realms, {
      headTracker: readableHeadTracker,
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
    const headRealm = this.headTracker.getHeadRealm();

    const _initializeApps = () => {
      for (let i = 0; i < appVals.length; i++) {
        const appVal = appVals[i];
        const appId = appIds[i] ?? makeId();
        const deadHandUpdate = headRealm.dataClient.deadHandArrayMap(this.playerApps.arrayId, appId, this.realms.playerId);
        headRealm.emitUpdate(deadHandUpdate);

        // console.log('initialize player add player app 1', appVal, appId);
        const map = this.playerApps.addEntityAt(appId, appVal);
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
        const map = this.playerActions.addEntityAt(actionId, actionVal);
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
    
    this.headTracker.linkRealm(realm);
    
    const {dataClient} = realm;
    const map = dataClient.getArrayMap(this.arrayId, this.arrayIndexId);
    const update = e => {
      // console.log('virtual player map got update', this.name, e);
      this.dispatchEvent(new MessageEvent('update', {
        data: e.data,
      }));
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
  constructor(arrayId, parent) {
    super();

    this.arrayId = arrayId;
    this.parent = parent;

    this.virtualPlayers = new Map();
    this.cleanupFns = new Map();
  }
  getOrCreateVirtualPlayer(playerId) {
    let virtualPlayer = this.virtualPlayers.get(playerId);
    if (!virtualPlayer) {
      virtualPlayer = new VirtualPlayer(this.arrayId, playerId, this.parent, 'remote');
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
      };
      const _unlinkPlayer = arrayIndexId => {
        const playerId = arrayIndexId;

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
  /* clear() {
    const entries = Array.from(this.virtualPlayers.entries());
    for (const [playerId, virtualPlayer] of entries) {
      virtualPlayer.unlink(playerId);
      this.virtualPlayers.delete(playerId);
    }
  } */
}
class VirtualEntityArray extends VirtualPlayersArray {
  constructor(arrayId, realms, opts) {
    super(arrayId, realms);

    this.headTracker = opts?.headTracker ?? null;
    this.entityTracker = opts?.entityTracker ?? new EntityTracker(this.arrayId, this.headTracker);

    this.entityTracker.addEventListener('entityadd', e => {
      console.log('entity tracker add', e.data);
      this.dispatchEvent(new MessageEvent('entityadd', {
        data: e.data,
      }));
    });
    this.entityTracker.addEventListener('entityremove', e => {
      console.log('entity tracker remove', e.data);
      this.dispatchEvent(new MessageEvent('entityremove', {
        data: e.data,
      }));
    });
  }
  addEntityAt(arrayIndexId, val) {
    const position = val[positionKey] ?? [0, 0, 0];
    const realm = this.parent.getClosestRealm(position);
    
    // XXX remove this to retain objects
    const deadHandUpdate = realm.dataClient.deadHandArrayMap(this.arrayId, arrayIndexId, this.parent.playerId);
    realm.emitUpdate(deadHandUpdate);
    
    const array = new DCArray(this.arrayId, realm.dataClient);
    const {
      map,
      update,
    } = array.addAt(arrayIndexId, val);
    // map.setHeadRealm(realm);
    realm.emitUpdate(update);

    return map;
  }
  getSize() {
    return this.entityTracker.getSize();
  }
  addEntity(val) {
    return this.addEntityAt(makeId(), val);
  }
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
    return this.entityTracker.virtualMaps.get(arrayIndexId);
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
    this.entityTracker.link(realm);

    this.cleanupFns.set(realm, () => {
      // unlink the entity tracker
      this.entityTracker.unlink(realm);
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

class VirtualEntityMap extends HeadTrackedEntity {
  constructor(arrayIndexId, parent, opts) {
    super(opts?.headTracker);
    
    this.arrayIndexId = arrayIndexId;
    this.parent = parent;

    this.maps = new Map(); // bound dc maps
    this.cleanupFns = new Map();
  }
  get(key) {
    const headRealm = this.headTracker.getHeadRealm();
    const map = headRealm.dataClient.getArrayMap(this.parent.arrayId, this.arrayIndexId, {
      listen: false,
    });
    return map.getKey(key);
  }
  set(key, val) {
    throw new Error('not implemented');
  }
  remove() {
    // console.log('remove from head realm', this.headRealm);
    const headRealm = this.headTracker.getHeadRealm();
    const array = headRealm.dataClient.getArray(this.parent.arrayId, {
      listen: false,
    });
    const update = array.removeAt(this.arrayIndexId);
    headRealm.emitUpdate(update);
  }
  toObject() {
    const headRealm = this.headTracker.getHeadRealm();
    const array = headRealm.dataClient.getArray(this.parent.arrayId, {
      listen: false,
    });
    const map = array.getMap(this.arrayIndexId, {
      listen: false,
    });
    return map.toObject();
  }
  links = new Set();
  link(realm) {
    /* if (typeof arrayIndexId !== 'string') {
      debugger;
    } */

    if (this.links.has(realm)) {
      debugger;
    }
    this.links.add(realm);

    // listen
    const map = new DCMap(this.parent.arrayId, this.arrayIndexId, realm.dataClient);
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

    this.maps.set(realm, map);
    this.headTracker.linkRealm(realm);

    this.cleanupFns.set(realm, () => {
      map.unlisten();
      map.removeEventListener('update', update);
    });
  }
  unlink(realm) {
    // console.log('unlink realm', realm.key, this.arrayIndexId);

    // const map = this.maps.get(realm);
    // if (!map) {
    //   debugger;
    // }
    if (!this.links.has(realm)) {
      debugger;
    }
    this.links.delete(realm);

    // const {arrayIndexId} = map;

    this.cleanupFns.get(realm)();
    this.cleanupFns.delete(realm);

    this.maps.delete(realm);
    this.headTracker.unlinkRealm(realm);

    // garbage collect
    if (this.maps.size === 0) {
      console.log('garbage collect virtual entity map', this.parent.arrayId, this.arrayIndexId);
      if (/playerApps/.test(this.parent.arrayId)) {
        debugger;
      }
      this.dispatchEvent(new MessageEvent('garbagecollect'));
    }
  }
  unlinkFilter(fn) {
    for (const [realm, map] of this.maps.entries()) {
      if (fn(map.arrayIndexId, map)) {
        this.unlink(realm);
      }
    }
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

export class NetworkRealms extends EventTarget {
  constructor(playerId) {
    super();

    this.playerId = playerId;

    this.lastPosition = [NaN, NaN, NaN];
    this.players = new VirtualPlayersArray('players', this);
    this.localPlayer = new VirtualPlayer('players', this.playerId, this, 'local');
    this.world = new VirtualEntityArray('worldApps', this, {
      entityTracker: this.localPlayer.playerApps.entityTracker,
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

          if (foundRealm) {
            // if (arrayEquals(foundRealm.min, snappedPosition)) {
            //   this.centerRealm = foundRealm;
            // }
          } else {
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

        if (oldNumConnectedRealms === 0 && connectPromises.length > 0) {
          // if this is the first network configuration, initialize our local player
          this.localPlayer.headTracker.updateHeadRealm(position);
          
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
          // this.sendRegisterMessage();
        } else {
          // else if we're just moving around, update the local player's position
          this.localPlayer.headTracker.updateHeadRealm(position);
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
  }
}