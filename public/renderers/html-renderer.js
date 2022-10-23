export class LocalPlayerHtmlRenderer {
  constructor(localPlayerId, virtualPlayer) {
    this.localPlayerId = localPlayerId;
    this.virtualPlayer = virtualPlayer;

    const div = document.createElement('div');
    div.id = 'inventory';
    document.body.appendChild(div);

    // const map = this.dataClient.getArrayMap('players', this.remotePlayerId);
    // console.log('virtual player update listen');
    const entityadd = e => {
      const {val} = e.data;
      const [x, y, z] = val;
      div.style.left = `${x}px`;
      div.style.top = `${y}px`;
    };
    virtualPlayer.addEventListener('entityadd', entityadd);

    this.cleanupFn = () => {
      document.body.removeChild(div);

      // console.log('virtual player update unlisten');
      virtualPlayer.removeEventListener('entityadd', entityadd);
    };
  }
  destroy() {
    this.cleanupFn();
  }
}

export class RemotePlayerCursorHtmlRenderer {
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
    // console.log('virtual player update listen');
    const update = e => {
      // console.log('html renderer got player map update', e.data);

      const {val} = e.data;
      const [x, y, z] = val;
      div.style.left = `${x}px`;
      div.style.top = `${y}px`;

      // console.log('got update', e.data);
    };
    virtualPlayer.addEventListener('update', update);

    this.cleanupFn = () => {
      document.body.removeChild(div);

      // console.log('virtual player update unlisten');
      virtualPlayer.removeEventListener('update', update);
    };
  }
  destroy() {
    this.cleanupFn();
  }
}

export class WorldItemHtmlRenderer {
  constructor(virtualWorld) {
    this.virtualWorld = virtualWorld;

    const div = document.createElement('div');
    div.id = 'world-items';
    document.body.appendChild(div);

    const entityadd = e => {
      const {val} = e.data;
      const [x, y, z] = val;
      div.style.left = `${x}px`;
      div.style.top = `${y}px`;
    };
    virtualWorld.addEventListener('entityadd', entityadd);

    this.cleanupFn = () => {
      document.body.removeChild(div);

      virtualWorld.removeEventListener('entityadd', entityadd);
    };
  }
  destroy() {
    this.cleanupFn();
  }
}