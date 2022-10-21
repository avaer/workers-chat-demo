import {ensureAudioContext} from './wsrtc/ws-audio-context.js';

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
    
    // this.direction[0] = 0;
    // this.direction[1] = 0;
    // this.direction[2] = 0;
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
  
  // realms
  const realms = new NetworkRealms();
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

  // focus tracking
  localPlayerCanvas.canvas.focus();
  document.body.addEventListener("click", event => {
    localPlayerCanvas.canvas.focus();
  });
  
  // start frame loop
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