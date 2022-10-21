import {DataClient, NetworkedDataClient, DCMap, DCArray} from './data-client.mjs';
import {createWs} from './util.mjs';

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
const makePromise = () => {
  let resolve, reject;
  const promise = new Promise((a, b) => {
    resolve = a;
    reject = b;
  });
  promise.resolve = resolve;
  promise.reject = reject;
  return promise;
}
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

class VirtualEntityArray extends EventTarget {
  constructor(arrayId, {
    listenOnArray = true,
  } = {}) {
    super();

    this.arrayId = arrayId;
    this.listenOnArray = listenOnArray;

    this.dataClients = [];
    this.dcArray = null;
  }
  link(dataClient) {
    this.dcArray = dataClient.getArray(this.arrayId);

    this.dataClients.push(dataClient);
    if (this.listenOnArray) {
      dataClient.onArrayUpdate(this.arrayId, this._handleArrayUpdate);
    }
  }
}

//

export class NetworkRealm {
  constructor(min, size, parent) {
    this.min = min;
    this.size = size;
    this.parent = parent;

    this.key = min.join(':');
    
    this.ws = null;
    this.dataClient = null;
    this.networkedDataClient = null;
  }
  async connect() {
    const dc1 = new DataClient({
      crdt: new Map(),
    });
    const ws1 = createWs('realm:' + this.key, this.parent.playerId);
    ws1.binaryType = 'arraybuffer';
    const ndc1 = new NetworkedDataClient(dc1, ws1);

    this.ws = ws1;
    this.dataClient = dc1;
    this.networkedDataClient = ndc1;

    await this.networkedDataClient.connect();
  }
  disconnect() {
    console.warn('disconnect');
    this.ws.close();
  }
}

//

export class NetworkRealms extends EventTarget {
  constructor(playerId) {
    super();

    this.playerId = playerId;

    this.lastPosition = [NaN, NaN, NaN];
    this.players = new VirtualEntityArray('players', {
      listenOnArray: true,
    });
    this.world = new VirtualEntityArray('world');
    this.connectedRealms = new Set();
    this.tx = makeTransactionHandler();
  }
  getVirtualPlayers() {
    return this.players;
  }
  getVirtualWorld() {
    return this.world;
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
              Math.floor((position[0] + dx * realmSize) / realmSize) * realmSize,
              0,
              Math.floor((position[2] + dz * realmSize) / realmSize) * realmSize,
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
            this.dispatchEvent(new MessageEvent('realmconnecting', {
              data: {
                realm,
              },
            }));

            const connectPromise = realm.connect().then(() => {
              this.connectedRealms.add(realm);
              return realm;
            });
            connectPromises.push(connectPromise);
          }
        }
        const newRealms = await Promise.all(connectPromises);
        for (const newRealm of newRealms) {
          this.dispatchEvent(new MessageEvent('realmjoin', {
            data: {
              realm: newRealm,
            },
          }));
        }

        // check if we need to disconnect from any realms
        const oldRealms = [];
        for (const connectedRealm of this.connectedRealms) {
          if (!candidateRealms.find(candidateRealm => candidateRealm.key === connectedRealm.key)) {
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