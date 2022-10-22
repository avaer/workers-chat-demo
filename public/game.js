// import {ensureAudioContext} from './wsrtc/ws-audio-context.js';
import {makeId} from './util.mjs';

import {RemotePlayerHtmlRenderer, LocalPlayerHtmlRenderer} from "./renderers/html-renderer.js";
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

const realmSize = 200;
// const realmsSize = realmSize * 3;
const _drawRectangle = (ctx, color) => {
  const innerBorder = 3;
  const borderWidth = 3;
  ctx.fillStyle = color;
  ctx.fillRect(innerBorder, innerBorder, realmSize - innerBorder * 2, borderWidth); // top
  ctx.fillRect(innerBorder, realmSize - borderWidth - innerBorder, realmSize - innerBorder * 2, borderWidth); // bottom
  ctx.fillRect(innerBorder, innerBorder, borderWidth, realmSize - innerBorder * 2); // left
  ctx.fillRect(realmSize - borderWidth - innerBorder, innerBorder, borderWidth, realmSize - innerBorder * 2); // right
};
class GameRealmsCanvases {
  constructor() {
    this.canvases = [];
    for (let dx = -1; dx <= 1; dx++) {
      for (let dz = -1; dz <= 1; dz++) {
        const canvas = document.createElement('canvas');
        canvas.className = 'network-realm';
        canvas.width = realmSize;
        canvas.height = realmSize;
        const x = dx + 1;
        const z = dz + 1;
        canvas.style.cssText = `\
position: fixed;
left: ${realmSize * x}px;
top: ${realmSize * z}px;
z-index: 1;
        `
        const ctx = canvas.getContext('2d');
        _drawRectangle(ctx, '#CCC');

        canvas.min = [x * realmSize, 0, z * realmSize];
        canvas.size = realmSize;
        canvas.setColor = color => {
          _drawRectangle(ctx, color);
        };
        
        this.canvases.push(canvas);
      }
    }
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
    console.log('character focus 1');
    localPlayerFocused = true;
  });
  localPlayerCanvas.canvas.addEventListener('blur', e => {
    console.log('character blur 1');
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
    
    const inventory = document.querySelector('#inventory');
    const inventoryItems = Array.from(inventory.querySelectorAll('.realms-item'));
    const world = document.querySelector('#world');
    const worldItems = Array.from(world.querySelectorAll('.realms-item'));
    const collidedItem = worldItems.find(item => _boxContains(targetBox, item.position));
    if (collidedItem) {
      inventory.appendChild(collidedItem);
      collidedItem.style.left = null;
      collidedItem.style.top = null;
    } else {
      if (inventoryItems.length > 0) {
        const item = inventoryItems.pop();
        item.position = targetPosition.slice();
        item.style.left = `${targetPosition[0]}px`;
        item.style.top = `${targetPosition[2]}px`;
        world.appendChild(item);

        const entity = virtualWorld.addEntity({
          name: 'rock',
          position: targetPosition.slice(),
        });
        console.log('add rock', entity);
      }
    }
  };
  
  // realms
  const realms = new NetworkRealms(playerId);
  realms.addEventListener('realmconnecting', e => {
    const {realm} = e.data;
    const canvas = realmsCanvases.canvases.find(canvas => {
      return canvas.min[0] === realm.min[0] && canvas.min[2] === realm.min[2];
    });
    if (canvas) {
      canvas.classList.add('connecting');
    }
  });
  realms.addEventListener('realmjoin', e => {
    const {realm} = e.data;
    const canvas = realmsCanvases.canvases.find(canvas => {
      return canvas.min[0] === realm.min[0] && canvas.min[2] === realm.min[2];
    });
    if (canvas) {
      canvas.classList.add('connected');
      canvas.classList.remove('connecting');
    }
    // console.log('join canvas', canvas);
  });
  realms.addEventListener('realmleave', e => {
    const {realm} = e.data;
    const canvas = realmsCanvases.canvases.find(canvas => {
      return canvas.min[0] === realm.min[0] && canvas.min[2] === realm.min[2];
    });
    if (canvas) {
      canvas.classList.remove('connected');
      canvas.classList.remove('connecting');
    }
    // console.log('leave canvas', canvas);
  });
  // realms canvas
  const realmsCanvases = new GameRealmsCanvases(realmSize);
  for (const canvas of realmsCanvases.canvases) {
    document.body.appendChild(canvas);
  }

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
    const virtualWorld = realms.getVirtualWorld();
    virtualWorld.addEventListener('entityadd', e => {
      console.log('add virtual world app', e.data);
    });
    virtualWorld.addEventListener('entityremove', e => {
      console.log('remove virtual world app', e.data);
    });

    // players
    const playerRenderers = [];
    const virtualPlayers = realms.getVirtualPlayers();
    virtualPlayers.addEventListener('playeradd', e => {
      console.log('add virtual player', e.data);
      const player = e.data;

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

      const playerRenderer = new RemotePlayerHtmlRenderer(e.data.playerId, playerId, dc);
      playerRenderers.push(playerRenderer);
    });
    virtualPlayers.addEventListener('playerremove', e => {
      console.log('remove virtual player', e.data);
      const {playerId} = e.data;

      for (let i = 0; i < roster.children.length; i++) {
        let p = roster.children[i];
        if (p.innerText === playerId) {
          roster.removeChild(p);
          break;
        }
      }

      for (let i = 0; i < playerRenderers.length; i++) {
        const playerRenderer = playerRenderers[i];
        if (playerRenderer.remotePlayerId === playerId) {
          playerRenderers.splice(i, 1);
          playerRenderer.destroy();
          break;
        }
      }
    });

    // chat
    realms.addEventListener('chat', e => {
      const {playerId, message} = e.data;
      addChatMessage(playerId, message);
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

    // local player renderer
    const localPlayerRenderer = new LocalPlayerHtmlRenderer(realms);
    // ws.addEventListener('close', e => {
    //   localPlayerRenderer.destroy();
    // });

    realms.addEventListener('networkreconfigure', e => {
      const mousemove = e => {
        realms.localPlayer.setKeyValue('position', Float32Array.from([e.clientX, e.clientY, 0]));
      };
      window.addEventListener('mousemove', mousemove);
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