import {makeId} from './util.mjs';
import {realmSize} from './constants.js';

import {RemotePlayerCursorHtmlRenderer, GameRealmsCanvases, LocalPlayerHtmlRenderer, WorldItemHtmlRenderer} from "./renderers/html-renderer.js";
import {NetworkRealms} from "./network-realms.js";

const frameSize = 64;
class GamePlayerCanvas {
  constructor(spriteImg) {
    this.spriteImg = spriteImg;

    this.canvas = document.createElement('canvas');
    this.canvas.width = frameSize;
    this.canvas.height = frameSize;
    this.ctx = this.canvas.getContext('2d');

    this.cancelFn = null;

    this.position = [0, 0, 0];
    this.velocity = [0, 0, 0];
    this.direction = [0, 0, 1];
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
  start() {
    let frame;
    const _recurse = () => {
      frame = requestAnimationFrame(_recurse);
      this.draw();
    };
    _recurse();

    this.cancelFn = () => {
      cancelAnimationFrame(frame);
    };
  }
  stop() {
    if (this.cancelFn) {
      this.cancelFn();
      this.cancelFn = null;
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

        const result = new GamePlayerCanvas(canvas);
        accept(result);
      };
      img.onerror = err => {
        reject(err);
      };
      img.src = url;
    });
  }
}

//

export const startGame = async () => {
  const playerId = makeId();

  const localPlayerCanvas = await GamePlayerCanvas.loadFromUrl('/public/images/fire-mage.png');
  localPlayerCanvas.canvas.style.cssText = `\
position: fixed;
outline: none;
z-index: 2;
  `;
  localPlayerCanvas.canvas.classList.add('player-sprite');
  let localPlayerFocused = false;
  localPlayerCanvas.canvas.addEventListener('focus', e => {
    // console.log('character focus 1');
    localPlayerFocused = true;
  });
  localPlayerCanvas.canvas.addEventListener('blur', e => {
    // console.log('character blur 1');
    localPlayerFocused = false;
  });
  window.addEventListener('keydown', e => {
    if (localPlayerFocused) {
      // WASD
      switch (e.code) {
        case 'KeyW': {
          localPlayerCanvas.velocity[2] = -1;
          break;
        }
        case 'KeyA': {
          localPlayerCanvas.velocity[0] = -1;
          break;
        }
        case 'KeyS': {
          localPlayerCanvas.velocity[2] = 1;
          break;
        }
        case 'KeyD': {
          localPlayerCanvas.velocity[0] = 1;
          break;
        }
        case 'KeyE': {
          _pickupDrop();
          break;
        }
      }
    }
  });
  window.addEventListener('keyup', e => {
    switch (e.code) {
      case 'KeyW': {
        localPlayerCanvas.velocity[2] = 0;
        break;
      }
      case 'KeyA': {
        localPlayerCanvas.velocity[0] = 0;
        break;
      }
      case 'KeyS': {
        localPlayerCanvas.velocity[2] = 0;
        break;
      }
      case 'KeyD': {
        localPlayerCanvas.velocity[0] = 0;
        break;
      }
    }
  });
  localPlayerCanvas.canvas.tabIndex = -1;
  document.body.appendChild(localPlayerCanvas.canvas);

  // action methods
  const _pickupDrop = () => {
    const targetPosition = [
      localPlayerCanvas.position[0] + localPlayerCanvas.direction[0] * frameSize,
      0,
      localPlayerCanvas.position[2] + localPlayerCanvas.direction[2] * frameSize - frameSize / 2,
    ];
    const targetBox = {
      min: [
        targetPosition[0] - frameSize / 2,
        0,
        targetPosition[2] - frameSize / 2,
      ],
      max: [
        targetPosition[0] + frameSize / 2,
        0,
        targetPosition[2] + frameSize / 2,
      ],
    };
    const _boxContains = (box, position) => {
      return position[0] >= box.min[0] && position[0] <= box.max[0] &&
        position[1] >= box.min[1] && position[1] <= box.max[1] &&
        position[2] >= box.min[2] && position[2] <= box.max[2];
    };
    
    const collidedVirtualMap = Array.from(virtualWorld.virtualMaps.values()).find(virtualMap => {
      const position = virtualMap.get('position');
      return _boxContains(targetBox, position);
    });
    // const inventory = document.querySelector('#inventory');
    // const inventoryItems = Array.from(inventory.querySelectorAll('.realms-item'));
    // const world = document.querySelector('#world');
    // const worldItems = Array.from(world.querySelectorAll('.realms-item'));
    // const collidedItem = worldItems.find(item => _boxContains(targetBox, item.position));
    if (collidedVirtualMap) {
      // data layer
      collidedVirtualMap.remove();
      
      /* // render layer
      inventory.appendChild(collidedItem);
      collidedItem.style.left = null;
      collidedItem.style.top = null; */
    } else {
      console.log('got player apps', realms.localPlayer.playerApps.getSize());
      if (realms.localPlayer.playerApps.getSize() > 0) {
        const firstApp = appsArray.getIndex(0, {
          listen: false,
        });

        const targetRealm = realms.getClosestRealm(targetPosition);
        if (targetRealm) {
          const worldApps = targetRealm.dataClient.getArray('worldApps', {
            listen: false,
          });
          const firstAppJson = firstApp.toObject();
          const {
            update,
            // map,
          } = worldApps.addAt(firstApp.arrayIndexId, firstAppJson, {
            listen: false,
          });
          targetRealm.emitUpdate(update);
        } else {
          console.warn('no containing realm to drop to');
        }
        
        /* // data layer
        const entity = virtualWorld.addEntity({
          name: 'rock',
          position: targetPosition.slice(),
        });
        console.log('added rock', entity);

        // render layer
        const item = inventoryItems.pop();
        item.position = targetPosition.slice();
        item.style.left = `${targetPosition[0]}px`;
        item.style.top = `${targetPosition[2]}px`;
        item.arrayIndexId = entity.arrayIndexId;
        world.appendChild(item); */
      } else {
        console.warn('nothing to drop');
        debugger;
      }
    }
  };
  
  // realms
  const realms = new NetworkRealms(playerId);
  const realmCleanupFns = new Map();
  realms.addEventListener('realmconnecting', e => {
    const {realm} = e.data;
    const el = realmsCanvases.elements.find(el => {
      return el.min[0] === realm.min[0] && el.min[2] === realm.min[2];
    });
    if (el) {
      el.classList.add('connecting');
    }
  });
  const getRealmElement = realm => realmsCanvases.elements.find(el => {
    return el.min[0] === realm.min[0] && el.min[2] === realm.min[2];
  });
  realms.addEventListener('realmjoin', e => {
    const {realm} = e.data;
    const el = getRealmElement(realm);
    if (el) {
      el.classList.add('connected');
      el.classList.remove('connecting');

      const {dataClient} = realm;

      el.updateText(dataClient);

      const playersArray = dataClient.getArray('players');
      const worldApps = dataClient.getArray('worldApps');
      
      const onadd = e => {
        // console.log('game players array add', realm.key, e.data, playersArray.toArray());
        const {map: playerMap} = e.data;

        playerMap.listen();
        playerMap.addEventListener('update', e => {
          // console.log('player map update', e.data);

          el.updateText(dataClient);
        });

        el.updateText(dataClient);
      };
      playersArray.addEventListener('add', onadd);

      // console.log('game players array listen on realm', realm.key);
      const onremove = e => {
        // console.log('game players array remove', realm.key, e.data, playersArray.toArray());
        const {map: playerMap} = e.data;

        el.updateText(dataClient);
      };
      playersArray.addEventListener('remove', onremove);
  
      realmCleanupFns.set(realm, () => {
        dataClient.removeEventListener('add', onadd);
        dataClient.removeEventListener('remove', onremove);

        playersArray.unlisten();
        worldApps.unlisten();

        // console.log('game players array cancel on realm', realm.key);
      });
    }
  });
  realms.addEventListener('realmleave', e => {
    const {realm} = e.data;
    const el = realmsCanvases.elements.find(el => {
      return el.min[0] === realm.min[0] && el.min[2] === realm.min[2];
    });
    if (el) {
      el.classList.remove('connected');
      el.classList.remove('connecting');

      realmCleanupFns.get(realm)();
      realmCleanupFns.delete(realm);
    }
  });
  // realms canvas
  const realmsCanvases = new GameRealmsCanvases();
  for (const el of realmsCanvases.elements) {
    document.body.appendChild(el);
  }

  // local objects
  const virtualWorld = realms.getVirtualWorld();
  const virtualPlayers = realms.getVirtualPlayers();

  const _initUi = () => {
    // focus tracking
    localPlayerCanvas.canvas.focus();
    document.body.addEventListener("click", event => {
      localPlayerCanvas.canvas.focus();
    });
  };
  _initUi();

  const _initLogic = () => {
    // world
    const worldItemRenderers = [];
    virtualWorld.addEventListener('entityadd', e => {
      console.log('add virtual world app', e.data);
      const {realm} = e.data;
      const {dataClient} = realm;
      
      const el = getRealmElement(realm);
      if (el) {
        el.updateText(dataClient);
      }
    });
    virtualWorld.addEventListener('entityremove', e => {
      // console.log('remove virtual world app', e.data);
      const {realm} = e.data;
      const {dataClient} = realm;
      
      const el = getRealmElement(realm);
      if (el) {
        el.updateText(dataClient);
      }
    });

    // players
    const playerCursorRenderers = [];
    // console.log('listen to players', virtualPlayers);
    virtualPlayers.addEventListener('join', e => {
      console.log('add virtual player', e.data);
      const {player} = e.data;

      // bind
      player.addEventListener('entityadd', e => {
        console.log('add virtual player app', e.data);
      });
      player.addEventListener('entityremove', e => {
        console.log('remove virtual player app', e.data);
      });

      // render
      let p = document.createElement("p");
      p.classList.add('player');
      p.innerHTML = `<img src="/public/images/audio.svg" class="audio-icon"><span class="name">${e.data.playerId}</span>`;
      roster.appendChild(p);

      const playerCursorRenderer = new RemotePlayerCursorHtmlRenderer(e.data.playerId, playerId, player);
      playerCursorRenderers.push(playerCursorRenderer);
    });
    virtualPlayers.addEventListener('leave', e => {
      console.log('remove virtual player', e.data);
      const {playerId} = e.data;

      for (let i = 0; i < roster.children.length; i++) {
        let p = roster.children[i];
        if (p.innerText === playerId) {
          roster.removeChild(p);
          break;
        }
      }

      for (let i = 0; i < playerCursorRenderers.length; i++) {
        const playerCursorRenderer = playerCursorRenderers[i];
        if (playerCursorRenderer.remotePlayerId === playerId) {
          playerCursorRenderers.splice(i, 1);
          playerCursorRenderer.destroy();
          break;
        }
      }
    });
    
    // audio
    const _enableAudioOutput = playerId => {
      for (let i = 0; i < roster.children.length; i++) {
        let p = roster.children[i];
        const textNode = p.children[1];
        if (textNode.innerText === playerId) {
          // console.log('swap on');
          p.classList.add('speaking');
          break;
        }
      }
    };
    const _disableAudioOutput = playerId => {
      for (let i = 0; i < roster.children.length; i++) {
        let p = roster.children[i];
        const textNode = p.children[1];
        if (textNode.innerText === playerId) {
          // console.log('swap off');
          p.classList.remove('speaking');
          break;
        }
      }
    };
    realms.addEventListener('audiostreamstart', e => {
      const {playerId} = e.data;
      // console.log('stream start', playerId);
      _enableAudioOutput(playerId);
    });
    realms.addEventListener('audiostreamend', e => {
      const {playerId} = e.data;
      // console.log('stream end', playerId);
      _disableAudioOutput(playerId);
    });

    // wait for the network to be ready befor binding controls
    realms.addEventListener('networkreconfigure', e => {
      const _bindControls = () => {
        const mousemove = e => {
          realms.localPlayer.setKeyValue('cursorPosition', Float32Array.from([e.clientX, e.clientY, 0]));
        };
        window.addEventListener('mousemove', mousemove);
      };
      _bindControls();
    }, {once: true});
  };
  _initLogic();

  const _startFrameLoop = () => {
    let frame;
    const _recurse = () => {
      frame = requestAnimationFrame(_recurse);
      localPlayerCanvas.move();
      localPlayerCanvas.draw();
      localPlayerCanvas.canvas.style.left = localPlayerCanvas.position[0] + 'px';
      localPlayerCanvas.canvas.style.top = localPlayerCanvas.position[2] + 'px';

      realms.updatePosition(localPlayerCanvas.position, realmSize);
    };
    _recurse();
  };
  _startFrameLoop();

  return realms;
};