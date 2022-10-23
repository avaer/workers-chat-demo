import {realmSize} from '../constants.js';
import {zstringify} from '../util.mjs';

//

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

//

const _drawRectangle = (ctx, color) => {
  const innerBorder = 3;
  const borderWidth = 3;
  ctx.fillStyle = color;
  ctx.fillRect(innerBorder, innerBorder, realmSize - innerBorder * 2, borderWidth); // top
  ctx.fillRect(innerBorder, realmSize - borderWidth - innerBorder, realmSize - innerBorder * 2, borderWidth); // bottom
  ctx.fillRect(innerBorder, innerBorder, borderWidth, realmSize - innerBorder * 2); // left
  ctx.fillRect(realmSize - borderWidth - innerBorder, innerBorder, borderWidth, realmSize - innerBorder * 2); // right
};
export class GameRealmsCanvases {
  constructor(realms) {
    this.elements = [];
    for (let dx = -1; dx <= 1; dx++) {
      for (let dz = -1; dz <= 1; dz++) {
        const canvas = document.createElement('canvas');
        canvas.className = 'canvas';
        canvas.width = realmSize;
        canvas.height = realmSize;
        const ctx = canvas.getContext('2d');
        _drawRectangle(ctx, '#CCC');
        
        const x = dx + 1;
        const z = dz + 1;

        const text = document.createElement('div');
        text.className = 'text';
        const text1 = document.createElement('div');
        text1.textContent = `${x}:${z}`;
        text.appendChild(text1);
        const text2 = document.createElement('div');
        // text2.textContent = `${dx}:${dz}`;
        text.appendChild(text2);

        const div = document.createElement('div');
        div.className = 'network-realm';
        div.style.cssText = `\
position: fixed;
left: ${realmSize * x}px;
top: ${realmSize * z}px;
z-index: 1;
        `;
        div.appendChild(canvas);
        div.appendChild(text);
        div.min = [x * realmSize, 0, z * realmSize];
        div.size = realmSize;
        div.setColor = color => {
          _drawRectangle(ctx, color);
        };
        div.setText = text => {
          text2.innerText = text;
        };
        div.updateText = dataClient => {
          const playersArray = dataClient.getArray('players', {
            listen: false,
          });
          const worldApps = dataClient.getArray('worldApps', {
            listen: false,
          });

          const _formatArray = array => {
            array = array.getKeys().map(arrayIndexId => {
              const playerApp = array.getMap(arrayIndexId, {
                listen: false,
              });
              const playerAppJson = playerApp.toObject();
              return playerAppJson;
            });
            return zstringify(array);
          };
          const _updateText = () => {
            let playersString = '';
            if (playersArray.getSize() > 0) {
              playersString = `players: [\n${zstringify(playersArray.toArray())}\n]`;
            } else {
              playersString = `players: []`;
            }

            for (const arrayIndexId of playersArray.getKeys()) {
              // player apps
              let playerAppsString = '';
              const playerAppsArray = dataClient.getArray('playerApps:' + arrayIndexId, {
                listen: false,
              });
              if (playerAppsArray.getSize() > 0) {
                playerAppsString = `playerApps: [\n${_formatArray(playerAppsArray)}\n]`;
              } else {
                playerAppsString = `playerApps: []`;
              }
              playersString += '\n' + playerAppsString;
              
              // player actions
              let playerActionsString = '';
              const playerActionsArray = dataClient.getArray('playerActions:' + arrayIndexId, {
                listen: false,
              });
              if (playerActionsArray.getSize()) {
                playerActionsString = `playerActions: [\n${_formatArray(playerActionsArray)}\n]`;
              } else {
                playerActionsString = `playerActions: []`;
              }
              playersString += '\n' + playerActionsString;
            }

            let worldAppsString = '';
            if (worldApps.getSize() > 0) {
              worldAppsString = `worldApps: [\n${zstringify(worldApps.toArray())}\n]`;
            } else {
              worldAppsString = `worldApps: []`;
            }

            const s = [
              playersString,
              worldAppsString,
            ].join('\n');
            div.setText(s);
          };
          _updateText();
        };
        
        this.elements.push(div);
      }
    }
  }
}