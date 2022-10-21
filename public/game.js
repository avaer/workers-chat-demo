import {ensureAudioContext} from './wsrtc/ws-audio-context.js';

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
    this.direction = [0, 0];
  }
  move() {
    const speed = 3;
    this.position[0] += this.direction[0] * speed;
    this.position[2] += this.direction[1] * speed;
  }
  draw() {
    let row;
    if (this.direction[0] === -1) {
      row = 1;
    } else if (this.direction[0] === 1) {
      row = 2;
    } else if (this.direction[1] === -1) {
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
export const startGame = async () => {
  const localPlayerCanvas = await GamePlayerCanvas.loadFromUrl('/public/images/fire-mage.png');
  localPlayerCanvas.canvas.style.cssText = `\
position: fixed;
outline: none;
z-index: 1;
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
          localPlayerCanvas.direction[1] = -1;
          break;
        }
        case 'KeyA': {
          localPlayerCanvas.direction[0] = -1;
          break;
        }
        case 'KeyS': {
          localPlayerCanvas.direction[1] = 1;
          break;
        }
        case 'KeyD': {
          localPlayerCanvas.direction[0] = 1;
          break;
        }
      }
    }
  });
  window.addEventListener('keyup', e => {
    switch (e.code) {
      case 'KeyW': {
        localPlayerCanvas.direction[1] = 0;
        break;
      }
      case 'KeyA': {
        localPlayerCanvas.direction[0] = 0;
        break;
      }
      case 'KeyS': {
        localPlayerCanvas.direction[1] = 0;
        break;
      }
      case 'KeyD': {
        localPlayerCanvas.direction[0] = 0;
        break;
      }
    }
  });
  localPlayerCanvas.canvas.tabIndex = -1;
  document.body.appendChild(localPlayerCanvas.canvas);
  
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
  };
  _recurse();
};