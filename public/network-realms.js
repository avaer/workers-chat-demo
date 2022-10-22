import {DataClient, NetworkedDataClient, DCMap, DCArray} from './data-client.mjs';
import {NetworkedIrcClient} from './irc-client.js';
import {NetworkedAudioClient} from './audio-client.js';
import {createWs, makePromise} from './util.mjs';

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
  let closestRealm = null;
  let closestRealmDistance = Infinity;
  for (const realm of realms) {
    if (realm.connected) {
      const realmCenter = [
        realm.min[0] + realm.size/2,
        realm.min[1] + realm.size/2,
        realm.min[2] + realm.size/2,
      ];
      const distance = distanceTo(position, realmCenter);
      if (distance < closestRealmDistance) {
        closestRealm = realm;
        closestRealmDistance = distance;
      }
    }
  }
  return closestRealm;
}
class VirtualPlayer extends EventTarget {
  constructor(arrayId, arrayIndexId, parent, name) {
    super();

    this.arrayId = arrayId;
    this.arrayIndexId = arrayIndexId;
    this.parent = parent;
    this.name = name;

    this.headPosition = [NaN, NaN, NaN];
    this.headRealm = null;
    this.connectedRealms = new Set();
    this.cleanupMapFns = new Map();

    console.log('new virtual player', this, new Error().stack);
  }
  initialize(o) {

    const headRealm = this.#getHeadRealm();
    const {dataClient, networkedDataClient} = headRealm;
    const playersArray = dataClient.getArray(this.arrayId, {
      listen: false,
    });
    const {
      // map,
      update,
    } = playersArray.addAt(this.arrayIndexId, o, {
      listen: false,
    });
    headRealm.emitUpdate(update);
  }
  setHeadPosition(position) {
    this.headPosition[0] = position[0];
    this.headPosition[1] = position[1];
    this.headPosition[2] = position[2];
  }
  updateHeadRealm() {
    if (isNaN(this.headPosition[0]) || isNaN(this.headPosition[1]) || isNaN(this.headPosition[2])) {
      throw new Error('try to update head realm for unpositioned player: ' + this.playerId + ' ' + this.headPosition.join(','));
    }

    if (this.isLinked()) {
      const newHeadRealm = _getHeadRealm(this.headPosition, this.connectedRealms);
      // console.log('update head realm', this.name, newHeadRealm);
      if (!this.headRealm) {
        this.headRealm = newHeadRealm;
      } else {
        const oldHeadRealm = this.headRealm;
        if (newHeadRealm.key !== oldHeadRealm.key) {
          this.#migrateTo(newHeadRealm);
        }
      }
    } else {
      throw new Error('try to get head realm for fully unlinked player ' + this.playerId);
    }
  }
  #migrateTo(newHeadRealm) {
    const realms = this.parent;
    if (!realms.tx.running) {
      throw new Error('migration happening outside of a lock -- wrap in realms.tx()')
    }

    const oldHeadRealm = this.headRealm;
    this.headRealm = newHeadRealm;

    const oldPlayersArray = oldHeadRealm.dataClient.getArray(this.arrayId, {
      listen: false,
    });
    const oldPlayerMap = oldPlayersArray.getMap(this.arrayIndexId, {
      listen: false,
    });

    console.log('move realm ', oldHeadRealm.key, ' -> ', newHeadRealm.key);

    // XXX do the actual migration to newHeadRealm:
    // - lock the transaction (already done)
    // - lock the map with dead hand
    // - create in the new array
    const newPlayersArray = newHeadRealm.dataClient.getArray(this.arrayId, {
      listen: false,
    });
    const oldPlayerJson = oldPlayerMap.toObject();
    const {
      map: newPlayerMap,
      update: newAddUpdate,
    } = newPlayersArray.addAt(this.arrayIndexId, oldPlayerJson);
    // console.log('added json', oldPlayerJson, newPlayerMap, newAddUpdate);
    newHeadRealm.emitUpdate(newAddUpdate);
    
    // - delete from the old array
    const oldRemoveUpdate = oldPlayerMap.removeUpdate();
    // console.log('removed old', oldRemoveUpdate);
    oldHeadRealm.emitUpdate(oldRemoveUpdate);
  }
  #getHeadRealm() {
    if (this.isLinked()) {
      return _getHeadRealm(this.headPosition, this.connectedRealms);
    } else {
      throw new Error('try to get head realm for fully unlinked player ' + this.playerId);
    }
  }
  isLinked() {
    return this.connectedRealms.size > 0;
  }
  link(realm) {
    // console.log('link', realm);
    this.connectedRealms.add(realm);

    const {dataClient} = realm;
    const map = dataClient.getArrayMap(this.arrayId, this.arrayIndexId);
    const update = e => {
      // console.log('virtual player map got update', this.name, e);
      this.dispatchEvent(new MessageEvent('update', {
        data: e.data,
      }));
    };
    map.addEventListener('update', update);

    this.cleanupMapFns.set(realm, () => {
      map.unlisten();
      map.removeEventListener('update', update);
    });
  }
  unlink(realm) {
    // console.log('unlink', realm);
    this.connectedRealms.delete(realm);

    this.cleanupMapFns.get(realm)();
    this.cleanupMapFns.delete(realm);
  }
  setKeyValue(key, val) {
    const headRealm = this.#getHeadRealm();
    // console.log('head realm key', headRealm.key);
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
      virtualPlayer = new VirtualPlayer(this.arrayId, playerId, this, 'remote');
      this.virtualPlayers.set(playerId, virtualPlayer);
    }
    return virtualPlayer;
  }
  link(realm) {
    const {networkedDataClient, networkedIrcClient, networkedAudioClient} = realm;
    
    const _linkIrc = () => {
      // XXX instead of this, attach to the players array in the data client
      /* const onjoin = e => {
        const {playerId} = e.data;
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
      networkedIrcClient.addEventListener('join', onjoin);
      const onleave = e => {
        const {playerId} = e.data;
        const virtualPlayer = this.virtualPlayers.get(playerId);
        if (virtualPlayer) {
          virtualPlayer.unlink(realm);
          if (!virtualPlayer.isLinked()) {
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
      networkedIrcClient.addEventListener('leave', onleave); */

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
    };
    _linkIrc();

    const _linkData = () => {
      const playersArray = networkedDataClient.dataClient.getArray(this.arrayId);

      const onadd = e => {
        // console.log('got player add', e.data);
        const {arrayIndexId, map, val} = e.data;
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
      playersArray.addEventListener('add', onadd);

      const onremove = e => {
        // console.log('got player remove', e.data);
        const {arrayId, arrayIndexId} = e.data;
        const playerId = arrayIndexId;

        const virtualPlayer = this.virtualPlayers.get(playerId);
        if (virtualPlayer) {
          virtualPlayer.unlink(realm);
          if (!virtualPlayer.isLinked()) {
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
      playersArray.addEventListener('remove', onremove);

      this.cleanupFns.set(networkedDataClient, () => {
        playersArray.unlisten();
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
    const {networkedDataClient, networkedIrcClient, networkedAudioClient} = realm;

    this.cleanupFns.get(networkedDataClient)();
    this.cleanupFns.delete(networkedDataClient);

    this.cleanupFns.get(networkedIrcClient)();
    this.cleanupFns.delete(networkedIrcClient);

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

//

class VirtualEntityMap extends EventTarget {
  constructor(arrayIndexId, virtualArray) {
    super();
    
    this.arrayIndexId = arrayIndexId;
    this.virtualArray = virtualArray;

    this.maps = new Set(); // set of bound dc maps
    this.headDataClient = null; // the currently bound data client, changed when the network is reconfigured
    this.cleanupFns = new Map();
  }
  get(key) {
    throw new Error('not implemented');
  }
  set(key, val) {
    throw new Error('not implemented');
  }
  link(map) {
    // listen
    map.listen();
    const update = e => {
      // only route if this is the king data client
      if (map.dataClient === this.headDataClient) {
        this.dispatchEvent(new MessageEvent('update', {
          data: e.data,
        }));
      }
    };
    map.addEventListener('update', update);

    // update head data client
    this.maps.add(map);
    this.updateHeadDataClient();

    this.cleanupFns.set(map, () => {
      map.unlisten();
      map.removeEventListener('update', update);
    });
  }
  unlink(map) {
    const cleanupFn = this.cleanupFns.get(map);
    cleanupFn();
    this.cleanupFns.delete(map);

    // update head data client
    this.maps.delete(map);
    this.updateHeadDataClient();

    // garbage collect
    if (this.maps.size === 0) {
      // this.virtualArray.remove(this.arrayIndexId);
      this.dispatchEvent(new MessageEvent('garbagecollect'));
    }
  }
  updateHeadDataClient() {
    let headDataClient = null;
    let headDataClientDistance = Infinity;
    for (const map of this.maps.values()) {
      const position = map.getKey('position');
      const {dataClient} = map;
      const {realm} = dataClient.userData;
      const realmCenter = [
        realm.min[0] + realm.size/2,
        realm.min[1] + realm.size/2,
        realm.min[2] + realm.size/2,
      ];
      const distance = distanceTo(position, realmCenter);
      if (distance < headDataClientDistance) {
        headDataClient = map;
        headDataClientDistance = distance;
      }
    }
    // XXX changing the head data client requires us to re-emit the delta update
    return headDataClient;
  }
}

class VirtualEntityArray extends EventTarget {
  constructor(arrayId, parent) {
    super();

    this.arrayId = arrayId;
    this.parent = parent;

    this.virtualMaps = new Map();
    this.dcCleanupFns = new Map();
  }
  addEntity(val) {
    const position = val[positionKey] ?? [0, 0, 0];
    const realm = this.parent.getClosestRealm(position);
    const array = new DCArray(this.arrayId, realm.dataClient);
    const {
      map,
      update,
    } = array.add(val);
    realm.emitUpdate(update);
    return map;
  }
  getOrCreateVirtualMap(arrayIndexId) {
    let virtualMap = this.virtualMaps.get(arrayIndexId);
    if (!virtualMap) {
      virtualMap = new VirtualEntityMap(arrayIndexId, this);
      this.virtualMaps.set(arrayIndexId, virtualMap);
    
      this.dispatchEvent(new MessageEvent('entityadd', {
        data: {
          entityId: arrayIndexId,
          entity: virtualMap,
        },
      }));

      virtualMap.addEventListener('garbagecollect', e => {
        this.dispatchEvent(new MessageEvent('entityremove', {
          data: {
            entityId: arrayIndexId,
            entity: virtualMap,
          },
        }));
      });
    }
    return virtualMap;
  }
  link(networkedDataClient) {
    // bind local array maps to virtual maps
    const dcArray = networkedDataClient.dataClient.getArray(this.arrayId); // note: auto listen
    
    const localVirtualMaps = new Map();
    dcArray.addEventListener('add', e => {
      const {arrayIndexId, map} = e.data;
      const virtualMap = this.getOrCreateVirtualMap(arrayIndexId);
      virtualMap.link(map);
      localVirtualMaps.set(map, virtualMap);
    });
    dcArray.addEventListener('remove', e => {
      const {arrayIndexId} = e.data;
      const virtualMap = this.virtualMaps.get(arrayIndexId);
      virtualMap.unlink();
      localVirtualMaps.delete(arrayIndexId);
    });
    
    this.dcCleanupFns.set(networkedDataClient, () => {
      // unbind array virtual maps
      dcArray.unlisten();

      for (const localVirtualMap of localVirtualMaps.values()) {
        localVirtualMap.unlink(networkedDataClient);
      }
    });
  }
  unlink(networkedDataClient) {
    this.dcCleanupFns.get(networkedDataClient)();
    this.dcCleanupFns.delete(networkedDataClient);
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
    console.log('realm disconnect', new Error().stack)
    this.ws.close();
    const updates = this.dataClient.clearUpdates();
    for (const update of updates) {
      this.dataClient.emitUpdate(update);
    }
    this.connected = false;
  }
  emitUpdate(update) {
    // console.log('emit update to realm', this.key, update);
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
    this.world = new VirtualEntityArray('world', this);
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
    let closestRealm = null;
    let closestRealmDistance = Infinity;
    for (const realm of this.connectedRealms) {
      const distance = distanceTo(realm.min, position);
      if (distance < closestRealmDistance) {
        closestRealm = realm;
        closestRealmDistance = distance;
      }
    }
    return closestRealm;
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
              this.world.link(realm.networkedDataClient);
              
              try {
                await realm.connect();
              } catch(err) {
                this.players.unlink(realm);
                this.localPlayer.unlink(realm);
                this.world.unlink(realm.networkedDataClient);
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
          // if this is the first network configuration, initialize the local player
          this.localPlayer.setHeadPosition(position);
          this.localPlayer.updateHeadRealm();
          this.localPlayer.initialize({
            position,
            cursorPosition: new Float32Array(3),
            name: 'Hanna',
          });
          // this.sendRegisterMessage();
        } else {
          // else if we're just moving around, update the local player's position
          this.localPlayer.setHeadPosition(position);
          this.localPlayer.updateHeadRealm();
        }

        // check if we need to disconnect from any realms
        const oldRealms = [];
        for (const connectedRealm of this.connectedRealms) {
          if (!candidateRealms.find(candidateRealm => candidateRealm.key === connectedRealm.key)) {
            this.players.unlink(connectedRealm);
            this.localPlayer.unlink(connectedRealm);
            this.world.unlink(connectedRealm.networkedDataClient);

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