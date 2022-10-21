import {DataClient, NetworkedDataClient, DCMap, DCArray} from './data-client.mjs';
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
  let running = false;
  const queue = [];
  async function handle(fn) {
    if (!running) {
      running = true;
      let result;
      let error;
      try {
        result = await fn();
      } catch (err) {
        error = err;
      }
      running = false;
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
  return handle;
};

//

class VirtualPlayersArray extends EventTarget {
  constructor() {
    super();

    this.cleanupFns = new Map();
  }
  link(networkedDataClient) {
    const players = networkedDataClient.dataClient.getArray('players');

    const onadd = e => {
      console.log('got virtual player base add', e);
    };
    players.addEventListener('add', onadd);
    const onremove = e => {
      console.log('got on remove', e);
    };
    players.addEventListener('got virtual player base remove', onremove);

    this.cleanupFns.set(networkedDataClient, () => {
      players.removeEventListener('add', onadd);
      players.removeEventListener('remove', onremove);
      players.unlisten();
    });
  }
  unlink(networkedDataClient) {
    this.cleanupFns.get(networkedDataClient)();
    this.cleanupFns.delete(networkedDataClient);
  }
}

//

class VirtualEntityMap extends EventTarget {
  constructor(arrayIndexId, virtualArray) {
    super();
    
    this.arrayIndexId = arrayIndexId;
    this.virtualArray = virtualArray;

    this.maps = new Set(); // for computing the head data client
    this.headDataClient = null; // the currently bound data client, changed when a new link opens or
    this.cleanupFns = new Map();
  }
  get(key) {

  }
  set(key, val) {

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
      this.virtualArray.remove(this.arrayIndexId);
    }
  }
  updateHeadDataClient() {
    let headDataClient = null;
    let headDataClientDistance = Infinity;
    for (const map of this.maps.values()) {
      const position = map.getKey('position');
      const {dataClient} = map;
      const {realm} = dataClient.userData;
      const center = [
        realm.min[0] + realm.size[0]/2,
        realm.min[1] + realm.size[1]/2,
        realm.min[2] + realm.size[2]/2,
      ];
      const distance = distanceTo(position, center);
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
          id: arrayIndexId,
          entity: virtualMap,
        },
      }));

      virtualMap.addEventListener('garbagecollect', e => {
        this.dispatchEvent(new MessageEvent('entityremove', {
          data: {
            arrayIndexId,
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
      virtualMap.unlink(arrayIndexId);
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

export class NetworkRealm {
  constructor(min, size, parent) {
    this.min = min;
    this.size = size;
    this.parent = parent;

    this.key = min.join(':');
    
    const dc1 = new DataClient({
      crdt: new Map(),
      userData: {
        realm: this,
      },
    });
    this.dataClient = dc1;
    this.networkedDataClient = new NetworkedDataClient(dc1, {
      userData: {
        realm: this,
      },
    });
    this.ws = null;
  }
  async connect() {
    const ws1 = createWs('realm:' + this.key, this.parent.playerId);
    ws1.binaryType = 'arraybuffer';
    await this.networkedDataClient.connect(ws1);
    this.ws = ws1;
  }
  disconnect() {
    console.warn('disconnect');
    this.ws.close();
    this.ws = null;
  }
  emitUpdate(update) {
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
    this.players = new VirtualPlayersArray();
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
  async updatePosition(position, realmSize) {
    const snappedPosition = position.map(v => Math.floor(v / realmSize) * realmSize);
    if (!arrayEquals(snappedPosition, this.lastPosition)) {
      this.lastPosition[0] = snappedPosition[0];
      this.lastPosition[1] = snappedPosition[1];
      this.lastPosition[2] = snappedPosition[2];

      await this.tx(async () => {
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
            this.dispatchEvent(new MessageEvent('realmconnecting', {
              data: {
                realm,
              },
            }));

            const connectPromise = (async () => {
              this.players.link(realm.networkedDataClient);
              this.world.link(realm.networkedDataClient);
              
              try {
                await realm.connect();
              } catch(err) {
                this.players.unlink(realm.networkedDataClient);
                this.world.unlink(realm.networkedDataClient);
                throw err;
              }
              this.connectedRealms.add(realm);
              // if (arrayEquals(realm.min, snappedPosition)) {
              //   this.centerRealm = realm;
              // }
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

        // check if we need to disconnect from any realms
        const oldRealms = [];
        for (const connectedRealm of this.connectedRealms) {
          if (!candidateRealms.find(candidateRealm => candidateRealm.key === connectedRealm.key)) {
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
      });
    }
  }
}