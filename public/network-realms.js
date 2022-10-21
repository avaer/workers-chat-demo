export class NetworkRealm {
  constructor(position) {
    this.position = position;
    this.key = position.join(',');
  }
  connect() {
    console.warn('connect');
  }
  disconnect() {
    console.warn('disconnect');
  }
}

export class NetworkRealms {
  constructor() {
    this.connectedRealms = new Set();
  }
  updatePosition(position, realmSize) {
    const candidateRealms = [];
    for (let dz = -1; dz <= 1; dz++) {
      for (let dx = -1; dx <= 1; dx++) {
        const position2 = [
          Math.floor((position[0] + dx * realmSize) / realmSize) * realmSize,
          0,
          Math.floor((position[2] + dz * realmSize) / realmSize) * realmSize,
        ];
        const realm = new NetworkRealm(position2);
        candidateRealms.push(realm);
      }
    }

    // check if we need to connect to new realms
    for (const realm of candidateRealms) {
      let foundRealm = null;
      for (const connectedRealm of this.connectedRealms) {
        if (connectedRealm.key === realm.key) {
          foundRealm = connectedRealm;
          break;
        }
      }

      if (!foundRealm) {
        realm.connect();
        this.connectedRealms.add(realm);
      }
    }

    // check if we need to disconnect from any realms
    for (const connectedRealm of this.connectedRealms) {
      if (!candidateRealms.find(candidateRealm => candidateRealm.key === connectedRealm.key)) {
        connectedRealm.disconnect();
        this.connectedRealms.delete(connectedRealm);
      }
    }
  }
}