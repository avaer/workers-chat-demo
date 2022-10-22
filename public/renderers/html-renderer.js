export class RemotePlayerHtmlRenderer {
  constructor(remotePlayerId, localPlayerId, virtualPlayer) {
    this.remotePlayerId = remotePlayerId;
    this.localPlayerId = localPlayerId;
    this.virtualPlayer = virtualPlayer;

    const div = document.createElement('div');
    div.style.cssText = `\
      position: fixed;
      top: 0;
      left: 0;
      background-color: ${this.remotePlayerId === this.localPlayerId ? 'blue' : 'red'};
      width: 10px;
      height: 10px;
      z-index: 100;
      pointer-events: none;
    `;
    document.body.appendChild(div);

    // const map = this.dataClient.getArrayMap('players', this.remotePlayerId);
    // console.log('listen for player', virtualPlayer);
    virtualPlayer.addEventListener('update', e => {
      // console.log('got player map update', e.data);
      const {val} = e.data;
      const [x, y, z] = val;
      div.style.left = `${x}px`;
      div.style.top = `${y}px`;

      // console.log('got update', e.data);
    });

    this.cleanupFn = () => {
      document.body.removeChild(div);
    };
  }
  destroy() {
    this.cleanupFn();
  }
}
export class LocalPlayerHtmlRenderer { // XXX can be moved to controllers instead of renderers
  constructor(realms) {
    this.realms = realms;

    const {localPlayer} = realms;
    /* const players = this.dataClient.getArray('players');
    const {map: player, update: playerAddUpdate} = players.addAt(this.playerId, {
      name: this.playerId,
      position: Float32Array.from([0, 0, 0]),
    });
    this.ndc.send(serializeMessage(playerAddUpdate)); */
  }
  destroy() {
    this.cleanupFn();
  }
}