import {makeId} from './util.mjs';
import {frameSize, realmSize} from './constants.js';

import {RemotePlayerCursorHtmlRenderer, GameRealmsCanvases, GamePlayerCanvas, LocalPlayerHtmlRenderer, WorldItemHtmlRenderer} from "./renderers/html-renderer.js";
import {NetworkRealms} from "./network-realms.js";

//

// XXX wait for sync before we finally disconnect, or else the message might not have been sent befor we disconnect
// XXX render app icons on top of the player
// XXX add multi-deadhand/livehand support to server

//

export const startGame = async () => {
  const playerId = makeId();
  let localPlayerCanvas = null;
  
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

  const onentityadd2 = e => {
    // const {entity} = e.data;
    console.log('world app entity add', e.data);
  };
  realms.getVirtualWorld().addEventListener('entityadd', onentityadd2);
  const onentityremove2 = e => {
    // const {entity} = e.data;
    console.log('world app entity remove', e.data);
  };
  realms.getVirtualWorld().addEventListener('entityremove', onentityremove2);

  realms.addEventListener('realmjoin', e => {
    const {realm} = e.data;
    const el = getRealmElement(realm);
    if (el) {
      el.classList.add('connected');
      el.classList.remove('connecting');

      const {dataClient} = realm;

      el.updateText(dataClient);

      const localPlayerApps = realms.localPlayer.playerApps;
      const localPlayerActions = realms.localPlayer.playerActions;
      const playersArray = dataClient.getArray('players');
      // const worldApps = dataClient.getArray('worldApps');

      const onentityadd = e => {
        // const {entity} = e.data;
        el.updateText(dataClient);
      };
      localPlayerApps.addEventListener('entityadd', onentityadd);

      const onentityremove = e => {
        // const {entity} = e.data;
        console.log('got entity remove', e.data);
        el.updateText(dataClient);
      };
      localPlayerApps.addEventListener('entityremove', onentityremove);
      
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

      const onentityadd2 = e => {
        // const {entity} = e.data;
        el.updateText(dataClient);
      };
      virtualWorld.addEventListener('needledentityadd', onentityadd2);

      const onentityremove2 = e => {
        // const {entity} = e.data;
        el.updateText(dataClient);
      };
      virtualWorld.addEventListener('needledentityremove', onentityremove2);
  
      realmCleanupFns.set(realm, () => {
        localPlayerApps.removeEventListener('needledentityadd', onentityadd);
        localPlayerActions.removeEventListener('needledentityadd', onentityadd);
        dataClient.removeEventListener('add', onadd);
        dataClient.removeEventListener('remove', onremove);
        virtualWorld.removeEventListener('needledentityadd', onentityadd2);
        virtualWorld.removeEventListener('needledentityremove', onentityremove2);

        playersArray.unlisten();

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
  const realmsCanvases = new GameRealmsCanvases(realms);
  for (const el of realmsCanvases.elements) {
    document.body.appendChild(el);
  }

  // local objects
  const virtualWorld = realms.getVirtualWorld();
  const virtualPlayers = realms.getVirtualPlayers();

  const _initLogic = () => {
    // world
    const worldItemRenderers = [];
    // bind
    virtualWorld.addEventListener('entityadd', e => {
      // console.log('add virtual world app', e.data);
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

    // local player
    const localPlayerCursorRenderer = new RemotePlayerCursorHtmlRenderer(realms.playerId, realms.playerId, realms.localPlayer);

    // players
    const playerCursorRenderers = [];
    // console.log('listen to players', virtualPlayers);
    virtualPlayers.addEventListener('join', e => {
      // console.log('add virtual player', e.data);
      const {player} = e.data;

      /* // bind
      player.addEventListener('entityadd', e => {
        console.log('add virtual player app', e.data);
      });
      player.addEventListener('entityremove', e => {
        console.log('remove virtual player app', e.data);
      }); */

      // ui
      let p = document.createElement("p");
      p.classList.add('player');
      p.innerHTML = `<img src="/public/images/audio.svg" class="audio-icon"><span class="name">${e.data.playerId}</span>`;
      roster.appendChild(p);

      // render
      const playerCursorRenderer = new RemotePlayerCursorHtmlRenderer(e.data.playerId, playerId, player);
      playerCursorRenderers.push(playerCursorRenderer);
    });
    virtualPlayers.addEventListener('leave', e => {
      // console.log('remove virtual player', e.data);
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

  const _initRenderers = () => {
    // XXX this does not need to be async
    localPlayerCanvas = new GamePlayerCanvas(realms.localPlayer);
    (async () => {
      const spriteImg = await GamePlayerCanvas.loadFromUrl('/public/images/fire-mage.png');
      localPlayerCanvas.setSprite(spriteImg);
    })();
    // console.log('got canvas', localPlayerCanvas);
    localPlayerCanvas.element.style.cssText = `\
position: fixed;
outline: none;
z-index: 2;
    `;
    localPlayerCanvas.element.classList.add('player-sprite');
    let localPlayerFocused = false;
    localPlayerCanvas.element.addEventListener('focus', e => {
      // console.log('character focus 1');
      localPlayerFocused = true;
    });
    localPlayerCanvas.element.addEventListener('blur', e => {
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
    localPlayerCanvas.element.tabIndex = -1;
    document.body.appendChild(localPlayerCanvas.element);
    localPlayerCanvas.element.focus();
    document.body.addEventListener('click', e => {
      localPlayerCanvas.element.focus();
    });

    // action methods
    const _pickupDrop = () => {
      console.log('drop 1');
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
        if (!position) {
          debugger;
        }
        return position[0] >= box.min[0] && position[0] <= box.max[0] &&
          position[1] >= box.min[1] && position[1] <= box.max[1] &&
          position[2] >= box.min[2] && position[2] <= box.max[2];
      };
      
      const collidedVirtualMap = Array.from(virtualWorld.entityTracker.virtualMaps.values()).find(virtualMap => {
        const position = virtualMap.get('position');
        return !!position && _boxContains(targetBox, position);
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
        // console.log('got player apps', realms.localPlayer.playerApps.getSize());
        if (realms.localPlayer.playerApps.getSize() > 0) {
          const targetRealm = realms.getClosestRealm(targetPosition);
          if (targetRealm) {
            console.log('drop to target realm', targetRealm.key, targetRealm);

            // the app we will be dropping
            // const firstApp = realms.localPlayer.playerApps.first();
            const actions = realms.localPlayer.playerActions.toArray();
            const wearActionIndex = actions.findIndex(action => action.action === 'wear');
            // if (wearActionIndex === -1) {
            //   debugger;
            // }
            const firstAction = realms.localPlayer.playerActions.getVirtualMapAt(wearActionIndex);
            debugger;
            // if (!firstAction) {
            //   debugger;
            // }
            const firstApp = realms.localPlayer.playerApps.getVirtualMapAt(wearActionIndex);
            // if (!firstApp) {
            //   debugger;
            // }
            
            // set dead hands
            // old location: player
            // the player already has deadhand on all of its apps, probably?
            // const deadHandUpdate = firstApp.headRealm.dataClient.deadHandArrayMap(
            //   realms.localPlayer.playerApps.arrayId,
            //   [firstApp.arrayIndexId],
            //   realms.playerId,
            // );
            // firstApp.headRealm.emitUpdate(deadHandUpdate);
            // new location: world
            const deadHandUpdate = targetRealm.dataClient.deadHandArrayMap(
              'worldApps',
              [firstApp.arrayIndexId],
              realms.playerId,
            );
            targetRealm.emitUpdate(deadHandUpdate);

            // add at the new location (world)
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

            // remove from the old location (player)
            firstApp.remove();
            firstAction.remove();

            const liveHandUpdate = targetRealm.dataClient.liveHandArrayMap(
              'worldApps',
              [firstApp.arrayIndexId],
              realms.playerId,
            );
            targetRealm.emitUpdate(liveHandUpdate);
          } else {
            console.warn('no containing realm to drop to');
          }
        } else {
          console.warn('nothing to drop');
          debugger;
        }
      }
      console.log('drop 2');
    };
  };
  _initRenderers();

  const _startFrameLoop = () => {
    let frame;
    const _recurse = () => {
      frame = requestAnimationFrame(_recurse);

      if (localPlayerCanvas) {
        localPlayerCanvas.move();
        localPlayerCanvas.draw();
        localPlayerCanvas.element.style.left = localPlayerCanvas.position[0] + 'px';
        localPlayerCanvas.element.style.top = localPlayerCanvas.position[2] + 'px';

        realms.updatePosition(localPlayerCanvas.position, realmSize);
      }
    };
    _recurse();
  };
  _startFrameLoop();

  return realms;
};