import {frameSize, realmSize} from '../constants.js';
import {zstringify} from '../util.mjs';

//

export class LocalPlayerHtmlRenderer {
  constructor(localPlayerId, virtualPlayer) {
    this.localPlayerId = localPlayerId;
    this.virtualPlayer = virtualPlayer;

    const div = document.createElement('div');
    div.id = 'inventory';
    document.body.appendChild(div);

    /* const playerAppsEntityAdd = e => {
      console.log('html renderer got player apps add', e.data);
    };
    virtualPlayer.playerApps.addEventListener('entityadd', playerAppsEntityAdd);

    const playerActionsEntityAdd = e => {
      console.log('html renderer got player actions add', e.data);
    };
    virtualPlayer.playerActions.addEventListener('entityadd', playerActionsEntityAdd); */

    this.cleanupFn = () => {
      document.body.removeChild(div);

      // virtualPlayer.removeEventListener('entityadd', playerAppsEntityAdd);
      // virtualPlayer.removeEventListener('entityadd', playerActionsEntityAdd);
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

export class GameObjectCanvas {

}

export class GamePlayerCanvas {
  constructor(virtualPlayer) {
    this.virtualPlayer = virtualPlayer;
    
    this.spriteImg = null;

    this.element = document.createElement('div');
    this.element.className = 'game-player';
    
    this.canvas = document.createElement('canvas');
    this.canvas.width = frameSize;
    this.canvas.height = frameSize;
    this.ctx = this.canvas.getContext('2d');
    this.element.appendChild(this.canvas);
    
    const playerAppsEl = document.createElement('div');
    playerAppsEl.className = 'player-apps';
    this.element.appendChild(playerAppsEl);

    this.cancelFn = null;

    this.position = [0, 0, 0];
    this.velocity = [0, 0, 0];
    this.direction = [0, 0, 1];

    const playerApps = new Map();
    const playerActions = new Set();
    const _renderPlayerApps = () => {
      // remove all elements
      playerAppsEl.innerHTML = '';

      for (const actionMap of playerActions) {
        const actionJson = actionMap.toObject();
        // console.log('got action map', actionJson);
        const {action} = actionJson;
        if (action === 'wear') {
          const wornApp = playerApps.get(actionJson.appId);
          const appDiv = document.createElement('div');
          appDiv.className = 'player-app';
          appDiv.innerHTML = `<img src="/public/images/rock.png" >`;
          playerAppsEl.appendChild(appDiv);
        }
      }
    };

    // const map = this.dataClient.getArrayMap('players', this.remotePlayerId);
    // console.log('virtual player update listen');
    const playerAppsEntityAdd = e => {
      console.log('html renderer got player apps add', e.data);
      const {entityId, entity} = e.data;
      playerApps.set(entityId, entity);
      _renderPlayerApps();
    };
    virtualPlayer.playerApps.addEventListener('entityadd', playerAppsEntityAdd);
    const playerAppsEntityRemove = e => {
      console.log('html renderer got player apps remove', e.data);
      const {entityId} = e.data;
      playerApps.delete(entityId);
      _renderPlayerApps();
    };
    virtualPlayer.playerApps.addEventListener('entityremove', playerAppsEntityRemove);

    const playerActionsEntityAdd = e => {
      console.log('html renderer got player actions add', e.data);
      const {entity} = e.data;
      playerActions.add(entity);
      _renderPlayerApps();
    };
    virtualPlayer.playerActions.addEventListener('entityadd', playerActionsEntityAdd);
    const playerActionsEntityRemove = e => {
      console.log('html renderer got player actions remove', e.data);
      const {entity} = e.data;
      playerActions.delete(entity);
      _renderPlayerApps();
    };
    virtualPlayer.playerActions.addEventListener('entityremove', playerActionsEntityRemove);
  }
  setSprite(spriteImg) {
    this.spriteImg = spriteImg;
  }
  move() {
    const speed = 5;
    this.position[0] += this.velocity[0] * speed;
    this.position[2] += this.velocity[2] * speed;
    
    if (this.velocity[2] < 0) {
      this.direction[0] = 0;
      this.direction[2] = -1;
    } else if (this.velocity[0] < 0) {
      this.direction[0] = -1;
      this.direction[2] = 0;
    } else if (this.velocity[0] > 0) {
      this.direction[0] = 1;
      this.direction[2] = 0;
    } else if (this.velocity[2] > 0) {
      this.direction[0] = 0;
      this.direction[2] = 1;
    } else {
      // nothing
    }
  }
  draw() {
    if (this.spriteImg) {
      let row;
      if (this.direction[0] === -1) {
        row = 1;
      } else if (this.direction[0] === 1) {
        row = 2;
      } else if (this.direction[2] === -1) {
        row = 3;
      } else {
        row = 0;
      }
      const timestamp = performance.now();
      const frameLoopTime = 200;
      const col = Math.floor(timestamp / frameLoopTime) % 3;

      this.ctx.clearRect(0, 0, frameSize, frameSize);
      this.ctx.drawImage(this.spriteImg, col * frameSize, row * frameSize, frameSize, frameSize, 0, 0, frameSize, frameSize);
    }
  }
  static loadFromUrl(url) {
    return new Promise((accept, reject) => {
      const img = new Image();
      img.onload = () => {
        const canvas = document.createElement('canvas');
        canvas.width = img.width;
        canvas.height = img.height;
        const ctx = canvas.getContext('2d');
        // replace the color #24886d with transparent
        ctx.drawImage(img, 0, 0);
        const imageData = ctx.getImageData(0, 0, img.width, img.height);
        const data = imageData.data;
        const _isInRange = (v, base, range) => v >= (base - range) && v <= (base + range);
        const _isInRangeN = (v, base) => _isInRange(v, base, 5);
        for (let i = 0; i < data.length; i += 4) {
          if (_isInRangeN(data[i], 0x24) && _isInRangeN(data[i+1], 0x88) && _isInRangeN(data[i+2], 0x6d)) {
            data[i+3] = 0;
          }
        }
        ctx.putImageData(imageData, 0, 0);

        accept(canvas);
      };
      img.onerror = err => {
        reject(err);
      };
      img.src = url;
    });
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
                playerAppsString = `  playerApps: [\n${_formatArray(playerAppsArray)}\n]`;
              } else {
                playerAppsString = `  playerApps: []`;
              }
              playersString += '\n' + playerAppsString;
              
              // player actions
              let playerActionsString = '';
              const playerActionsArray = dataClient.getArray('playerActions:' + arrayIndexId, {
                listen: false,
              });
              if (playerActionsArray.getSize()) {
                playerActionsString = `  playerActions: [\n${_formatArray(playerActionsArray)}\n]`;
              } else {www
                playerActionsString = `  playerActions: []`;
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